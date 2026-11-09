"""Unit and integration tests for Story 2.1: Multi-Sport Schedule & Market Browser."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from pydantic import ValidationError

from parlaypal_worker.models import Event, PlayerProp, Team
from parlaypal_worker.redis_client import markets_browser_key

from parlaypal_worker.market_browser import (  # isort: skip
    MarketBrowserError,
    MarketBrowserFeed,
    MarketBrowserPropItem,
    build_market_browser_feed,
    classify_date_window,
    filter_market_browser_feed,
    sync_market_browser_to_redis,
)

# Wednesday 2026-11-11 15:00 UTC -> upcoming weekend is Sat 11-14 / Sun 11-15.
NOW_UTC = datetime(2026, 11, 11, 15, 0, tzinfo=UTC)


class MockRedis:
    """In-memory Redis double capturing values and TTLs."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.ttls: dict[str, int | None] = {}

    def set(self, name: str, value: str, ex: int | None = None) -> bool:
        self.store[name] = value
        self.ttls[name] = ex
        return True

    def get(self, name: str) -> str | None:
        return self.store.get(name)

    def publish(self, channel: str, message: str) -> int:
        return 0


def _team(abbr: str, sport: str) -> Team:
    return Team(
        team_id=uuid.uuid4(),
        external_provider_id=f"papi_{sport}_team_{abbr.lower()}",
        sport_key=sport,
        name=abbr,
        abbreviation=abbr,
        is_dome=False,
    )


def _event(
    sport: str,
    home: Team,
    away: Team,
    commence_time: datetime,
    *,
    status: str = "SCHEDULED",
    is_dome: bool = False,
    wind: Decimal | None = None,
) -> Event:
    return Event(
        event_id=uuid.uuid4(),
        external_provider_id=f"papi_{sport}_{uuid.uuid4().hex[:8]}",
        sport_key=sport,
        home_team_id=home.team_id,
        away_team_id=away.team_id,
        commence_time=commence_time,
        status=status,
        is_dome=is_dome,
        weather_wind_mph=wind,
    )


def _prop(
    event: Event,
    market_key: str,
    *,
    player: str = "Player",
    team: Team | None = None,
    guarded_ev: Decimal | None = Decimal("0.0300"),
    hit_rate_l10: Decimal | None = Decimal("0.7000"),
    status: str = "ACTIVE",
    offered: Decimal = Decimal("1.9000"),
    fair: Decimal | None = Decimal("0.5400"),
) -> PlayerProp:
    return PlayerProp(
        prop_id=uuid.uuid4(),
        external_provider_id=f"papi_prop_{uuid.uuid4().hex[:8]}",
        event_id=event.event_id,
        team_id=team.team_id if team else None,
        player_name=player,
        market_key=market_key,
        selection="OVER",
        line_value=Decimal("24.5"),
        offered_decimal_odds=offered,
        sharp_decimal_odds=Decimal("1.8500"),
        fair_probability=fair,
        guarded_ev=guarded_ev,
        hit_rate_l5=Decimal("0.8000"),
        hit_rate_l10=hit_rate_l10,
        hit_rate_season=Decimal("0.6800"),
        status=status,
    )


