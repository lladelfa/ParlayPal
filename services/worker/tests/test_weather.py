"""Unit and integration tests for Story 1.3: Stadium Weather Ingestion Engine."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, select

from parlaypal_worker.db import create_session_factory, init_db
from parlaypal_worker.models import Event, Team
from parlaypal_worker.weather import (
    StadiumWeatherForecast,
    WeatherBadgeSeverity,
    WeatherBadgeType,
    evaluate_stadium_weather,
    ingest_events_weather,
)


def test_outdoor_nfl_high_wind_generates_warning_badge() -> None:
    """Scenario 5: Highmark Stadium (Outdoor); wind: 18.5 mph, temp: 28.0°F, precip: 20%."""
    forecast = StadiumWeatherForecast(
        venue_name="Highmark Stadium",
        is_dome=False,
        wind_speed_mph=Decimal("18.5"),
        temp_f=Decimal("28.0"),
        precip_prob=Decimal("20.0"),
    )

    assessment = evaluate_stadium_weather(forecast)
    assert assessment.is_dome is False
    assert assessment.has_warning is True

    badge_types = [b.badge_type for b in assessment.badges]
    assert WeatherBadgeType.WIND_WARNING in badge_types
    assert WeatherBadgeType.FREEZING_WARNING in badge_types
    assert WeatherBadgeType.PRECIP_WARNING not in badge_types

    wind_badge = next(b for b in assessment.badges if b.badge_type == WeatherBadgeType.WIND_WARNING)
    assert wind_badge.severity == WeatherBadgeSeverity.WARNING
    assert "18.5 mph" in wind_badge.label
    assert "player_pass_yds" in wind_badge.impacted_markets


def test_indoor_dome_venue_bypasses_weather_warnings() -> None:
    """Scenario 6: Ford Field (Detroit, Dome); outdoor blizzard (wind 30 mph, snow 90%, temp 5°F)."""
    forecast = StadiumWeatherForecast(
        venue_name="Ford Field",
        is_dome=True,
        wind_speed_mph=Decimal("30.0"),
        temp_f=Decimal("5.0"),
        precip_prob=Decimal("90.0"),
    )

    assessment = evaluate_stadium_weather(forecast)
    assert assessment.is_dome is True
    assert assessment.has_warning is False
    assert len(assessment.badges) == 1
    assert assessment.badges[0].badge_type == WeatherBadgeType.DOME
    assert assessment.badges[0].severity == WeatherBadgeSeverity.NEUTRAL
    assert assessment.badges[0].label == "Indoor / Climate Controlled"


def test_outdoor_nfl_high_precipitation_generates_warning_badge() -> None:
    """Scenario 7: Lambeau Field; wind: 10 mph, precip: 65% (snow), temp: 31°F."""
    forecast = StadiumWeatherForecast(
        venue_name="Lambeau Field",
        is_dome=False,
        wind_speed_mph=Decimal("10.0"),
        temp_f=Decimal("31.0"),
        precip_prob=Decimal("65.0"),
    )

    assessment = evaluate_stadium_weather(forecast)
    assert assessment.is_dome is False
    assert assessment.has_warning is True

    badge_types = [b.badge_type for b in assessment.badges]
    assert WeatherBadgeType.PRECIP_WARNING in badge_types
    assert WeatherBadgeType.FREEZING_WARNING in badge_types
    assert WeatherBadgeType.WIND_WARNING not in badge_types

    precip_badge = next(
        b for b in assessment.badges if b.badge_type == WeatherBadgeType.PRECIP_WARNING
    )
    assert precip_badge.severity == WeatherBadgeSeverity.WARNING
    assert "65.0%" in precip_badge.label


def test_outdoor_nfl_clear_conditions() -> None:
    """Outdoor stadium with clear weather (wind 6 mph, precip 5%, temp 68°F)."""
    forecast = StadiumWeatherForecast(
        venue_name="Raymond James Stadium",
        is_dome=False,
        wind_speed_mph=Decimal("6.0"),
        temp_f=Decimal("68.0"),
        precip_prob=Decimal("5.0"),
    )

    assessment = evaluate_stadium_weather(forecast)
    assert assessment.is_dome is False
    assert assessment.has_warning is False
    assert len(assessment.badges) == 1
    assert assessment.badges[0].badge_type == WeatherBadgeType.CLEAR
    assert assessment.badges[0].severity == WeatherBadgeSeverity.NEUTRAL


def test_ingest_events_weather_persists_to_postgresql() -> None:
    """Verify ingest_events_weather batch helper updates Event columns in PostgreSQL."""
    engine = create_engine("sqlite:///:memory:")
    init_db(engine=engine)
    session_factory = create_session_factory(engine)
    sport_key = "americanfootball_nfl"

    with session_factory() as session:
        home_team = Team(
            external_provider_id="papi_nfl_buf_team",
            sport_key=sport_key,
            name="Buffalo Bills",
            abbreviation="BUF",
            venue_name="Highmark Stadium",
            is_dome=False,
        )
        away_team = Team(
            external_provider_id="papi_nfl_kc_team",
            sport_key=sport_key,
            name="Kansas City Chiefs",
            abbreviation="KC",
            venue_name="GEHA Field at Arrowhead Stadium",
            is_dome=False,
        )
        session.add_all([home_team, away_team])
        session.flush()

        event = Event(
            external_provider_id="papi_nfl_20261122_kc_buf",
            sport_key=sport_key,
            home_team_id=home_team.team_id,
            away_team_id=away_team.team_id,
            commence_time=datetime(2026, 11, 22, 21, 25, tzinfo=UTC),
            status="SCHEDULED",
        )
        session.add(event)
        session.commit()
        event_id = event.event_id

    forecasts = [
        {
            "event_id": event_id,
            "wind_speed_mph": Decimal("16.5"),
            "temp_f": Decimal("30.0"),
            "precip_prob": Decimal("55.0"),
        }
    ]

    with session_factory() as session:
        updated_count = ingest_events_weather(session=session, event_weather_data=forecasts)
        assert updated_count == 1

        updated_event = session.scalar(select(Event).where(Event.event_id == event_id))
        assert updated_event is not None
        assert updated_event.weather_wind_mph == Decimal("16.50")
        assert updated_event.weather_temp_f == Decimal("30.00")
        assert updated_event.weather_precip_prob == Decimal("55.00")
        assert updated_event.is_dome is False


def test_home_team_dome_resolution_and_redis_badge_caching(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify home team dome resolution, zeroed wind metrics, and Redis weather badge caching."""
    engine = create_engine("sqlite:///:memory:")
    init_db(engine=engine)
    session_factory = create_session_factory(engine)
    sport_key = "americanfootball_nfl"

    from tests.test_substrate import FakeRedisClient

    fake_redis = FakeRedisClient()

    with session_factory() as session:
        dome_team = Team(
            external_provider_id="papi_nfl_det_team",
            sport_key=sport_key,
            name="Detroit Lions",
            abbreviation="DET",
            venue_name="Ford Field",
            is_dome=True,
        )
        visitor = Team(
            external_provider_id="papi_nfl_gb_team",
            sport_key=sport_key,
            name="Green Bay Packers",
            abbreviation="GB",
            venue_name="Lambeau Field",
            is_dome=False,
        )
        session.add_all([dome_team, visitor])
        session.flush()

        event = Event(
            external_provider_id="papi_nfl_20261126_gb_det",
            sport_key=sport_key,
            home_team_id=dome_team.team_id,
            away_team_id=visitor.team_id,
            commence_time=datetime(2026, 11, 26, 17, 30, tzinfo=UTC),
            status="SCHEDULED",
        )
        session.add(event)
        session.commit()
        event_id = event.event_id

    # Outside weather blizzard (35 mph wind, 90% snow)
    weather_payload = [
        {
            "event_id": event_id,
            "wind_speed_mph": Decimal("35.0"),
            "temp_f": Decimal("15.0"),
            "precip_prob": Decimal("90.0"),
        }
    ]

    with session_factory() as session:
        updated = ingest_events_weather(
            session=session,
            event_weather_data=weather_payload,
            redis_client=fake_redis,
        )
        assert updated == 1

        db_event = session.scalar(select(Event).where(Event.event_id == event_id))
        assert db_event is not None
        assert db_event.is_dome is True
        assert db_event.weather_wind_mph == Decimal("0.00")
        assert db_event.weather_precip_prob == Decimal("0.00")

    # Verify Redis badge caching
    cached_badge_json = fake_redis.get(f"weather:event:{event_id}")
    assert cached_badge_json is not None
    import json

    cached_badge = json.loads(cached_badge_json)
    assert cached_badge["is_dome"] is True
    assert cached_badge["has_warning"] is False
    assert cached_badge["badges"][0]["badge_type"] == "DOME"

    # Test Celery tasks sync_event_weather and sync_weather_and_hit_rates
    from parlaypal_worker import celery_app as celery_app_module
    from parlaypal_worker.celery_app import sync_event_weather, sync_weather_and_hit_rates

    monkeypatch.setattr(celery_app_module, "create_session_factory", lambda: session_factory)
    monkeypatch.setattr(celery_app_module, "get_redis_client", lambda: fake_redis)

    task_res = sync_event_weather(weather_payload)
    assert task_res["status"] == "ok"
    assert task_res["updated_events"] == 1

    coord_res = sync_weather_and_hit_rates(
        {"weather_data": weather_payload, "player_game_logs": {}}
    )
    assert coord_res["status"] == "ok"
    assert coord_res["updated_events"] == 1
