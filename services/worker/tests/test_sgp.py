"""Tests for SGP pricing models, correlation calculation, synergy detection, and Redis caching."""

from __future__ import annotations

import json
from decimal import Decimal

import httpx

from parlaypal_worker.redis_client import sgp_audit_key


class FakeRedisClient:
    """In-memory Redis double capturing writes and TTL."""

    def __init__(self) -> None:
        self.store: dict[str, tuple[str, int | None]] = {}
        self.closed: bool = False

    def set(self, name: str, value: str, ex: int | None = None) -> bool:
        self.store[name] = (value, ex)
        return True

    def get(self, name: str) -> str | None:
        item = self.store.get(name)
        return item[0] if item is not None else None

    def ttl(self, name: str) -> int:
        item = self.store.get(name)
        if item is None:
            return -2
        return item[1] if item[1] is not None else -1

    def close(self) -> None:
        self.closed = True


def test_sgp_models_validation():
    from parlaypal_worker.sgp import SgpAuditItem, SgpLegSelection, SgpPriceResponse

    leg = SgpLegSelection(
        prop_id="prop-1",
        player_name="Patrick Mahomes",
        team_abbreviation="KC",
        market_key="player_pass_yds",
        selection="OVER",
        line_value=Decimal("280.5"),
        offered_decimal_odds=Decimal("1.9091"),
        fair_probability=Decimal("0.55000"),
    )
    assert leg.player_name == "Patrick Mahomes"
    assert leg.offered_decimal_odds == Decimal("1.9091")

    audit_item = SgpAuditItem(
        leg_a_prop_id="prop-1",
        leg_b_prop_id="prop-2",
        leg_a_description="Patrick Mahomes Over 280.5 Pass Yds",
        leg_b_description="Travis Kelce Over 6.5 Rec",
        correlation_coefficient=Decimal("0.48"),
        synergy_type="positive",
        rationale="Teammates QB Passing + Receiver receptions exhibit strong positive synergy.",
    )
    assert audit_item.correlation_coefficient == Decimal("0.48")
    assert audit_item.synergy_type == "positive"

    response = SgpPriceResponse(
        event_id="evt-123",
        sport_key="americanfootball_nfl",
        unadjusted_fair_probability=Decimal("0.25000"),
        sgp_fair_probability=Decimal("0.32000"),
        sgp_decimal_odds=Decimal("3.6447"),
        sgp_american_odds=264,
        has_positive_synergy=True,
        correlation_audit=[audit_item],
        source="api",
    )
    assert response.has_positive_synergy is True
    assert response.sgp_fair_probability == Decimal("0.32000")


def test_heuristic_sgp_positive_synergy_nfl():
    from parlaypal_worker.sgp import SgpLegSelection, calculate_heuristic_sgp

    leg1 = SgpLegSelection(
        prop_id="prop-1",
        player_name="Patrick Mahomes",
        team_abbreviation="KC",
        market_key="player_pass_yds",
        selection="OVER",
        line_value=Decimal("280.5"),
        offered_decimal_odds=Decimal("1.9091"),
        fair_probability=Decimal("0.50000"),
    )
    leg2 = SgpLegSelection(
        prop_id="prop-2",
        player_name="Travis Kelce",
        team_abbreviation="KC",
        market_key="player_receptions",
        selection="OVER",
        line_value=Decimal("6.5"),
        offered_decimal_odds=Decimal("1.9091"),
        fair_probability=Decimal("0.50000"),
    )

    result = calculate_heuristic_sgp(
        event_id="evt-kc-bal",
        sport_key="americanfootball_nfl",
        legs=[leg1, leg2],
    )

    assert result.has_positive_synergy is True
    assert result.sgp_fair_probability > result.unadjusted_fair_probability
    assert len(result.correlation_audit) == 1
    assert result.correlation_audit[0].correlation_coefficient > Decimal("0.10")
    assert result.correlation_audit[0].synergy_type == "positive"


