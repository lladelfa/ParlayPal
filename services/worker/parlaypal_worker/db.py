"""SQLAlchemy 2.0 engine, session factory, and atomic schema initializer."""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import Engine, create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from parlaypal_worker.config import get_settings
from parlaypal_worker.models import Base

logger = logging.getLogger(__name__)


class DatabaseInitializationError(RuntimeError):
    """Structured error raised when database connection or DDL initialization fails."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "DB_INIT_FAILED",
        retry_after: int = 60,
        cause: Exception | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retry_after = retry_after
        self.cause = cause

    def to_problem_details(self) -> dict[str, dict[str, Any]]:
        """Format error as standardized JSON Problem Details."""
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "retry_after": self.retry_after,
            }
        }


def create_db_engine(database_url: str | None = None, **kwargs: Any) -> Engine:
    """Create a SQLAlchemy 2.0 Engine instance."""
    resolved_url = database_url or get_settings().database_url
    engine_kwargs: dict[str, Any] = {"pool_pre_ping": True, **kwargs}
    return create_engine(resolved_url, **engine_kwargs)


def create_session_factory(engine: Engine | None = None) -> sessionmaker[Session]:
    """Create a configured SQLAlchemy Session factory."""
    target_engine = engine or create_db_engine()
    return sessionmaker(bind=target_engine, autoflush=False, expire_on_commit=False)


def init_db(engine: Engine | None = None, database_url: str | None = None) -> Engine:
    """Idempotently initialize all relational tables and indexes inside a single transaction.

    Raises DatabaseInitializationError and logs the failure without leaving partial uncommitted DDL.
    """
    target_engine: Engine | None = None
    try:
        target_engine = engine or create_db_engine(database_url)
        with target_engine.begin() as connection:
            Base.metadata.create_all(bind=connection, checkfirst=True)
        return target_engine
    except (SQLAlchemyError, OSError) as exc:
        if engine is None and target_engine is not None:
            target_engine.dispose()
        logger.error("Failed to initialize ParlayPal database schema: %s", exc)
        raise DatabaseInitializationError(
            "Database connection or schema initialization failed.",
            code="DB_INIT_FAILED",
            retry_after=60,
            cause=exc,
        ) from exc
