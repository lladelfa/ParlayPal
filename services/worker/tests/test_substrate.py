"""Unit and integration tests for ParlayPal worker database schema and Redis substrate."""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, inspect
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.schema import CreateTable

from parlaypal_worker import celery_app as celery_app_module
from parlaypal_worker.celery_app import health_check, ingest_odds_delta
from parlaypal_worker.db import (
    DatabaseInitializationError,
    create_session_factory,
    init_db,
)
from parlaypal_worker.models import Base, Event, PlayerProp, Team, UserBet
from parlaypal_worker.redis_client import (
    HOT_CACHE_TTL_SECONDS,
    OddsDeltaFrame,
    PropOddsQuote,
    cache_ev_feed,
    cache_sgp_audit,
    ev_feed_key,
    odds_feed_channel,
    odds_latest_key,
    publish_odds_delta,
    sgp_audit_key,
)


class FakeRedisClient:
    """In-memory Redis test double capturing TTL cache writes and Pub/Sub messages."""

    def __init__(self) -> None:
        self.store: dict[str, tuple[str, int | None]] = {}
        self.published: list[tuple[str, str]] = []
        self.closed: bool = False

    def set(self, name: str, value: str, ex: int | None = None) -> bool:
        self.store[name] = (value, ex)
        return True

    def get(self, name: str) -> str | None:
        entry = self.store.get(name)
        return entry[0] if entry else None

    def ttl(self, name: str) -> int | None:
        entry = self.store.get(name)
        return entry[1] if entry else None

    def publish(self, channel: str, message: str) -> int:
        self.published.append((channel, message))
        return 1

    def close(self) -> None:
        self.closed = True


def test_init_db_creates_tables_and_indexes_idempotently() -> None:
    """Verify init_db() idempotently creates all 4 tables and required indexes."""
    engine = init_db(database_url="sqlite:///:memory:")

    # Run a second time against the same engine to verify idempotency
    init_db(engine=engine)

    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    assert {"teams", "events", "player_props", "user_bets"}.issubset(table_names)

    events_indexes = {idx["name"] for idx in inspector.get_indexes("events")}
    props_indexes = {idx["name"] for idx in inspector.get_indexes("player_props")}
    bets_indexes = {idx["name"] for idx in inspector.get_indexes("user_bets")}

    assert "idx_events_sport_commence" in events_indexes
    assert "idx_player_props_event_market" in props_indexes
    assert "idx_user_bets_user_placed" in bets_indexes
    assert "idx_user_bets_event_pending" in bets_indexes
    engine.dispose()


def test_postgresql_ddl_types_and_constraints() -> None:
    """Verify PostgreSQL 16 DDL compilation uses UUID, NUMERIC(8, 4), and TIMESTAMPTZ."""
    pg_dialect = postgresql.dialect()
    compiled_ddl = {
        table_name: str(CreateTable(table).compile(dialect=pg_dialect))
        for table_name, table in Base.metadata.tables.items()
    }

    assert "team_id UUID NOT NULL" in compiled_ddl["teams"]
    assert "TIMESTAMP WITH TIME ZONE" in compiled_ddl["teams"]
    assert "UNIQUE (external_provider_id)" in compiled_ddl["teams"]

    assert "event_id UUID NOT NULL" in compiled_ddl["events"]
    assert "commence_time TIMESTAMP WITH TIME ZONE NOT NULL" in compiled_ddl["events"]

    assert "prop_id UUID NOT NULL" in compiled_ddl["player_props"]
    assert "offered_decimal_odds NUMERIC(8, 4) NOT NULL" in compiled_ddl["player_props"]
    assert "sharp_decimal_odds NUMERIC(8, 4)" in compiled_ddl["player_props"]

    assert "bet_id UUID NOT NULL" in compiled_ddl["user_bets"]
    assert "user_id UUID NOT NULL" in compiled_ddl["user_bets"]
    assert "decimal_odds NUMERIC(8, 4) NOT NULL" in compiled_ddl["user_bets"]
    assert "closing_decimal_odds NUMERIC(8, 4)" in compiled_ddl["user_bets"]
    assert "closing_fair_prob NUMERIC(6, 5)" in compiled_ddl["user_bets"]
    assert "clv_percentage NUMERIC(6, 3)" in compiled_ddl["user_bets"]
    assert "placed_at TIMESTAMP WITH TIME ZONE NOT NULL" in compiled_ddl["user_bets"]