@pytest.fixture()
def slate() -> dict[str, Any]:
    """Build a multi-sport slate spanning today, tomorrow, and weekend windows."""
    bal, pit = _team("BAL", "americanfootball_nfl"), _team("PIT", "americanfootball_nfl")
    buf, nyj = _team("BUF", "americanfootball_nfl"), _team("NYJ", "americanfootball_nfl")
    bos, nyk = _team("BOS", "basketball_nba"), _team("NYK", "basketball_nba")
    lal, gsw = _team("LAL", "basketball_nba"), _team("GSW", "basketball_nba")
    teams = [bal, pit, buf, nyj, bos, nyk, lal, gsw]

    nba_today = _event("basketball_nba", nyk, bos, NOW_UTC + timedelta(hours=4), is_dome=True)
    nba_tomorrow = _event("basketball_nba", gsw, lal, NOW_UTC + timedelta(hours=28), is_dome=True)
    nfl_weekend = _event(
        "americanfootball_nfl", pit, bal, NOW_UTC + timedelta(days=4), wind=Decimal("19.0")
    )
    nfl_54h = _event("americanfootball_nfl", nyj, buf, NOW_UTC + timedelta(hours=54))
    nfl_live = _event(
        "americanfootball_nfl", pit, bal, NOW_UTC - timedelta(minutes=10), status="LIVE"
    )
    nfl_postponed = _event(
        "americanfootball_nfl", nyj, buf, NOW_UTC + timedelta(hours=6), status="POSTPONED"
    )
    events = [nba_today, nba_tomorrow, nfl_weekend, nfl_54h, nfl_live, nfl_postponed]

    tatum_pts = _prop(
        nba_today,
        "player_points",
        player="Jayson Tatum",
        team=bos,
        guarded_ev=Decimal("0.0420"),
        hit_rate_l10=Decimal("0.8000"),
    )
    brunson_pts = _prop(
        nba_today,
        "player_points",
        player="Jalen Brunson",
        team=nyk,
        guarded_ev=Decimal("0.0200"),
        hit_rate_l10=Decimal("0.6000"),
    )
    tatum_reb = _prop(nba_today, "player_rebounds", player="Jayson Tatum", team=bos)
    curry_threes = _prop(nba_tomorrow, "player_threes", player="Stephen Curry", team=gsw)
    henry_td = _prop(nfl_weekend, "player_anytime_td", player="Derrick Henry", team=bal)
    jackson_pass = _prop(nfl_weekend, "player_pass_yds", player="Lamar Jackson", team=bal)
    cook_rush = _prop(nfl_54h, "player_rush_yds", player="James Cook", team=buf)
    stale = _prop(
        nfl_weekend,
        "player_anytime_td",
        player="Stale Line",
        guarded_ev=Decimal("0.0800"),
        status="SUSPECT_STALE_LINE",
    )
    outlier = _prop(nba_today, "player_points", player="Outlier Guy", guarded_ev=Decimal("0.1150"))
    live_prop = _prop(nfl_live, "player_anytime_td", player="Live Player")
    postponed_prop = _prop(nfl_postponed, "player_rush_yds", player="Postponed Player")
    unsupported_market = _prop(nba_today, "player_assists", player="Assist Man")
    suspended = _prop(nba_today, "player_points", player="Suspended Guy", status="SUSPENDED")

    props = [
        tatum_pts,
        brunson_pts,
        tatum_reb,
        curry_threes,
        henry_td,
        jackson_pass,
        cook_rush,
        stale,
        outlier,
        live_prop,
        postponed_prop,
        unsupported_market,
        suspended,
    ]
    return {
        "teams_map": {t.team_id: t for t in teams},
        "events_map": {e.event_id: e for e in events},
        "props": props,
        "named": {
            "tatum_pts": tatum_pts,
            "brunson_pts": brunson_pts,
            "tatum_reb": tatum_reb,
            "curry_threes": curry_threes,
            "henry_td": henry_td,
            "jackson_pass": jackson_pass,
            "cook_rush": cook_rush,
            "stale": stale,
            "outlier": outlier,
            "live_prop": live_prop,
            "postponed_prop": postponed_prop,
            "unsupported_market": unsupported_market,
            "suspended": suspended,
        },
        "events": {
            "nba_today": nba_today,
            "nba_tomorrow": nba_tomorrow,
            "nfl_weekend": nfl_weekend,
            "nfl_54h": nfl_54h,
            "nfl_live": nfl_live,
        },
    }


def _build(slate: dict[str, Any]) -> MarketBrowserFeed:
    return build_market_browser_feed(
        props=slate["props"],
        events_map=slate["events_map"],
        teams_map=slate["teams_map"],
        now_utc=NOW_UTC,
    )


# ---------------------------------------------------------------------------
# Date window classification
# ---------------------------------------------------------------------------


def test_classify_date_window_relative_offsets() -> None:
    assert classify_date_window(NOW_UTC + timedelta(hours=4), NOW_UTC) == "today"
    assert classify_date_window(NOW_UTC + timedelta(hours=28), NOW_UTC) == "tomorrow"
    assert classify_date_window(NOW_UTC + timedelta(hours=54), NOW_UTC) == "weekend"


def test_classify_date_window_upcoming_saturday_and_sunday() -> None:
    saturday = datetime(2026, 11, 14, 18, 0, tzinfo=UTC)
    sunday = datetime(2026, 11, 15, 21, 25, tzinfo=UTC)
    assert classify_date_window(saturday, NOW_UTC) == "weekend"
    assert classify_date_window(sunday, NOW_UTC) == "weekend"


