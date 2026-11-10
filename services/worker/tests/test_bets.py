"""Unit tests for UserBet persistence with legs_json, status transitions, and query filtering."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import create_engine

from parlaypal_worker.bets import (
    BetNotFoundError,
    InvalidBetError,
    confirm_staged_user_bet,
    create_user_bet,
    delete_user_bet,
    get_user_bet,
    list_user_bets,
    settle_user_bet,
)
from parlaypal_worker.db import create_session_factory, init_db
from parlaypal_worker.models import Event, Team


@pytest.fixture
def db_session():
    """Create in-memory SQLite database and test session."""
    engine = create_engine("sqlite:///:memory:")
    init_db(engine=engine)
    session_factory = create_session_factory(engine)
    session = session_factory()
    try:
        # Seed test team and event for foreign keys
        home_team = Team(
            external_provider_id="papi_nfl_kc",
            sport_key="americanfootball_nfl",
            name="Kansas City Chiefs",
            abbreviation="KC",
        )
        away_team = Team(
            external_provider_id="papi_nfl_bal",
            sport_key="americanfootball_nfl",
            name="Baltimore Ravens",
            abbreviation="BAL",
        )
        session.add_all([home_team, away_team])
        session.flush()

        test_event = Event(
            external_provider_id="papi_nfl_2026_w1_bal_kc",
            sport_key="americanfootball_nfl",
            home_team_id=home_team.team_id,
            away_team_id=away_team.team_id,
            commence_time=datetime(2026, 9, 10, 0, 20, tzinfo=UTC),
            status="SCHEDULED",
        )
        session.add(test_event)
        session.commit()

        yield session, test_event
    finally:
        session.close()
        engine.dispose()


def test_create_user_bet_with_legs_json(db_session):
    session, test_event = db_session
    user_id = uuid.uuid4()
    legs_data = [
        {
            "propId": "prop-1",
            "playerName": "Patrick Mahomes",
            "marketDisplay": "Pass Yds Over 274.5",
            "offeredDecimalOdds": "1.91",
            "selection": "OVER",
            "guardedEv": 0.042,
        },
        {
            "propId": "prop-2",
            "playerName": "Lamar Jackson",
            "marketDisplay": "Rush Yds Over 54.5",
            "offeredDecimalOdds": "1.87",
            "selection": "OVER",
            "guardedEv": 0.038,
        },
    ]

    bet = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("3.5717"),
        event_id=test_event.event_id,
        user_id=user_id,
        stake_amount=Decimal("50.00"),
        status="STAGED",
        legs_json=legs_data,
    )

    assert bet.bet_id is not None
    assert bet.user_id == user_id
    assert bet.sportsbook == "DraftKings"
    assert bet.decimal_odds == Decimal("3.5717")
    assert bet.status == "STAGED"
    assert bet.legs_json == legs_data

    # Retrieve and verify persistence
    retrieved = get_user_bet(session, bet.bet_id)
    assert retrieved is not None
    assert retrieved.legs_json is not None
    assert len(retrieved.legs_json) == 2
    assert retrieved.legs_json[0]["playerName"] == "Patrick Mahomes"


def test_create_user_bet_validation_and_bounds(db_session):
    session, test_event = db_session

    # Invalid decimal odds < 1.01
    with pytest.raises(InvalidBetError, match="must satisfy 1.01 <= D <= 9999.9999"):
        create_user_bet(
            session,
            sportsbook="FanDuel",
            decimal_odds=Decimal("0.95"),
            event_id=test_event.event_id,
        )

    # Invalid decimal odds > 9999.9999
    with pytest.raises(InvalidBetError, match="must satisfy 1.01 <= D <= 9999.9999"):
        create_user_bet(
            session,
            sportsbook="FanDuel",
            decimal_odds=Decimal("10000.00"),
            event_id=test_event.event_id,
        )

    # Negative stake
    with pytest.raises(InvalidBetError, match="Stake amount cannot be negative"):
        create_user_bet(
            session,
            sportsbook="FanDuel",
            decimal_odds=Decimal("2.50"),
            event_id=test_event.event_id,
            stake_amount=Decimal("-10.00"),
        )

    # Outlier EV > 10.0%
    outlier_leg = [
        {
            "propId": "prop-bad",
            "playerName": "Unknown",
            "guardedEv": 0.155,
        }
    ]
    with pytest.raises(InvalidBetError, match="EV > 10.0%"):
        create_user_bet(
            session,
            sportsbook="FanDuel",
            decimal_odds=Decimal("2.50"),
            event_id=test_event.event_id,
            legs_json=outlier_leg,
        )


def test_confirm_staged_user_bet(db_session):
    session, test_event = db_session
    bet = create_user_bet(
        session,
        sportsbook="FanDuel",
        decimal_odds=Decimal("2.80"),
        event_id=test_event.event_id,
        stake_amount=Decimal("0.00"),
        status="STAGED",
    )

    # Rejects zero or negative stake
    with pytest.raises(InvalidBetError, match="must be greater than"):
        confirm_staged_user_bet(session, bet.bet_id, Decimal("0.00"))

    with pytest.raises(InvalidBetError, match="must be greater than"):
        confirm_staged_user_bet(session, bet.bet_id, Decimal("-25.00"))

    # Confirms successfully
    confirmed = confirm_staged_user_bet(session, bet.bet_id, Decimal("25.00"))
    assert confirmed.status == "PENDING"
    assert confirmed.stake_amount == Decimal("25.00")
    assert confirmed.placed_at is not None

    # Cannot confirm a bet that is already PENDING
    with pytest.raises(InvalidBetError, match="Cannot confirm non-staged bet"):
        confirm_staged_user_bet(session, bet.bet_id, Decimal("30.00"))

    # BetNotFoundError on non-existent bet
    with pytest.raises(BetNotFoundError):
        confirm_staged_user_bet(session, uuid.uuid4(), Decimal("10.00"))


def test_settle_user_bet_and_prevent_re_settle(db_session):
    session, test_event = db_session
    bet = create_user_bet(
        session,
        sportsbook="BetMGM",
        decimal_odds=Decimal("4.00"),
        event_id=test_event.event_id,
        stake_amount=Decimal("50.00"),
        status="PENDING",
    )

    # Settle to WON
    settled = settle_user_bet(
        session,
        bet.bet_id,
        outcome="WON",
        closing_decimal_odds=Decimal("3.80"),
        closing_fair_prob=Decimal("0.285"),
        clv_percentage=Decimal("14.0"),
    )

    assert settled.status == "WON"
    assert settled.settled_at is not None
    assert settled.closing_decimal_odds == Decimal("3.8000")
    assert settled.clv_percentage == Decimal("14.000")

    # Re-settling should raise InvalidBetError
    with pytest.raises(InvalidBetError, match="Cannot re-settle an already finalized bet"):
        settle_user_bet(session, bet.bet_id, outcome="LOST")

    # Closing odds < 1.01 should raise InvalidBetError
    bet2 = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("2.00"),
        event_id=None,  # Nullable event_id test
        stake_amount=Decimal("10.00"),
        status="PENDING",
    )
    with pytest.raises(InvalidBetError, match="must satisfy D >= 1.01"):
        settle_user_bet(session, bet2.bet_id, outcome="WON", closing_decimal_odds=Decimal("0.90"))


def test_list_user_bets_filtering_and_order(db_session):
    session, test_event = db_session
    user_a = uuid.uuid4()
    user_b = uuid.uuid4()

    bet_a1 = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("2.00"),
        event_id=test_event.event_id,
        user_id=user_a,
        status="STAGED",
        placed_at=datetime(2026, 11, 10, 10, 0, tzinfo=UTC),
    )
    bet_a2 = create_user_bet(
        session,
        sportsbook="DraftKings",
        decimal_odds=Decimal("3.00"),
        event_id=test_event.event_id,
        user_id=user_a,
        status="PENDING",
        placed_at=datetime(2026, 11, 10, 11, 0, tzinfo=UTC),
    )
    bet_b1 = create_user_bet(
        session,
        sportsbook="FanDuel",
        decimal_odds=Decimal("1.90"),
        event_id=test_event.event_id,
        user_id=user_b,
        status="WON",
        placed_at=datetime(2026, 11, 10, 12, 0, tzinfo=UTC),
    )

    # List all for user_a
    user_a_bets = list_user_bets(session, user_id=user_a)
    assert len(user_a_bets) == 2
    # Ordered by placed_at desc
    assert user_a_bets[0].bet_id == bet_a2.bet_id
    assert user_a_bets[1].bet_id == bet_a1.bet_id

    # Filter by status
    staged_bets = list_user_bets(session, user_id=user_a, status="staged")
    assert len(staged_bets) == 1
    assert staged_bets[0].bet_id == bet_a1.bet_id

    pending_bets = list_user_bets(session, status="pending")
    assert len(pending_bets) == 1
    assert pending_bets[0].bet_id == bet_a2.bet_id

    won_bets = list_user_bets(session, status="won")
    assert len(won_bets) == 1
    assert won_bets[0].bet_id == bet_b1.bet_id


def test_delete_user_bet(db_session):
    session, test_event = db_session
    bet = create_user_bet(
        session,
        sportsbook="Caesars",
        decimal_odds=Decimal("2.20"),
        event_id=test_event.event_id,
        status="STAGED",
    )

    assert delete_user_bet(session, bet.bet_id) is True
    assert get_user_bet(session, bet.bet_id) is None
    # Deleting again returns False
    assert delete_user_bet(session, bet.bet_id) is False