def test_entity_persistence_uuid_v4_and_check_constraints() -> None:
    """Verify UUID v4 generation, provider prefix rules, and decimal odds >= 1.01 constraints."""
    engine = create_engine("sqlite:///:memory:")
    init_db(engine=engine)
    session_factory = create_session_factory(engine)

    with session_factory() as session:
        home_team = Team(
            external_provider_id="papi_nfl_kc",
            sport_key="americanfootball_nfl",
            name="Kansas City Chiefs",
            abbreviation="KC",
            venue_name="Arrowhead Stadium",
            is_dome=False,
        )
        away_team = Team(
            external_provider_id="papi_nfl_buf",
            sport_key="americanfootball_nfl",
            name="Buffalo Bills",
            abbreviation="BUF",
            venue_name="Highmark Stadium",
            is_dome=False,
        )
        session.add_all([home_team, away_team])
        session.flush()

        assert home_team.team_id.version == 4
        assert away_team.team_id.version == 4

        event = Event(
            external_provider_id="papi_nfl_12345",
            sport_key="americanfootball_nfl",
            home_team_id=home_team.team_id,
            away_team_id=away_team.team_id,
            commence_time=datetime(2026, 11, 15, 21, 25, tzinfo=UTC),
            status="SCHEDULED",
        )
        session.add(event)
        session.flush()
        assert event.event_id.version == 4

        prop = PlayerProp(
            external_provider_id="papi_prop_98765",
            event_id=event.event_id,
            team_id=home_team.team_id,
            player_name="Patrick Mahomes",
            market_key="player_pass_yds",
            selection="OVER",
            line_value=Decimal("274.50"),
            offered_decimal_odds=Decimal("1.9091"),
            sharp_decimal_odds=Decimal("1.8696"),
            status="ACTIVE",
        )
        session.add(prop)
        session.flush()
        assert prop.prop_id.version == 4

        bet = UserBet(
            event_id=event.event_id,
            prop_id=prop.prop_id,
            external_provider_id="papi_bet_555",
            sportsbook="fanduel",
            decimal_odds=Decimal("1.9091"),
            closing_decimal_odds=Decimal("1.8333"),
            closing_fair_prob=Decimal("0.53500"),
            clv_percentage=Decimal("2.180"),
            stake_amount=Decimal("25.00"),
            status="PENDING",
        )
        session.add(bet)
        session.commit()
        assert bet.bet_id.version == 4
        assert bet.user_id.version == 4

    # Verify check constraint rejects decimal odds < 1.01
    with session_factory() as session:
        invalid_prop = PlayerProp(
            external_provider_id="papi_prop_invalid_odds",
            event_id=event.event_id,
            player_name="Josh Allen",
            market_key="player_rush_yds",
            offered_decimal_odds=Decimal("1.0000"),
        )
        session.add(invalid_prop)
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()

    # Verify check constraint rejects unprefixed, leading-underscore, or trailing-underscore external_provider_id
    for bad_provider_id in ("unprefixedid", "_leading", "trailing_"):
        with session_factory() as session:
            unprefixed_team = Team(
                external_provider_id=bad_provider_id,
                sport_key="americanfootball_nfl",
                name="Invalid Team",
                abbreviation="INV",
            )
            session.add(unprefixed_team)
            with pytest.raises(IntegrityError):
                session.commit()
            session.rollback()

    # Verify check constraint rejects home_team_id == away_team_id
    with session_factory() as session:
        same_team_event = Event(
            external_provider_id="papi_nfl_same_team",
            sport_key="americanfootball_nfl",
            home_team_id=home_team.team_id,
            away_team_id=home_team.team_id,
            commence_time=datetime(2026, 11, 16, 20, 0, tzinfo=UTC),
            status="SCHEDULED",
        )
        session.add(same_team_event)
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()