def test_classify_date_window_rejects_commenced_events() -> None:
    assert classify_date_window(NOW_UTC, NOW_UTC) is None
    assert classify_date_window(NOW_UTC - timedelta(minutes=1), NOW_UTC) is None


def test_classify_date_window_out_of_horizon_returns_none() -> None:
    # Following Wednesday (7 days out) is beyond today/tomorrow/upcoming weekend.
    assert classify_date_window(NOW_UTC + timedelta(days=7), NOW_UTC) is None


def test_classify_date_window_handles_naive_datetimes_as_utc() -> None:
    naive = (NOW_UTC + timedelta(hours=4)).replace(tzinfo=None)
    assert classify_date_window(naive, NOW_UTC) == "today"


# ---------------------------------------------------------------------------
# Feed assembly, exclusion rules, ranking, tiering
# ---------------------------------------------------------------------------


def test_feed_excludes_outliers_stale_commenced_and_unsupported(slate: dict[str, Any]) -> None:
    feed = _build(slate)
    ids = {p.prop_id for p in feed.props}
    named = slate["named"]

    for excluded in (
        "stale",
        "outlier",
        "live_prop",
        "postponed_prop",
        "unsupported_market",
        "suspended",
    ):
        assert named[excluded].prop_id not in ids, excluded

    for included in (
        "tatum_pts",
        "brunson_pts",
        "tatum_reb",
        "curry_threes",
        "henry_td",
        "jackson_pass",
        "cook_rush",
    ):
        assert named[included].prop_id in ids, included

    for item in feed.props:
        assert item.status == "ACTIVE"
        assert item.guarded_ev <= Decimal("0.10000")


def test_feed_excludes_commenced_scheduled_event(slate: dict[str, Any]) -> None:
    """An event still stamped SCHEDULED but whose commence_time has passed is rejected."""
    event = slate["events"]["nba_today"]
    event.commence_time = NOW_UTC
    feed = _build(slate)
    assert all(p.event_id != event.event_id for p in feed.props)
    assert all(g.event_id != event.event_id for g in feed.games)


def test_feed_rejects_market_mismatched_to_sport(slate: dict[str, Any]) -> None:
    event = slate["events"]["nba_today"]
    mismatched = _prop(event, "player_anytime_td", player="Wrong Sport")
    slate["props"].append(mismatched)
    feed = _build(slate)
    assert mismatched.prop_id not in {p.prop_id for p in feed.props}


def test_feed_skips_props_missing_quant_metrics(slate: dict[str, Any]) -> None:
    event = slate["events"]["nba_today"]
    no_fair = _prop(event, "player_points", player="No Fair", fair=None)
    no_ev = _prop(event, "player_points", player="No EV", guarded_ev=None)
    slate["props"].extend([no_fair, no_ev])
    feed = _build(slate)
    ids = {p.prop_id for p in feed.props}
    assert no_fair.prop_id not in ids
    assert no_ev.prop_id not in ids


def test_feed_ranks_by_hybrid_score_then_ev_then_hit_rate(slate: dict[str, Any]) -> None:
    feed = _build(slate)
    keys = [
        (p.hybrid_value_score, p.guarded_ev, p.hit_rate_l10 or Decimal("0")) for p in feed.props
    ]
    assert keys == sorted(keys, reverse=True)


def test_ranking_tiebreakers() -> None:
    home, away = _team("AAA", "basketball_nba"), _team("BBB", "basketball_nba")
    event = _event("basketball_nba", home, away, NOW_UTC + timedelta(hours=3), is_dome=True)
    # A and B share score 74 but differ on EV; C and D share score and EV but differ on L10.
    a = _prop(event, "player_points", player="A", guarded_ev=Decimal("0.0300"))
    b = _prop(event, "player_points", player="B", guarded_ev=Decimal("0.0310"))
    feed = build_market_browser_feed(
        props=[a, b],
        events_map={event.event_id: event},
        teams_map={home.team_id: home, away.team_id: away},
        now_utc=NOW_UTC,
    )
    assert feed.props[0].hybrid_value_score == feed.props[1].hybrid_value_score == 74
    assert [p.player_name for p in feed.props] == ["B", "A"]

    # 0.6 * 70.4 + 0.4 * 80 = 74.24 -> 74, identical EV, higher hit rate wins.
    c = _prop(event, "player_points", player="C", hit_rate_l10=Decimal("0.7000"))
    d = _prop(event, "player_points", player="D", hit_rate_l10=Decimal("0.7040"))
    feed_cd = build_market_browser_feed(
        props=[c, d],
        events_map={event.event_id: event},
        teams_map={},
        now_utc=NOW_UTC,
    )
    assert feed_cd.props[0].hybrid_value_score == feed_cd.props[1].hybrid_value_score
    assert [p.player_name for p in feed_cd.props] == ["D", "C"]


