"""One-off local script: rewrite stored player_props.market_key aliases to canonical keys.

Usage: uv run --directory services/worker python scripts/canonicalize_market_keys.py
"""

from __future__ import annotations

from parlaypal_worker.db import create_session_factory
from parlaypal_worker.market_keys import rewrite_stored_market_keys


def main() -> None:
    with create_session_factory()() as session:
        counts = rewrite_stored_market_keys(session)
        session.commit()
    if not counts:
        print("No aliased market keys found.")
    for old, n in sorted(counts.items()):
        print(f"{old}: {n} rows rewritten")


if __name__ == "__main__":
    main()
