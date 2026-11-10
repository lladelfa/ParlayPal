"""Worker persistence helpers for user bets and CLV ledger in PostgreSQL."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from parlaypal_worker.models import UserBet

logger = logging.getLogger(__name__)

VALID_STATUSES = {
    "STAGED",
    "staged",
    "PENDING",
    "pending",
    "WON",
    "won",
    "LOST",
    "lost",
    "PUSH",
    "push",
    "VOID",
    "void",
    "settled_won",
    "settled_lost",
}

FINAL_STATUSES = {
    "WON",
    "won",
    "LOST",
    "lost",
    "PUSH",
    "push",
    "VOID",
    "void",
    "settled_won",
    "settled_lost",
}


class InvalidBetError(ValueError):
    """Raised when bet data violates domain invariants or bounds."""


class BetNotFoundError(KeyError):
    """Raised when a specified bet is not found in the persistence store."""


def _ensure_uuid(val: uuid.UUID | str | None) -> uuid.UUID | None:
    if val is None:
        return None
    if isinstance(val, uuid.UUID):
        return val
    try:
        return uuid.UUID(str(val))
    except (ValueError, TypeError, AttributeError):
        return None


def create_user_bet(
    session: Session,
    *,
    sportsbook: str,
    decimal_odds: Decimal | float | str,
    event_id: uuid.UUID | str | None = None,
    user_id: uuid.UUID | str | None = None,
    bet_id: uuid.UUID | str | None = None,
    prop_id: uuid.UUID | str | None = None,
    external_provider_id: str | None = None,
    stake_amount: Decimal | float | str = Decimal("0.00"),
    status: str = "PENDING",
    legs_json: list[dict[str, Any]] | None = None,
    placed_at: datetime | None = None,
    commit: bool = True,
) -> UserBet:
    """Create and persist a new UserBet record with validation."""
    if not sportsbook or not sportsbook.strip():
        raise InvalidBetError("Sportsbook name is required.")

    try:
        dec_odds = Decimal(str(decimal_odds))
    except Exception as exc:
        raise InvalidBetError(f"Invalid decimal odds: {decimal_odds}") from exc

    if not dec_odds.is_finite() or dec_odds < Decimal("1.01") or dec_odds > Decimal("9999.9999"):
        raise InvalidBetError(f"Decimal odds ({dec_odds}) must satisfy 1.01 <= D <= 9999.9999.")

    try:
        stake = Decimal(str(stake_amount))
    except Exception as exc:
        raise InvalidBetError(f"Invalid stake amount: {stake_amount}") from exc

    if stake < Decimal("0.00"):
        raise InvalidBetError(f"Stake amount cannot be negative: {stake}")

    norm_status = status.strip()
    if norm_status not in VALID_STATUSES:
        raise InvalidBetError(f"Invalid bet status: {status}")

    # Check for outlier legs
    if legs_json:
        for leg in legs_json:
            ev = leg.get("guardedEv") or leg.get("ev") or leg.get("guarded_ev")
            if ev is not None:
                try:
                    ev_float = float(ev)
                except (ValueError, TypeError):
                    continue
                if ev_float > 0.10:
                    raise InvalidBetError(
                        f"Cannot persist suspect stale line: leg has EV > 10.0% ({ev_float:.3f})"
                    )

    resolved_bet_id = _ensure_uuid(bet_id) or uuid.uuid4()
    resolved_user_id = _ensure_uuid(user_id) or uuid.uuid4()
    resolved_event_id = _ensure_uuid(event_id)
    if event_id is not None and not resolved_event_id:
        raise InvalidBetError("Valid event_id UUID is required if provided.")

    resolved_prop_id = _ensure_uuid(prop_id)

    user_bet = UserBet(
        bet_id=resolved_bet_id,
        user_id=resolved_user_id,
        event_id=resolved_event_id,
        prop_id=resolved_prop_id,
        external_provider_id=external_provider_id,
        sportsbook=sportsbook.strip(),
        decimal_odds=dec_odds,
        stake_amount=stake,
        status=norm_status,
        legs_json=legs_json,
        placed_at=placed_at or datetime.now(UTC),
    )

    session.add(user_bet)
    if commit:
        session.commit()
        session.refresh(user_bet)
    else:
        session.flush()

    return user_bet


def get_user_bet(session: Session, bet_id: uuid.UUID | str) -> UserBet | None:
    """Retrieve a UserBet by primary key."""
    resolved_id = _ensure_uuid(bet_id)
    if not resolved_id:
        return None
    return session.get(UserBet, resolved_id)


def list_user_bets(
    session: Session,
    *,
    user_id: uuid.UUID | str | None = None,
    status: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[UserBet]:
    """Query user bets with optional user_id and status filters, ordered by placed_at DESC."""
    stmt = select(UserBet)
    if user_id is not None:
        resolved_user = _ensure_uuid(user_id)
        if resolved_user:
            stmt = stmt.where(UserBet.user_id == resolved_user)
    if status is not None:
        norm_status = status.strip()
        # Support case-insensitive or mapped status matching
        if norm_status.lower() in {"won", "settled_won"}:
            stmt = stmt.where(UserBet.status.in_(["WON", "won", "settled_won"]))
        elif norm_status.lower() in {"lost", "settled_lost"}:
            stmt = stmt.where(UserBet.status.in_(["LOST", "lost", "settled_lost"]))
        elif norm_status.lower() == "pending":
            stmt = stmt.where(UserBet.status.in_(["PENDING", "pending"]))
        elif norm_status.lower() == "staged":
            stmt = stmt.where(UserBet.status.in_(["STAGED", "staged"]))
        else:
            stmt = stmt.where(UserBet.status == norm_status)

    safe_limit = min(max(int(limit), 1), 1000)
    safe_offset = max(int(offset), 0)
    stmt = stmt.order_by(UserBet.placed_at.desc()).limit(safe_limit).offset(safe_offset)
    return list(session.scalars(stmt).all())


def confirm_staged_user_bet(
    session: Session,
    bet_id: uuid.UUID | str,
    stake_amount: Decimal | float | str,
    *,
    commit: bool = True,
) -> UserBet:
    """Transition a staged UserBet to pending with a confirmed stake amount."""
    user_bet = get_user_bet(session, bet_id)
    if not user_bet:
        raise BetNotFoundError(f"Bet with id {bet_id} not found.")

    if user_bet.status not in ("STAGED", "staged"):
        raise InvalidBetError(
            f"Cannot confirm non-staged bet. Current status is {user_bet.status}."
        )

    try:
        stake = Decimal(str(stake_amount))
    except Exception as exc:
        raise InvalidBetError(f"Invalid stake amount: {stake_amount}") from exc

    if stake <= Decimal("0.00"):
        raise InvalidBetError(f"Confirmed stake amount must be greater than $0.00, got: {stake}")

    user_bet.status = "PENDING"
    user_bet.stake_amount = stake
    user_bet.placed_at = datetime.now(UTC)

    if commit:
        session.commit()
        session.refresh(user_bet)
    else:
        session.flush()

    return user_bet


def settle_user_bet(
    session: Session,
    bet_id: uuid.UUID | str,
    outcome: str,
    *,
    settled_at: datetime | None = None,
    closing_decimal_odds: Decimal | float | str | None = None,
    closing_fair_prob: Decimal | float | str | None = None,
    clv_percentage: Decimal | float | str | None = None,
    commit: bool = True,
) -> UserBet:
    """Transition a pending UserBet to a finalized settlement status (WON, LOST, PUSH, VOID)."""
    user_bet = get_user_bet(session, bet_id)
    if not user_bet:
        raise BetNotFoundError(f"Bet with id {bet_id} not found.")

    if user_bet.status in FINAL_STATUSES:
        raise InvalidBetError(
            f"Cannot re-settle an already finalized bet with status: {user_bet.status}"
        )

    norm_outcome = outcome.strip()
    if norm_outcome not in FINAL_STATUSES:
        raise InvalidBetError(f"Invalid settlement outcome: {outcome}")

    user_bet.status = norm_outcome
    user_bet.settled_at = settled_at or datetime.now(UTC)

    if closing_decimal_odds is not None:
        try:
            dec_close = Decimal(str(closing_decimal_odds))
        except Exception as exc:
            raise InvalidBetError(f"Invalid closing decimal odds: {closing_decimal_odds}") from exc
        if not dec_close.is_finite() or dec_close < Decimal("1.01"):
            raise InvalidBetError(f"Closing decimal odds ({dec_close}) must satisfy D >= 1.01.")
        user_bet.closing_decimal_odds = dec_close
    if closing_fair_prob is not None:
        user_bet.closing_fair_prob = Decimal(str(closing_fair_prob))
    if clv_percentage is not None:
        user_bet.clv_percentage = Decimal(str(clv_percentage))

    if commit:
        session.commit()
        session.refresh(user_bet)
    else:
        session.flush()

    return user_bet


def delete_user_bet(
    session: Session,
    bet_id: uuid.UUID | str,
    *,
    commit: bool = True,
) -> bool:
    """Delete a UserBet record by bet_id."""
    user_bet = get_user_bet(session, bet_id)
    if not user_bet:
        return False

    session.delete(user_bet)
    if commit:
        session.commit()
    else:
        session.flush()

    return True