def test_hybrid_value_score_formula_on_items(slate: dict[str, Any]) -> None:
    feed = _build(slate)
    tatum = next(p for p in feed.props if p.prop_id == slate["named"]["tatum_pts"].prop_id)
    # 0.60 * 80 + 0.40 * clamp(4.2 * 10 + 50 = 92) = 48 + 36.8 = 84.8 -> 85
    assert tatum.hybrid_value_score == 85


def test_high_value_tiering(slate: dict[str, Any]) -> None:
    feed = _build(slate)
    by_id = {p.prop_id: p for p in feed.props}
    tatum = by_id[slate["named"]["tatum_pts"].prop_id]
    assert tatum.is_high_value is True
    assert tatum.value_tier == "HIGH_VALUE"

    brunson = by_id[slate["named"]["brunson_pts"].prop_id]
    assert brunson.is_high_value is False
    assert brunson.value_tier == "POSITIVE_VALUE"


def test_value_tier_standard_below_positive_threshold() -> None:
    home, away = _team("AAA", "basketball_nba"), _team("BBB", "basketball_nba")
    event = _event("basketball_nba", home, away, NOW_UTC + timedelta(hours=3), is_dome=True)
    low = _prop(event, "player_points", guarded_ev=Decimal("0.0100"), hit_rate_l10=Decimal("0.9"))
    feed = build_market_browser_feed(
        props=[low], events_map={event.event_id: event}, teams_map={}, now_utc=NOW_UTC
    )
    assert feed.props[0].value_tier == "STANDARD"
    assert feed.props[0].is_high_value is False


def test_prop_rows_carry_full_telemetry(slate: dict[str, Any]) -> None:
    feed = _build(slate)
    by_id = {p.prop_id: p for p in feed.props}
    tatum = by_id[slate["named"]["tatum_pts"].prop_id]
    assert tatum.sport_key == "nba"
    assert tatum.matchup == "BOS @ NYK"
    assert tatum.team_abbreviation == "BOS"
    assert tatum.date_window == "today"
    assert tatum.market_label == "Points"
    assert tatum.offered_american_odds == -111
    assert tatum.hit_rate_l5 == Decimal("0.8000")
    assert tatum.hit_rate_season == Decimal("0.6800")
    assert len(tatum.sofascore_form) == 5
    assert len(tatum.sofascore_dots) == 5
    assert tatum.weather_badge is not None
    assert tatum.weather_badge.badge_type == "DOME"

    henry = by_id[slate["named"]["henry_td"].prop_id]
    assert henry.sport_key == "nfl"
    assert henry.date_window == "weekend"
    assert henry.market_label == "Anytime TD"
    assert henry.weather_badge is not None
    assert henry.weather_badge.badge_type == "WIND_WARNING"
    assert henry.weather_badge.is_threat is True

    cook = by_id[slate["named"]["cook_rush"].prop_id]
    assert cook.date_window == "weekend"
    assert cook.weather_badge is not None
    assert cook.weather_badge.badge_type == "CLEAR"

    curry = by_id[slate["named"]["curry_threes"].prop_id]
    assert curry.date_window == "tomorrow"


def test_scheduled_game_summaries(slate: dict[str, Any]) -> None:
    feed = _build(slate)
    game_ids = {g.event_id for g in feed.games}
    assert slate["events"]["nfl_live"].event_id not in game_ids
    nba_today = next(g for g in feed.games if g.event_id == slate["events"]["nba_today"].event_id)
    assert nba_today.matchup == "BOS @ NYK"
    assert nba_today.date_window == "today"
    assert nba_today.prop_count == 3  # tatum pts, brunson pts, tatum reb
    assert nba_today.top_hybrid_value_score == 85
    # Games ordered by commence time
    times = [g.commence_time for g in feed.games]
    assert times == sorted(times)