def test_init_db_connection_error_raises_structured_error_and_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Verify init_db() raises DatabaseInitializationError and logs on connection or URL failure."""
    engine = create_engine("sqlite:///:memory:")

    def broken_begin() -> Any:
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))

    engine.begin = broken_begin  # type: ignore[method-assign]

    with caplog.at_level(logging.ERROR):
        with pytest.raises(DatabaseInitializationError) as exc_info:
            init_db(engine=engine)

    err = exc_info.value
    assert err.code == "DB_INIT_FAILED"
    assert err.retry_after == 60
    assert err.to_problem_details() == {
        "error": {
            "code": "DB_INIT_FAILED",
            "message": "Database connection or schema initialization failed.",
            "retry_after": 60,
        }
    }
    assert "Failed to initialize ParlayPal database schema" in caplog.text

    # Malformed database_url with engine=None should also raise DatabaseInitializationError
    with pytest.raises(DatabaseInitializationError) as bad_url_exc:
        init_db(database_url="not-a-valid-sqlalchemy-url://")
    assert bad_url_exc.value.code == "DB_INIT_FAILED"


def test_publish_odds_delta_sets_45s_ttl_and_publishes_iso8601_utc_frame() -> None:
    """Verify hot odds cache uses 45s TTL and Pub/Sub publishes strict ISO 8601 UTC JSON."""
    fake_redis = FakeRedisClient()
    event_id = uuid.uuid4()
    sport_key = "americanfootball_nfl"

    frame = OddsDeltaFrame(
        event_id=event_id,
        external_provider_id="papi_nfl_12345",
        sport_key=sport_key,
        decimal_odds=Decimal("1.9524"),
        quotes=[
            PropOddsQuote(
                external_provider_id="papi_prop_101",
                market_key="player_pass_yds",
                player_name="Patrick Mahomes",
                selection="OVER",
                line_value=Decimal("275.5"),
                decimal_odds=Decimal("1.9524"),
            )
        ],
        updated_at=datetime(2026, 11, 9, 4, 30, 15, tzinfo=UTC),
    )

    serialized = publish_odds_delta(fake_redis, frame)

    expected_cache_key = odds_latest_key(sport_key, event_id)
    expected_channel = odds_feed_channel(sport_key)

    assert expected_cache_key == f"odds:latest:{sport_key}:{event_id}"
    assert expected_channel == f"odds:feed:{sport_key}"
    assert fake_redis.get(expected_cache_key) == serialized
    assert fake_redis.ttl(expected_cache_key) == HOT_CACHE_TTL_SECONDS == 45

    assert len(fake_redis.published) == 1
    pub_channel, pub_message = fake_redis.published[0]
    assert pub_channel == expected_channel
    assert pub_message == serialized

    parsed = json.loads(serialized)
    assert parsed["event_id"] == str(event_id)
    assert parsed["external_provider_id"] == "papi_nfl_12345"
    assert parsed["decimal_odds"] == "1.9524"
    assert parsed["updated_at"] == "2026-11-09T04:30:15Z"
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", parsed["updated_at"])

    # Also verify ev:feed:{sport_key} and sgp:audit:{event_id} enforce 45s TTL and serialize Decimal/UUID
    prop_uuid = uuid.uuid4()
    ev_serialized = cache_ev_feed(
        fake_redis,
        sport_key,
        [{"prop_id": prop_uuid, "ev": Decimal("0.0420")}],
    )
    assert fake_redis.ttl(ev_feed_key(sport_key)) == 45
    ev_parsed = json.loads(ev_serialized)
    assert ev_parsed["items"][0]["prop_id"] == str(prop_uuid)
    assert ev_parsed["items"][0]["ev"] == "0.0420"

    sgp_serialized = cache_sgp_audit(
        fake_redis,
        event_id,
        {"audit_id": uuid.uuid4(), "fair_prob": Decimal("0.2150")},
    )
    assert fake_redis.ttl(sgp_audit_key(event_id)) == 45
    sgp_parsed = json.loads(sgp_serialized)
    assert sgp_parsed["audit"]["fair_prob"] == "0.2150"


def test_publish_odds_delta_rejects_invalid_payloads_before_redis_write() -> None:
    """Verify invalid decimal odds, external_provider_id, and sport_key fail before touching Redis."""
    fake_redis = FakeRedisClient()

    # Decimal odds < 1.01, > 9999.9999, or Infinity
    for bad_odds in ("1.0099", "10000.0000", Decimal("Infinity")):
        with pytest.raises(ValidationError):
            publish_odds_delta(
                fake_redis,
                {
                    "event_id": str(uuid.uuid4()),
                    "external_provider_id": "papi_nfl_12345",
                    "sport_key": "americanfootball_nfl",
                    "decimal_odds": bad_odds,
                },
            )

    # Invalid quote decimal odds
    with pytest.raises(ValidationError):
        publish_odds_delta(
            fake_redis,
            {
                "event_id": str(uuid.uuid4()),
                "external_provider_id": "papi_nfl_12345",
                "sport_key": "americanfootball_nfl",
                "decimal_odds": "1.91",
                "quotes": [
                    {
                        "external_provider_id": "papi_prop_1",
                        "market_key": "player_pts",
                        "player_name": "Luka Doncic",
                        "decimal_odds": "0.95",
                    }
                ],
            },
        )

    # Invalid external_provider_id formats
    for bad_provider_id in ("unprefixed", "_leading", "trailing_"):
        with pytest.raises(ValidationError):
            publish_odds_delta(
                fake_redis,
                {
                    "event_id": str(uuid.uuid4()),
                    "external_provider_id": bad_provider_id,
                    "sport_key": "americanfootball_nfl",
                    "decimal_odds": "1.91",
                },
            )

    # Invalid sport_key values
    for bad_sport_key in ("   ", "baseball_mlb"):
        with pytest.raises(ValidationError):
            publish_odds_delta(
                fake_redis,
                {
                    "event_id": str(uuid.uuid4()),
                    "external_provider_id": "papi_nfl_12345",
                    "sport_key": bad_sport_key,
                    "decimal_odds": "1.91",
                },
            )

    assert len(fake_redis.store) == 0
    assert len(fake_redis.published) == 0


def test_celery_health_check_and_ingest_odds_delta_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify worker health check and ingest_odds_delta task execution and client cleanup."""
    result = health_check()
    assert result["status"] == "ok"
    assert result["service"] == "parlaypal_worker"
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", result["timestamp"])

    fake_redis = FakeRedisClient()
    monkeypatch.setattr(celery_app_module, "get_redis_client", lambda: fake_redis)

    event_id = uuid.uuid4()
    serialized = ingest_odds_delta(
        {
            "event_id": str(event_id),
            "external_provider_id": "papi_nba_777",
            "sport_key": "basketball_nba",
            "decimal_odds": "2.1500",
        }
    )

    assert fake_redis.get(odds_latest_key("basketball_nba", event_id)) == serialized
    assert fake_redis.published == [(odds_feed_channel("basketball_nba"), serialized)]
    assert fake_redis.closed is True
