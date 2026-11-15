#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
"""Deterministic per-feature Git workflow helper for ParlayPal.

Eliminates multi-step LLM Git ceremony and enables Antigravity prefix auto-approval
by encapsulating branch creation, staging/committing/pushing, and main syncing behind
single, unchained CLI commands.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True

ALLOWED_BRANCH_PREFIXES = ("feat", "fix", "chore", "docs", "refactor", "test")
PROTECTED_BRANCHES = frozenset({"main", "master", "HEAD"})
BRANCH_NAME_RE = re.compile(
    rf"^({'|'.join(ALLOWED_BRANCH_PREFIXES)})/[A-Za-z0-9][A-Za-z0-9._/-]*$"
)
LOCAL_ALIASES: tuple[tuple[str, str], ...] = (
    ("start-feat", "!python _bmad/scripts/git_flow.py start"),
    ("ship", "!python _bmad/scripts/git_flow.py ship"),
    ("sync-main", "!python _bmad/scripts/git_flow.py sync"),
)


def _configure_utf8_stdio() -> None:
    """Ensure UTF-8 output streams on Windows."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")


def run_git(
    *args: str,
    cwd: Path | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Execute a git subcommand and capture text output."""
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=check,
    )


def _format_git_error(exc: subprocess.CalledProcessError) -> str:
    stderr = (exc.stderr or "").strip()
    stdout = (exc.stdout or "").strip()
    return stderr or stdout or str(exc)


def resolve_repo_root(start_dir: Path | None = None) -> Path:
    """Resolve the top-level Git repository root from start_dir (or cwd)."""
    target = start_dir or Path.cwd()
    result = run_git("rev-parse", "--show-toplevel", cwd=target)
    return Path(result.stdout.strip())


def get_current_branch(repo_root: Path) -> str:
    """Return the active branch name, or 'HEAD' when detached."""
    return run_git("rev-parse", "--abbrev-ref", "HEAD", cwd=repo_root).stdout.strip()


def has_origin_remote(repo_root: Path) -> bool:
    """Return True if an 'origin' remote is configured in this repository."""
    remotes = run_git("remote", cwd=repo_root).stdout.splitlines()
    return "origin" in remotes


def is_dirty(repo_root: Path) -> bool:
    """Return True if tracked or untracked uncommitted changes exist."""
    return bool(run_git("status", "--porcelain", cwd=repo_root).stdout.strip())


def has_tracked_changes(repo_root: Path) -> bool:
    """Return True if staged or unstaged modifications exist on tracked files."""
    status = run_git(
        "status",
        "--porcelain",
        "--untracked-files=no",
        cwd=repo_root,
    ).stdout.strip()
    return bool(status)


def branch_exists(repo_root: Path, branch: str) -> bool:
    """Return True if refs/heads/<branch> exists locally."""
    result = run_git(
        "show-ref",
        "--verify",
        "--quiet",
        f"refs/heads/{branch}",
        cwd=repo_root,
        check=False,
    )
    return result.returncode == 0


def _latest_stash_sha(repo_root: Path) -> str | None:
    result = run_git(
        "rev-parse", "--verify", "--quiet", "refs/stash", cwd=repo_root, check=False
    )
    if result.returncode != 0:
        return None
    sha = result.stdout.strip()
    return sha or None


def validate_branch_name(branch: str) -> str:
    """Validate that branch follows repository conventions and is not protected."""
    if not branch or branch in PROTECTED_BRANCHES:
        raise ValueError(f"Branch name '{branch}' is protected or empty.")
    if (
        ".." in branch
        or "//" in branch
        or branch.endswith(("/", ".lock"))
        or not BRANCH_NAME_RE.match(branch)
    ):
        allowed = ", ".join(f"{prefix}/..." for prefix in ALLOWED_BRANCH_PREFIXES)
        raise ValueError(f"Invalid branch name '{branch}'. Expected one of: {allowed}.")
    return branch


def _checkout_and_pull_base(repo_root: Path, *, base: str, no_pull: bool) -> None:
    run_git("checkout", base, cwd=repo_root)
    if not no_pull and has_origin_remote(repo_root):
        run_git("pull", "--ff-only", "origin", base, cwd=repo_root)


def cmd_start(
    repo_root: Path,
    branch: str,
    *,
    base: str = "main",
    no_pull: bool = False,
) -> int:
    """Switch to latest base branch, create branch, and preserve dirty files."""
    try:
        validate_branch_name(branch)
    except ValueError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 2

    if branch_exists(repo_root, branch):
        sys.stderr.write(f"error: Local branch '{branch}' already exists.\n")
        return 2

    original_branch = get_current_branch(repo_root)
    stashed = False

    try:
        try:
            _checkout_and_pull_base(repo_root, base=base, no_pull=no_pull)
        except subprocess.CalledProcessError:
            if not has_tracked_changes(repo_root):
                raise
            before_stash = _latest_stash_sha(repo_root)
            run_git(
                "stash",
                "push",
                "-m",
                f"git-flow auto-stash before starting {branch}",
                cwd=repo_root,
            )
            after_stash = _latest_stash_sha(repo_root)
            stashed = after_stash is not None and after_stash != before_stash
            _checkout_and_pull_base(repo_root, base=base, no_pull=no_pull)

        run_git("checkout", "-b", branch, cwd=repo_root)
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(
            f"error: failed to start branch '{branch}': {_format_git_error(exc)}\n"
        )
        if original_branch != "HEAD":
            run_git("checkout", original_branch, cwd=repo_root, check=False)
        if stashed:
            run_git("stash", "pop", cwd=repo_root, check=False)
        return 1

    if stashed:
        pop_result = run_git("stash", "pop", cwd=repo_root, check=False)
        if pop_result.returncode != 0:
            detail = (pop_result.stderr or pop_result.stdout or "").strip()
            suffix = f" Details: {detail}" if detail else ""
            sys.stderr.write(
                "error: created branch cleanly, but `git stash pop` hit conflicts. "
                f"Resolve conflicts manually or inspect `git stash list`.{suffix}\n"
            )
            return 1

    sys.stdout.write(f"Started branch '{branch}' from '{base}'.\n")
    return 0


def cmd_ship(
    repo_root: Path,
    message: str,
    *,
    files: list[str] | None = None,
    stage_all: bool = False,
    no_push: bool = False,
) -> int:
    """Stage files, create commit on non-main branch, and push to origin."""
    current_branch = get_current_branch(repo_root)
    if current_branch in PROTECTED_BRANCHES:
        sys.stderr.write(
            f"error: refusing direct commit on protected branch '{current_branch}'. "
            "Run `python _bmad/scripts/git_flow.py start <branch>` first.\n"
        )
        return 2

    try:
        if stage_all:
            run_git("add", "-A", cwd=repo_root)
        elif files:
            run_git("add", "--", *files, cwd=repo_root)

        staged_check = run_git(
            "diff", "--cached", "--quiet", cwd=repo_root, check=False
        )
        if staged_check.returncode == 0:
            sys.stderr.write(
                "error: nothing staged to commit. Pass --files <paths...> or --all.\n"
            )
            return 2

        run_git("commit", "-m", message, cwd=repo_root)
        pushed = False
        if not no_push and has_origin_remote(repo_root):
            run_git("push", "-u", "origin", "HEAD", cwd=repo_root)
            pushed = True
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(f"error: failed to ship changes: {_format_git_error(exc)}\n")
        return 1

    sha = run_git("rev-parse", "--short", "HEAD", cwd=repo_root).stdout.strip()
    target = " and pushed to origin" if pushed else " locally"
    sys.stdout.write(f"Committed {sha} on '{current_branch}'{target}.\n")
    return 0


def cmd_sync(repo_root: Path, *, base: str = "main") -> int:
    """Switch to base branch, fast-forward from origin, and prune stale refs."""
    if is_dirty(repo_root):
        sys.stderr.write(
            "error: working tree has uncommitted changes; commit or stash first.\n"
        )
        return 2

    try:
        run_git("checkout", base, cwd=repo_root)
        if has_origin_remote(repo_root):
            run_git("pull", "--ff-only", "origin", base, cwd=repo_root)
            run_git("fetch", "--prune", "origin", cwd=repo_root)
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(f"error: failed to sync '{base}': {_format_git_error(exc)}\n")
        return 1

    sys.stdout.write(f"Synced '{base}' cleanly.\n")
    return 0


def cmd_install_aliases(repo_root: Path) -> int:
    """Install repo-local Git aliases in .git/config."""
    try:
        for alias_name, target in LOCAL_ALIASES:
            run_git("config", "--local", f"alias.{alias_name}", target, cwd=repo_root)
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(
            f"error: failed to configure aliases: {_format_git_error(exc)}\n"
        )
        return 1

    installed = ", ".join(f"git {name}" for name, _ in LOCAL_ALIASES)
    sys.stdout.write(f"Installed local Git aliases: {installed}.\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI argument parser for git_flow."""
    parser = argparse.ArgumentParser(
        description=(
            "Deterministic ParlayPal Git workflow CLI "
            "(start, ship, sync, install-aliases)."
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    start_parser = subparsers.add_parser(
        "start",
        help="Pull latest base branch and create a new feature/chore branch.",
    )
    start_parser.add_argument(
        "branch", help="Branch name (e.g. feat/5-1-schedule-poller)"
    )
    start_parser.add_argument(
        "--base", default="main", help="Base branch (default: main)"
    )
    start_parser.add_argument(
        "--no-pull",
        action="store_true",
        help="Skip pulling origin/<base> before branching.",
    )

    ship_parser = subparsers.add_parser(
        "ship",
        help="Stage, commit (blocking main/master), and push HEAD to origin.",
    )
    ship_parser.add_argument("-m", "--message", required=True, help="Commit message.")
    stage_group = ship_parser.add_mutually_exclusive_group()
    stage_group.add_argument("--files", nargs="+", help="Specific file paths to stage.")
    stage_group.add_argument(
        "--all", action="store_true", help="Stage all changes (`git add -A`)."
    )
    ship_parser.add_argument(
        "--no-push",
        action="store_true",
        help="Commit locally without pushing to origin.",
    )

    sync_parser = subparsers.add_parser(
        "sync",
        help="Switch to base branch, fast-forward from origin, and prune remote refs.",
    )
    sync_parser.add_argument(
        "--base", default="main", help="Base branch (default: main)"
    )

    subparsers.add_parser(
        "install-aliases",
        help=(
            "Register repo-local Git aliases "
            "(`git start-feat`, `git ship`, `git sync-main`)."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint returning process exit code."""
    _configure_utf8_stdio()
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        repo_root = resolve_repo_root()
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(
            f"error: not inside a Git repository: {_format_git_error(exc)}\n"
        )
        return 1

    if args.command == "start":
        return cmd_start(repo_root, args.branch, base=args.base, no_pull=args.no_pull)
    if args.command == "ship":
        return cmd_ship(
            repo_root,
            args.message,
            files=args.files,
            stage_all=args.all,
            no_push=args.no_push,
        )
    if args.command == "sync":
        return cmd_sync(repo_root, base=args.base)
    if args.command == "install-aliases":
        return cmd_install_aliases(repo_root)

    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