def test_prop_item_model_rejects_outlier_and_bad_odds() -> None:
    base: dict[str, Any] = {
        "prop_id": uuid.uuid4(),
        "event_id": uuid.uuid4(),
        "sport_key": "nba",
        "player_name": "X",
        "team_abbreviation": "AAA",
        "matchup": "AAA @ BBB",
        "commence_time": NOW_UTC + timedelta(hours=2),
        "date_window": "today",
        "market_key": "player_points",
        "market_label": "Points",
        "market_display": "Over 20.5 Points",
        "offered_decimal_odds": Decimal("1.9000"),
        "offered_american_odds": -111,
        "fair_probability": Decimal("0.54"),
        "guarded_ev": Decimal("0.0300"),
        "hit_rate_display": "7/10 (70.0%) L10",
        "hybrid_value_score": 70,
        "value_tier": "POSITIVE_VALUE",
    }
    MarketBrowserPropItem.model_validate(base)
    with pytest.raises(ValidationError):
        MarketBrowserPropItem.model_validate({**base, "guarded_ev": Decimal("0.1150")})
    with pytest.raises(ValidationError):
        MarketBrowserPropItem.model_validate({**base, "offered_decimal_odds": Decimal("1.0000")})
    with pytest.raises(ValidationError):
        MarketBrowserPropItem.model_validate({**base, "offered_decimal_odds": Decimal("NaN")})
    with pytest.raises(ValidationError):
        MarketBrowserPropItem.model_validate({**base, "status": "SUSPECT_STALE_LINE"})


# ---------------------------------------------------------------------------
# Filtering
# ---------------------------------------------------------------------------


def test_filter_nba_points_today(slate: dict[str, Any]) -> None:
    feed = _build(slate)
    filtered = filter_market_browser_feed(
        feed, sport="nba", date_window="today", market="player_points"
    )
    names = [p.player_name for p in filtered.props]
    assert names == ["Jayson Tatum", "Jalen Brunson"]
    assert all(p.market_key == "player_points" for p in filtered.props)
    assert all(g.sport_key == "nba" and g.date_window == "today" for g in filtered.games)
    assert filtered.sport_key == "nba"


def test_filter_nfl_market_categories(slate: dict[str, Any]) -> None:
    feed = _build(slate)
    for market, expected in (
        ("player_anytime_td", ["Derrick Henry"]),
        ("player_pass_yds", ["Lamar Jackson"]),
        ("player_rush_yds", ["James Cook"]),
    ):
        filtered = filter_market_browser_feed(feed, sport="nfl", market=market)
        assert [p.player_name for p in filtered.props] == expected


def test_filter_resets_market_invalid_for_sport(slate: dict[str, Any]) -> None:
    feed = _build(slate)
    filtered = filter_market_browser_feed(feed, sport="nfl", market="player_points")
    assert {p.sport_key for p in filtered.props} == {"nfl"}
    assert len(filtered.props) == 3


def test_filter_date_windows(slate: dict[str, Any]) -> None:
    feed = _build(slate)
    for window in ("today", "tomorrow", "weekend"):
        filtered = filter_market_browser_feed(feed, date_window=window)
        assert filtered.props
        assert all(p.date_window == window for p in filtered.props)
    weekend = filter_market_browser_feed(feed, date_window="weekend")
    assert {p.player_name for p in weekend.props} == {
        "Derrick Henry",
        "Lamar Jackson",
        "James Cook",
    }


def test_filter_search_query(slate: dict[str, Any]) -> None:
    feed = _build(slate)
    by_player = filter_market_browser_feed(feed, query="tatum")
    assert {p.player_name for p in by_player.props} == {"Jayson Tatum"}
    by_team = filter_market_browser_feed(feed, query="BUF")
    assert {p.player_name for p in by_team.props} == {"James Cook"}


def test_filter_empty_result(slate: dict[str, Any]) -> None:
    feed = _build(slate)
    filtered = filter_market_browser_feed(
        feed, sport="nba", date_window="weekend", market="player_points"
    )
    assert filtered.props == []


