"""TDD unit and integration tests for _bmad/scripts/git_flow.py."""

from __future__ import annotations

import importlib.util
import subprocess
from collections.abc import Callable
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[3] / "_bmad" / "scripts" / "git_flow.py"


def load_git_flow() -> ModuleType:
    """Dynamically load _bmad/scripts/git_flow.py."""
    assert SCRIPT_PATH.exists(), f"Missing git_flow script at {SCRIPT_PATH}"
    spec = importlib.util.spec_from_file_location("git_flow", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )


@pytest.fixture()
def git_repo(tmp_path: Path) -> Path:
    """Create a real local Git repository on `main` with a configured `origin` remote."""
    repo = tmp_path / "repo"
    _git(tmp_path, "init", "-b", "main", str(repo))
    _git(repo, "config", "user.name", "Dev Bot")
    _git(repo, "config", "user.email", "dev@example.com")
    _git(repo, "remote", "add", "origin", "https://example.invalid/parlaypal.git")
    (repo / "README.md").write_text("# ParlayPal\n", encoding="utf-8")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-m", "chore: initial main commit")
    return repo


def _intercept_remote_calls(
    git_flow: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> list[tuple[str, ...]]:
    """Run real local Git commands while recording and stubbing network transport calls."""
    remote_calls: list[tuple[str, ...]] = []
    real_run_git: Callable[..., subprocess.CompletedProcess[str]] = git_flow.run_git

    def wrapped_run_git(
        *args: str,
        cwd: Path | None = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        if args and args[0] in {"pull", "push", "fetch"}:
            remote_calls.append(tuple(args))
            return subprocess.CompletedProcess(
                args=["git", *args],
                returncode=0,
                stdout="",
                stderr="",
            )
        return real_run_git(*args, cwd=cwd, check=check)

    monkeypatch.setattr(git_flow, "run_git", wrapped_run_git)
    return remote_calls


@pytest.mark.parametrize(
    "branch",
    [
        "feat/5-1-schedule-poller",
        "fix/redis-ttl-bug",
        "chore/sdlc-git-flow-script",
        "docs/update-agents",
        "refactor/devig-solver",
        "test/worker-matrix",
    ],
)
def test_validate_branch_name_accepts_valid_prefixes(branch: str) -> None:
    git_flow = load_git_flow()
    assert git_flow.validate_branch_name(branch) == branch


@pytest.mark.parametrize(
    "branch",
    [
        "main",
        "master",
        "HEAD",
        "",
        "feature-without-slash",
        "feat/",
        "feat/has space",
        "feat/bad..dots",
        "feat/trailing/",
        "feat/bad.lock",
        "unknown/prefix",
    ],
)
def test_validate_branch_name_rejects_invalid_names(branch: str) -> None:
    git_flow = load_git_flow()
    with pytest.raises(ValueError):
        git_flow.validate_branch_name(branch)


def test_ship_refuses_direct_commit_on_main(
    git_repo: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    git_flow = load_git_flow()
    remote_calls = _intercept_remote_calls(git_flow, monkeypatch)
    monkeypatch.chdir(git_repo)

    before_sha = _git(git_repo, "rev-parse", "HEAD").stdout.strip()
    (git_repo / "README.md").write_text("# Edited on main\n", encoding="utf-8")

    exit_code = git_flow.main(["ship", "-m", "bad commit", "--all"])
    captured = capsys.readouterr()

    assert exit_code == 2
    assert "main" in captured.err.lower()
    assert _git(git_repo, "rev-parse", "HEAD").stdout.strip() == before_sha
    assert remote_calls == []


def test_start_switches_to_main_pulls_creates_branch_and_preserves_dirty_files(
    git_repo: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    git_flow = load_git_flow()
    remote_calls = _intercept_remote_calls(git_flow, monkeypatch)

    _git(git_repo, "checkout", "-b", "feat/old-branch")
    (git_repo / "README.md").write_text("# ParlayPal\nlocal edit\n", encoding="utf-8")
    (git_repo / "new_script.py").write_text("print('hello')\n", encoding="utf-8")

    monkeypatch.chdir(git_repo)
    exit_code = git_flow.main(["start", "chore/sdlc-git-flow-script"])

    assert exit_code == 0
    current_branch = _git(git_repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    assert current_branch == "chore/sdlc-git-flow-script"
    assert ("pull", "--ff-only", "origin", "main") in remote_calls
    assert "local edit" in (git_repo / "README.md").read_text(encoding="utf-8")
    assert (git_repo / "new_script.py").read_text(encoding="utf-8") == "print('hello')\n"
    assert _git(git_repo, "stash", "list").stdout.strip() == ""


def test_start_auto_stashes_tracked_edits_when_checkout_conflicts(
    git_repo: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    git_flow = load_git_flow()
    remote_calls = _intercept_remote_calls(git_flow, monkeypatch)

    notes = git_repo / "notes.txt"
    notes.write_text("header\n\nline3\n\nfooter\n", encoding="utf-8")
    _git(git_repo, "add", "notes.txt")
    _git(git_repo, "commit", "-m", "docs: add notes on main")

    # Branch commit modifies line 1 so `git checkout main` rejects dirty tracked edits.
    _git(git_repo, "checkout", "-b", "feat/conflicting")
    notes.write_text("branch_header\n\nline3\n\nfooter\n", encoding="utf-8")
    _git(git_repo, "add", "notes.txt")
    _git(git_repo, "commit", "-m", "docs: update header on branch")

    # Uncommitted edit modifies a non-overlapping line plus an untracked file.
    notes.write_text("branch_header\n\nline3\n\nedited_footer\n", encoding="utf-8")
    (git_repo / "untracked_helper.py").write_text("ok = True\n", encoding="utf-8")

    monkeypatch.chdir(git_repo)
    exit_code = git_flow.main(["start", "chore/fallback-stash"])

    assert exit_code == 0
    current_branch = _git(git_repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    assert current_branch == "chore/fallback-stash"
    assert ("pull", "--ff-only", "origin", "main") in remote_calls
    assert notes.read_text(encoding="utf-8") == "header\n\nline3\n\nedited_footer\n"
    assert (git_repo / "untracked_helper.py").read_text(encoding="utf-8") == "ok = True\n"
    assert _git(git_repo, "stash", "list").stdout.strip() == ""


def test_start_rejects_existing_branch_without_losing_dirty_files(
    git_repo: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    git_flow = load_git_flow()
    remote_calls = _intercept_remote_calls(git_flow, monkeypatch)

    _git(git_repo, "checkout", "-b", "chore/existing")
    _git(git_repo, "checkout", "main")
    (git_repo / "keep.txt").write_text("important\n", encoding="utf-8")

    monkeypatch.chdir(git_repo)
    exit_code = git_flow.main(["start", "chore/existing"])

    assert exit_code == 2
    assert _git(git_repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip() == "main"
    assert (git_repo / "keep.txt").read_text(encoding="utf-8") == "important\n"
    assert remote_calls == []


def test_ship_stages_only_selected_files_commits_and_pushes(
    git_repo: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    git_flow = load_git_flow()
    remote_calls = _intercept_remote_calls(git_flow, monkeypatch)

    _git(git_repo, "checkout", "-b", "feat/1-1-test")
    (git_repo / "wanted.py").write_text("x = 1\n", encoding="utf-8")
    (git_repo / "unwanted.py").write_text("y = 2\n", encoding="utf-8")

    monkeypatch.chdir(git_repo)
    exit_code = git_flow.main(["ship", "-m", "feat: add wanted", "--files", "wanted.py"])

    assert exit_code == 0
    committed_files = _git(
        git_repo, "show", "--name-only", "--pretty=format:", "HEAD"
    ).stdout.splitlines()
    assert "wanted.py" in committed_files
    assert "unwanted.py" not in committed_files
    assert ("push", "-u", "origin", "HEAD") in remote_calls
    assert (git_repo / "unwanted.py").exists()


def test_ship_all_with_no_push_commits_locally_only(
    git_repo: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    git_flow = load_git_flow()
    remote_calls = _intercept_remote_calls(git_flow, monkeypatch)

    _git(git_repo, "checkout", "-b", "fix/local-only")
    (git_repo / "patch.py").write_text("fixed = True\n", encoding="utf-8")

    monkeypatch.chdir(git_repo)
    exit_code = git_flow.main(["ship", "-m", "fix: local patch", "--all", "--no-push"])

    assert exit_code == 0
    committed_files = _git(
        git_repo, "show", "--name-only", "--pretty=format:", "HEAD"
    ).stdout.splitlines()
    assert "patch.py" in committed_files
    assert remote_calls == []


def test_sync_updates_main_from_origin_and_refuses_dirty_tree(
    git_repo: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    git_flow = load_git_flow()
    remote_calls = _intercept_remote_calls(git_flow, monkeypatch)
    monkeypatch.chdir(git_repo)

    _git(git_repo, "checkout", "-b", "feat/done")
    dirty_file = git_repo / "scratch.txt"
    dirty_file.write_text("dirty\n", encoding="utf-8")

    assert git_flow.main(["sync"]) == 2
    assert _git(git_repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip() == "feat/done"
    assert remote_calls == []

    dirty_file.unlink()

    assert git_flow.main(["sync"]) == 0
    assert _git(git_repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip() == "main"
    assert ("pull", "--ff-only", "origin", "main") in remote_calls
    assert ("fetch", "--prune", "origin") in remote_calls


def test_install_aliases_configures_local_git_aliases(
    git_repo: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    git_flow = load_git_flow()
    _intercept_remote_calls(git_flow, monkeypatch)
    monkeypatch.chdir(git_repo)

    exit_code = git_flow.main(["install-aliases"])

    assert exit_code == 0
    assert (
        _git(git_repo, "config", "--local", "--get", "alias.start-feat").stdout.strip()
        == "!python _bmad/scripts/git_flow.py start"
    )
    assert (
        _git(git_repo, "config", "--local", "--get", "alias.ship").stdout.strip()
        == "!python _bmad/scripts/git_flow.py ship"
    )
    assert (
        _git(git_repo, "config", "--local", "--get", "alias.sync-main").stdout.strip()
        == "!python _bmad/scripts/git_flow.py sync"
    )