def test_heuristic_sgp_negative_cannibalization_nfl():
    from parlaypal_worker.sgp import SgpLegSelection, calculate_heuristic_sgp

    leg1 = SgpLegSelection(
        prop_id="prop-1",
        player_name="Derrick Henry",
        team_abbreviation="BAL",
        market_key="player_rush_yds",
        selection="OVER",
        line_value=Decimal("78.5"),
        offered_decimal_odds=Decimal("1.9091"),
        fair_probability=Decimal("0.50000"),
    )
    leg2 = SgpLegSelection(
        prop_id="prop-2",
        player_name="Isiah Pacheco",
        team_abbreviation="KC",
        market_key="player_rush_yds",
        selection="OVER",
        line_value=Decimal("65.5"),
        offered_decimal_odds=Decimal("1.9091"),
        fair_probability=Decimal("0.50000"),
    )

    result = calculate_heuristic_sgp(
        event_id="evt-kc-bal",
        sport_key="americanfootball_nfl",
        legs=[leg1, leg2],
    )

    assert result.has_positive_synergy is False
    assert result.sgp_fair_probability <= result.unadjusted_fair_probability
    assert len(result.correlation_audit) == 1
    assert result.correlation_audit[0].correlation_coefficient < Decimal("0")
    assert result.correlation_audit[0].synergy_type == "negative"


def test_heuristic_sgp_nba_assists_and_points():
    from parlaypal_worker.sgp import SgpLegSelection, calculate_heuristic_sgp

    leg1 = SgpLegSelection(
        prop_id="p-nba-1",
        player_name="Jrue Holiday",
        team_abbreviation="BOS",
        market_key="player_assists",
        selection="OVER",
        line_value=Decimal("6.5"),
        offered_decimal_odds=Decimal("1.85"),
        fair_probability=Decimal("0.52"),
    )
    leg2 = SgpLegSelection(
        prop_id="p-nba-2",
        player_name="Jayson Tatum",
        team_abbreviation="BOS",
        market_key="player_points",
        selection="OVER",
        line_value=Decimal("27.5"),
        offered_decimal_odds=Decimal("1.90"),
        fair_probability=Decimal("0.51"),
    )

    result = calculate_heuristic_sgp(
        event_id="evt-bos-nyk",
        sport_key="basketball_nba",
        legs=[leg1, leg2],
    )

    assert result.has_positive_synergy is True
    assert result.correlation_audit[0].correlation_coefficient > Decimal("0")
    assert result.correlation_audit[0].synergy_type == "positive"


def test_price_sgp_with_external_api_success():
    from parlaypal_worker.sgp import SgpLegSelection, price_sgp

    fake_redis = FakeRedisClient()
    event_id = "e4f8a123-bc45-4a8e-9012-3456789abcde"

    mock_api_response = {
        "sgp_fair_price_decimal": 3.42,
        "sgp_fair_prob": 0.2924,
        "unadjusted_prob": 0.2215,
        "correlation_audit": [
            {
                "leg_1": "Patrick Mahomes Over 280.5 Pass Yds",
                "leg_2": "Travis Kelce Over 6.5 Rec",
                "correlation_coefficient": 0.48,
                "impact": "positive_correlation",
            }
        ],
    }

    leg1 = SgpLegSelection(
        prop_id="prop-1",
        player_name="Patrick Mahomes",
        team_abbreviation="KC",
        market_key="player_pass_yds",
        selection="OVER",
        line_value=Decimal("280.5"),
        offered_decimal_odds=Decimal("1.9091"),
        fair_probability=Decimal("0.4700"),
    )
    leg2 = SgpLegSelection(
        prop_id="prop-2",
        player_name="Travis Kelce",
        team_abbreviation="KC",
        market_key="player_receptions",
        selection="OVER",
        line_value=Decimal("6.5"),
        offered_decimal_odds=Decimal("1.9091"),
        fair_probability=Decimal("0.4713"),
    )

    def mock_handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert "/sgp/price" in str(request.url)
        return httpx.Response(200, json=mock_api_response)

    transport = httpx.MockTransport(mock_handler)
    client = httpx.Client(transport=transport)

    result = price_sgp(
        event_id=event_id,
        sport_key="americanfootball_nfl",
        legs=[leg1, leg2],
        api_key="test-api-key",
        http_client=client,
        redis_client=fake_redis,
    )

    assert result.source == "api"
    assert result.has_positive_synergy is True
    assert result.sgp_fair_probability == Decimal("0.29240")
    assert result.correlation_audit[0].correlation_coefficient == Decimal("0.48")

    # Verify Redis caching at sgp:audit:{event_id} with 45s TTL
    cached = fake_redis.get(sgp_audit_key(event_id))
    assert cached is not None
    assert fake_redis.ttl(sgp_audit_key(event_id)) == 45
    cached_data = json.loads(cached)
    assert Decimal(cached_data["audit"]["sgp_fair_probability"]) == Decimal("0.2924")
    assert cached_data["audit"]["has_positive_synergy"] is True


