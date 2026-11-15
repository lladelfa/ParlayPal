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
    supported_sports: tuple[str, ...] = SUPPORTED_SPORT_KEYS


@lru_cache(maxsize=1)
def get_settings() -> WorkerSettings:
    """Return cached worker settings instance."""
    return WorkerSettings()
