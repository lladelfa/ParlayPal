"""Typed configuration for the ParlayPal worker service."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]

SUPPORTED_SPORT_KEYS: tuple[str, ...] = (
    "americanfootball_nfl",
    "basketball_nba",
)


class WorkerSettings(BaseSettings):
    """Environment-backed settings for PostgreSQL 16, Redis 7.2, and parlay-api.com."""

    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", SERVICE_ROOT / ".env", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "postgresql+psycopg://parlaypal:parlaypal@localhost:5432/parlaypal"
    redis_url: str = "redis://localhost:6379/0"
    parlay_api_key: str = ""
    parlay_api_base_url: str = "https://api.parlay-api.com/v1"
    hot_cache_ttl_seconds: int = 45
    # Player game-log source (Story 6.5). Disabled unless base URL and path template are set.
    # parlay-api.com has no game-log endpoint, so nothing here points at a real provider.
    game_log_base_url: str = ""
    game_log_path_template: str = ""  # e.g. "/players/{player}/games?sport={sport}&market={market}"
    game_log_api_key: str = ""
    game_log_response_path: str = ""  # dotted path to the list inside the JSON body ("" = root)
    game_log_stat_field: str = ""  # field holding the stat when list items are objects
    game_log_newest_first: bool = True
    game_log_fetch_budget_per_cycle: int = 20
    # Wall-clock cap on provider calls per cycle; keeps the 30s beat (expires=25s) from overlapping.
    game_log_cycle_deadline_seconds: float = 12.0
    game_log_positive_ttl_seconds: int = 6 * 60 * 60
    game_log_negative_ttl_seconds: int = 15 * 60
    supported_sports: tuple[str, ...] = SUPPORTED_SPORT_KEYS


@lru_cache(maxsize=1)
def get_settings() -> WorkerSettings:
    """Return cached worker settings instance."""
    return WorkerSettings()