def test_price_sgp_api_error_fallback_to_heuristic():
    from parlaypal_worker.sgp import SgpLegSelection, price_sgp

    fake_redis = FakeRedisClient()
    event_id = "e4f8a123-bc45-4a8e-9012-3456789abcde"

    def mock_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "Internal Server Error"})

    transport = httpx.MockTransport(mock_handler)
    client = httpx.Client(transport=transport)

    leg1 = SgpLegSelection(
        prop_id="prop-1",
        player_name="Patrick Mahomes",
        team_abbreviation="KC",
        market_key="player_pass_yds",
        selection="OVER",
        line_value=Decimal("280.5"),
        offered_decimal_odds=Decimal("1.9091"),
        fair_probability=Decimal("0.5000"),
    )
    leg2 = SgpLegSelection(
        prop_id="prop-2",
        player_name="Travis Kelce",
        team_abbreviation="KC",
        market_key="player_receptions",
        selection="OVER",
        line_value=Decimal("6.5"),
        offered_decimal_odds=Decimal("1.9091"),
        fair_probability=Decimal("0.5000"),
    )

    result = price_sgp(
        event_id=event_id,
        sport_key="americanfootball_nfl",
        legs=[leg1, leg2],
        api_key="test-api-key",
        http_client=client,
        redis_client=fake_redis,
    )

    assert result.source == "heuristic"
    assert result.has_positive_synergy is True
    # Cached in Redis even on heuristic fallback
    cached = fake_redis.get(sgp_audit_key(event_id))
    assert cached is not None
    assert fake_redis.ttl(sgp_audit_key(event_id)) == 45


def test_celery_task_price_sgp_event():
    from parlaypal_worker.celery_app import price_sgp_event

    fake_redis = FakeRedisClient()
    event_id = "evt-celery-123"

    payload = [
        {
            "prop_id": "p1",
            "player_name": "Patrick Mahomes",
            "team_abbreviation": "KC",
            "market_key": "player_pass_yds",
            "selection": "OVER",
            "line_value": 280.5,
            "offered_decimal_odds": 1.9091,
            "fair_probability": 0.5000,
        },
        {
            "prop_id": "p2",
            "player_name": "Travis Kelce",
            "team_abbreviation": "KC",
            "market_key": "player_receptions",
            "selection": "OVER",
            "line_value": 6.5,
            "offered_decimal_odds": 1.9091,
            "fair_probability": 0.5000,
        },
    ]

    res = price_sgp_event(
        event_id=event_id,
        legs=payload,
        sport_key="americanfootball_nfl",
        redis_client=fake_redis,
    )

    assert res["event_id"] == event_id
    assert res["has_positive_synergy"] is True
    assert "sgp_fair_probability" in res
    assert len(res["correlation_audit"]) == 1

    # Check redis cache
    cached = fake_redis.get(sgp_audit_key(event_id))
    assert cached is not None