def test_filter_rejects_unknown_sport_or_window(slate: dict[str, Any]) -> None:
    feed = _build(slate)
    with pytest.raises(MarketBrowserError):
        filter_market_browser_feed(feed, sport="mlb")
    with pytest.raises(MarketBrowserError):
        filter_market_browser_feed(feed, date_window="next_month")


# ---------------------------------------------------------------------------
# Redis caching
# ---------------------------------------------------------------------------


def test_markets_browser_key_helper() -> None:
    assert markets_browser_key() == "markets:browser:all"
    assert markets_browser_key("all") == "markets:browser:all"
    assert markets_browser_key("nfl") == "markets:browser:nfl"
    assert markets_browser_key("americanfootball_nfl") == "markets:browser:nfl"
    assert markets_browser_key("basketball_nba") == "markets:browser:nba"


def test_sync_market_browser_to_redis_ttl_and_payload(slate: dict[str, Any]) -> None:
    feed = _build(slate)
    redis = MockRedis()
    sync_market_browser_to_redis(feed, redis)

    for key in ("markets:browser:all", "markets:browser:nfl", "markets:browser:nba"):
        assert key in redis.store
        assert redis.ttls[key] == 45

    payload_all = json.loads(redis.store["markets:browser:all"])
    assert payload_all["sportKey"] == "all"
    assert payload_all["generatedAt"] == "2026-11-11T15:00:00Z"
    first = payload_all["props"][0]
    assert first["playerName"] == "Jayson Tatum"
    assert first["hybridValueScore"] == 85
    assert first["isHighValue"] is True
    assert first["offeredDecimalOdds"] == "1.9000"
    assert first["commenceTime"].endswith("Z")
    assert first["weatherBadge"]["badgeType"] == "DOME"
    assert "Stale Line" not in redis.store["markets:browser:all"]
    assert "Outlier Guy" not in redis.store["markets:browser:all"]

    payload_nfl = json.loads(redis.store["markets:browser:nfl"])
    assert payload_nfl["sportKey"] == "nfl"
    assert {p["sportKey"] for p in payload_nfl["props"]} == {"nfl"}
    assert {g["sportKey"] for g in payload_nfl["games"]} == {"nfl"}

    payload_nba = json.loads(redis.store["markets:browser:nba"])
    assert {p["sportKey"] for p in payload_nba["props"]} == {"nba"}


# ---------------------------------------------------------------------------
# Celery task integration
# ---------------------------------------------------------------------------


class _FakeScalarResult:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def all(self) -> list[Any]:
        return self._rows


class _FakeSession:
    """Minimal Session double that dispatches select() by entity type."""

    def __init__(self, props: list[PlayerProp], events: list[Event], teams: list[Team]) -> None:
        self._data: dict[type, list[Any]] = {PlayerProp: props, Event: events, Team: teams}
        self.closed = False

    def scalars(self, stmt: Any) -> _FakeScalarResult:
        entity = stmt.column_descriptions[0]["entity"]
        rows = list(self._data[entity])
        if entity is PlayerProp:
            rows = [r for r in rows if r.status == "ACTIVE"]
        return _FakeScalarResult(rows)

    def close(self) -> None:
        self.closed = True


def test_celery_sync_market_browser_feed_task(slate: dict[str, Any]) -> None:
    from parlaypal_worker.celery_app import sync_market_browser_feed

    # Shift the slate relative to wall-clock now since the task uses datetime.now(UTC).
    real_now = datetime.now(UTC)
    shift = real_now - NOW_UTC
    for event in slate["events_map"].values():
        event.commence_time = event.commence_time + shift

    session = _FakeSession(
        props=slate["props"],
        events=list(slate["events_map"].values()),
        teams=list(slate["teams_map"].values()),
    )
    redis = MockRedis()
    result = sync_market_browser_feed(session=session, redis_client=redis)

    assert result["status"] == "ok"
    assert result["props_cached"] >= 1
    assert result["generated_at"].endswith("Z")
    for key in ("markets:browser:all", "markets:browser:nfl", "markets:browser:nba"):
        assert redis.ttls[key] == 45
    cached = redis.store["markets:browser:all"]
    assert "Stale Line" not in cached
    assert "Outlier Guy" not in cached
    assert "Live Player" not in cached
    assert session.closed is False  # caller-owned session is not closed
