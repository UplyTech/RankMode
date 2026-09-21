"""The ranked engine: a match goes in, a new state comes out.

Everything else in this half of the library is a piece - a rating formula, a
ladder bracket, a season reset. This is the one object a caller actually holds,
and it does for competitive play exactly what :class:`~rankmode.engine.RankEngine`
does for participation XP: takes the state you stored, takes what happened, and
hands back a new state and a description of what changed.

The order of operations is fixed and part of the public contract, because a
different order produces different numbers:

1. the season is checked - a state from an old season is reset before anything
   else touches it
2. the rating is updated by the configured system
3. placements are counted, and a player still in them gets no visible rank
4. the ladder position moves, unless placements are still running
5. streaks are updated
6. the peak is recorded, because rewards are based on it

Nothing here reads a clock or a random generator. ``now`` is a parameter for
the same reason it is one everywhere else in this library: a season boundary
that depends on the wall clock cannot be tested.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from .constants import PERMILLE_ONE
from .errors import ConfigurationError, ValidationError
from .ladder import (
    Division,
    LadderChange,
    LadderConfig,
    LadderOutcome,
    LadderPosition,
    Tier,
    apply_league_points,
    position_for_rating,
)
from .rating import (
    EloConfig,
    Glicko2Config,
    MatchOutcome,
    Rating,
    RatingSystem,
    create_rating,
    expected_score_permille,
    update_elo,
    update_glicko2,
)
from .season import Season, SeasonResetConfig, SeasonSummary, reset_rating

__all__ = [
    "RankedConfig",
    "RankedState",
    "MatchResult",
    "RankedEngine",
    "create_ranked_state",
    "clone_ranked_state",
    "serialize_ranked_state",
    "deserialize_ranked_state",
]


@dataclass(frozen=True)
class RankedConfig:
    """Everything a ranked engine needs, validated once at construction."""

    #: Which rating formula. Glicko-2 by default; see :mod:`rankmode.rating`.
    system: RatingSystem = RatingSystem.GLICKO2
    elo: EloConfig = field(default_factory=EloConfig)
    glicko2: Glicko2Config = field(default_factory=Glicko2Config)
    ladder: LadderConfig = field(default_factory=LadderConfig)
    reset: SeasonResetConfig = field(default_factory=SeasonResetConfig)
    #: The current season. ``None`` means the ladder has no seasons, which is a
    #: valid choice for a small community.
    season: Season | None = None
    #: How many matches a player plays before they are given a rank. During
    #: placements the rating moves normally and the ladder does not - showing
    #: somebody Bronze after one loss is how a ladder loses a player on their
    #: first evening.
    placement_matches: int = 10
    #: Consecutive wins before a streak bonus applies. ``0`` switches streaks
    #: off, which is right for any ladder that takes its rating seriously:
    #: a streak bonus is a deliberate distortion of the maths in exchange for
    #: the ladder feeling responsive.
    streak_threshold: int = 3
    #: Extra League Points per win once a streak is running, per win beyond the
    #: threshold, capped by ``max_streak_bonus``.
    streak_bonus_points: int = 2
    max_streak_bonus: int = 10

    def __post_init__(self) -> None:
        if self.placement_matches < 0:
            raise ConfigurationError(
                "placement_matches cannot be negative",
                placement_matches=self.placement_matches,
            )
        if self.streak_threshold < 0:
            raise ConfigurationError(
                "streak_threshold cannot be negative",
                streak_threshold=self.streak_threshold,
            )
        if self.streak_bonus_points < 0 or self.max_streak_bonus < 0:
            raise ConfigurationError("A streak bonus cannot be negative")


@dataclass
class RankedState:
    """Everything the engine needs to know about one player.

    Mutable, like :class:`~rankmode.types.MemberState`, and for the same
    reason: the caller loads it from a database, hands it in, and stores the
    copy that comes back. The engine never modifies the instance it is given.
    """

    rating: Rating = field(default_factory=create_rating)
    #: ``None`` until placements are finished.
    position: LadderPosition | None = None
    #: Which season this state belongs to. A state from an older season is
    #: reset on the next match rather than trusted.
    season_id: str | None = None
    #: Matches played this season, which is what placements count.
    season_matches: int = 0
    wins: int = 0
    losses: int = 0
    draws: int = 0
    #: Consecutive wins, or negative for consecutive losses.
    streak: int = 0
    #: The highest rating and position reached this season. Rewards are based
    #: on these, not on where the player finishes.
    peak_rating: int = 0
    peak_position: LadderPosition | None = None
    #: Matches since the last promotion, for demotion protection.
    matches_since_promotion: int = 999
    #: Epoch milliseconds of the last ranked match, so a caller can apply
    #: inactivity rules without keeping a second record.
    last_match_at: int | None = None


def create_ranked_state(rating: Rating | None = None) -> RankedState:
    """A state for a player who has never played a ranked match."""
    start = rating if rating is not None else create_rating()
    return RankedState(rating=start, peak_rating=start.rating)


def clone_ranked_state(state: RankedState) -> RankedState:
    """Deep copy. The engine never mutates the state it is handed."""
    return RankedState(
        rating=state.rating,
        position=state.position,
        season_id=state.season_id,
        season_matches=state.season_matches,
        wins=state.wins,
        losses=state.losses,
        draws=state.draws,
        streak=state.streak,
        peak_rating=state.peak_rating,
        peak_position=state.peak_position,
        matches_since_promotion=state.matches_since_promotion,
        last_match_at=state.last_match_at,
    )


@dataclass(frozen=True)
class MatchResult:
    """What one match did."""

    outcome: MatchOutcome
    previous_rating: Rating
    new_rating: Rating
    #: Signed change in rating points.
    rating_delta: int
    #: What the ladder did, or ``None`` while placements are running.
    ladder: LadderChange | None
    #: ``True`` while the player is still in placements.
    in_placements: bool
    #: How many placement matches are left.
    placements_remaining: int
    #: The chance the player had of winning, in permille. Useful for a post-match
    #: screen, and for a caller who wants to detect an unbalanced queue.
    expected_permille: int
    #: The streak after this match. Positive for wins, negative for losses.
    streak: int
    #: The new state. Persist this; the input state is untouched.
    state: RankedState
    #: True when the season changed and the state was reset before the match.
    season_reset: bool = False


class RankedEngine:
    """Competitive ranking: rating, ladder, seasons and placements in one object."""

    def __init__(self, config: RankedConfig | None = None) -> None:
        self.config = config if config is not None else RankedConfig()

    # -- queries ----------------------------------------------------------

    def expected(self, player: RankedState, opponent: RankedState) -> int:
        """The player's chance of winning, in permille."""
        return expected_score_permille(player.rating, opponent.rating, self.config.system)

    def position_of(self, state: RankedState) -> LadderPosition | None:
        """Where the player currently stands, or ``None`` during placements."""
        return state.position

    def preview_position(self, state: RankedState) -> LadderPosition:
        """Where the player's rating says they belong, placements or not.

        The number a placement screen shows as "you are on track for ...". It
        is deliberately not the same as :meth:`position_of`, which is ``None``
        until placements finish.
        """
        return position_for_rating(state.rating.rating, self.config.ladder)

    def is_in_placements(self, state: RankedState) -> bool:
        return state.season_matches < self.config.placement_matches

    # -- state changes ----------------------------------------------------

    def record_match(
        self,
        state: RankedState,
        opponent: Rating,
        outcome: MatchOutcome,
        now: int,
    ) -> MatchResult:
        """Record one ranked match and return the new state.

        ``opponent`` is a rating rather than a state, because the engine needs
        nothing else about them: their ladder position, their season and their
        streak are their own business, and asking for them would make a
        two-player call need two full states.
        """
        if not isinstance(now, int) or isinstance(now, bool):
            raise ValidationError(
                "now must be an epoch-millisecond timestamp as an integer", now=now
            )

        working, was_reset = self._apply_season(state)
        previous_rating = working.rating
        expected = expected_score_permille(previous_rating, opponent, self.config.system)

        new_rating = self._update_rating(previous_rating, opponent, outcome)

        nxt = clone_ranked_state(working)
        nxt.rating = new_rating
        nxt.season_matches = working.season_matches + 1
        nxt.last_match_at = now
        nxt.streak = _next_streak(working.streak, outcome)

        if outcome is MatchOutcome.WIN:
            nxt.wins += 1
        elif outcome is MatchOutcome.LOSS:
            nxt.losses += 1
        else:
            nxt.draws += 1

        in_placements = nxt.season_matches < self.config.placement_matches
        ladder_change: LadderChange | None = None

        if in_placements:
            # No visible rank yet. The rating still moved, and that is what
            # decides where the player lands when placements finish.
            nxt.position = None
        elif working.position is None:
            # Placements just ended: seed the position from the rating.
            nxt.position = position_for_rating(new_rating.rating, self.config.ladder)
            nxt.matches_since_promotion = 0
        else:
            ladder_change = self._move_ladder(working, nxt, outcome)
            nxt.position = ladder_change.current
            if ladder_change.outcome in (
                LadderOutcome.PROMOTED_TIER,
                LadderOutcome.PROMOTED_DIVISION,
            ):
                nxt.matches_since_promotion = 0
            else:
                nxt.matches_since_promotion = working.matches_since_promotion + 1

        if new_rating.rating > nxt.peak_rating:
            nxt.peak_rating = new_rating.rating
        if nxt.position is not None:
            from .ladder import compare_positions

            if (
                nxt.peak_position is None
                or compare_positions(nxt.position, nxt.peak_position) > 0
            ):
                nxt.peak_position = nxt.position

        return MatchResult(
            outcome=outcome,
            previous_rating=previous_rating,
            new_rating=new_rating,
            rating_delta=new_rating.rating - previous_rating.rating,
            ladder=ladder_change,
            in_placements=in_placements,
            placements_remaining=max(0, self.config.placement_matches - nxt.season_matches),
            expected_permille=expected,
            streak=nxt.streak,
            state=nxt,
            season_reset=was_reset,
        )

    def record_period(
        self,
        state: RankedState,
        results: list[tuple[Rating, MatchOutcome]],
        now: int,
    ) -> MatchResult:
        """Record a whole rating period at once.

        Glicko-2 is defined over a period rather than a match, and applying a
        week's results together is both more accurate and what Glickman
        intended. The ladder still moves once per match, in the order given,
        because a ladder is a running display and cannot be batched.

        An empty list is not an error: it is the case Glicko-2 has an answer
        for, a player who did not play, whose deviation widens on its own.
        """
        if not results:
            working, was_reset = self._apply_season(state)
            nxt = clone_ranked_state(working)
            nxt.rating = update_glicko2(working.rating, [], self.config.glicko2)
            return MatchResult(
                outcome=MatchOutcome.DRAW,
                previous_rating=working.rating,
                new_rating=nxt.rating,
                rating_delta=nxt.rating.rating - working.rating.rating,
                ladder=None,
                in_placements=self.is_in_placements(nxt),
                placements_remaining=max(
                    0, self.config.placement_matches - nxt.season_matches
                ),
                expected_permille=PERMILLE_ONE // 2,
                streak=nxt.streak,
                state=nxt,
                season_reset=was_reset,
            )

        result = None
        current = state
        for opponent, outcome in results:
            result = self.record_match(current, opponent, outcome, now)
            current = result.state
        assert result is not None
        return result

    def summarise(self, state: RankedState) -> SeasonSummary:
        """The season summary a rewards screen needs."""
        return SeasonSummary(
            season_id=state.season_id or "",
            matches_played=state.season_matches,
            wins=state.wins,
            losses=state.losses,
            draws=state.draws,
            peak_rating=state.peak_rating,
            final_rating=state.rating.rating,
            peak_position=state.peak_position,
            final_position=state.position,
        )

    def start_season(self, state: RankedState, season: Season) -> RankedState:
        """Carry a player into a new season explicitly.

        ``record_match`` does this on its own when it sees a state from an old
        season. This method exists for the caller who wants to run the reset for
        everybody at a fixed moment rather than lazily on each player's first
        match - which is what a ladder with a leaderboard has to do, because the
        leaderboard is wrong until everybody has been reset.
        """
        fresh = clone_ranked_state(state)
        fresh.rating = reset_rating(state.rating, self.config.reset)
        fresh.position = None
        fresh.season_id = season.id
        fresh.season_matches = 0
        fresh.wins = fresh.losses = fresh.draws = 0
        fresh.streak = 0
        fresh.peak_rating = fresh.rating.rating
        fresh.peak_position = None
        fresh.matches_since_promotion = 999
        return fresh

    # -- internals --------------------------------------------------------

    def _apply_season(self, state: RankedState) -> tuple[RankedState, bool]:
        """Reset the state if it belongs to a season that is over."""
        season = self.config.season
        if season is None:
            return state, False
        if state.season_id == season.id:
            return state, False
        return self.start_season(state, season), state.season_id is not None

    def _update_rating(
        self, rating: Rating, opponent: Rating, outcome: MatchOutcome
    ) -> Rating:
        if self.config.system is RatingSystem.ELO:
            return update_elo(rating, opponent, outcome, self.config.elo)
        return update_glicko2(rating, [(opponent, outcome)], self.config.glicko2)

    def _move_ladder(
        self, previous: RankedState, nxt: RankedState, outcome: MatchOutcome
    ) -> LadderChange:
        """Move the ladder, including any streak bonus."""
        position = previous.position
        assert position is not None  # guarded by the caller

        if outcome is MatchOutcome.DRAW:
            # A draw moves the rating and leaves the ladder alone. Splitting a
            # League Point in half would be worse than not moving.
            return LadderChange(
                outcome=LadderOutcome.UNCHANGED,
                previous=position,
                current=position,
                points_delta=0,
                tier_changed=False,
                series_active=position.series is not None,
            )

        won = outcome is MatchOutcome.WIN
        change = apply_league_points(
            position,
            won,
            nxt.rating.rating,
            self.config.ladder,
            previous.matches_since_promotion,
        )

        bonus = self._streak_bonus(nxt.streak) if won else 0
        if bonus == 0 or change.current.series is not None:
            return change

        # The bonus is applied as a second, smaller move so that it can carry a
        # player across a boundary the base gain did not reach.
        boosted = apply_league_points(
            change.current,
            True,
            nxt.rating.rating,
            replace(
                self.config.ladder,
                base_points_gain=bonus,
                adjustment_span_permille=0,
            ),
            0,
        )
        return LadderChange(
            outcome=(
                boosted.outcome
                if boosted.outcome is not LadderOutcome.UNCHANGED
                else change.outcome
            ),
            previous=position,
            current=boosted.current,
            points_delta=change.points_delta + boosted.points_delta,
            tier_changed=change.tier_changed or boosted.tier_changed,
            series_active=boosted.series_active,
        )

    def _streak_bonus(self, streak: int) -> int:
        settings = self.config
        if settings.streak_threshold == 0 or streak < settings.streak_threshold:
            return 0
        beyond = streak - settings.streak_threshold + 1
        return min(settings.max_streak_bonus, beyond * settings.streak_bonus_points)


def _next_streak(streak: int, outcome: MatchOutcome) -> int:
    """The streak after one match.

    A draw breaks a streak rather than continuing it. A run of wins interrupted
    by a draw is not a run of wins, and treating it as one makes the bonus feel
    arbitrary.
    """
    if outcome is MatchOutcome.WIN:
        return streak + 1 if streak > 0 else 1
    if outcome is MatchOutcome.LOSS:
        return streak - 1 if streak < 0 else -1
    return 0


# ---------------------------------------------------------------------------
# Serialisation
# ---------------------------------------------------------------------------
def serialize_ranked_state(state: RankedState) -> dict[str, Any]:
    """Plain-dict form, ready for :func:`json.dumps`.

    The JSON field names are camelCase, matching every other serialised shape
    in this library, so a bot ported between the editions keeps its data.
    """
    return {
        "rating": {
            "rating": state.rating.rating,
            "deviation": state.rating.deviation,
            "volatility": state.rating.volatility,
            "matchesPlayed": state.rating.matches_played,
        },
        "position": _serialize_position(state.position),
        "seasonId": state.season_id,
        "seasonMatches": state.season_matches,
        "wins": state.wins,
        "losses": state.losses,
        "draws": state.draws,
        "streak": state.streak,
        "peakRating": state.peak_rating,
        "peakPosition": _serialize_position(state.peak_position),
        "matchesSincePromotion": state.matches_since_promotion,
        "lastMatchAt": state.last_match_at,
    }


def _serialize_position(position: LadderPosition | None) -> dict[str, Any] | None:
    if position is None:
        return None
    return {
        "tier": position.tier.value,
        "division": position.division.value if position.division else None,
        "leaguePoints": position.league_points,
        "series": (
            None
            if position.series is None
            else {
                "winsNeeded": position.series.wins_needed,
                "lossesAllowed": position.series.losses_allowed,
                "wins": position.series.wins,
                "losses": position.series.losses,
            }
        ),
    }


def deserialize_ranked_state(raw: dict[str, Any]) -> RankedState:
    """Rebuild a state from stored data.

    Missing fields take their empty defaults, so a row written by an older
    version of the calling bot still loads.
    """
    if not isinstance(raw, dict):
        raise ValidationError("A ranked state must be a mapping", received=type(raw).__name__)

    rating_raw = raw.get("rating") or {}
    rating = create_rating(
        rating=_int_field(rating_raw, "rating", 1500),
        deviation=_int_field(rating_raw, "deviation", 350),
        volatility=_int_field(rating_raw, "volatility", 60_000),
        matches_played=_int_field(rating_raw, "matchesPlayed", 0),
    )

    return RankedState(
        rating=rating,
        position=_deserialize_position(raw.get("position")),
        season_id=raw.get("seasonId"),
        season_matches=_int_field(raw, "seasonMatches", 0),
        wins=_int_field(raw, "wins", 0),
        losses=_int_field(raw, "losses", 0),
        draws=_int_field(raw, "draws", 0),
        streak=_int_field(raw, "streak", 0),
        peak_rating=_int_field(raw, "peakRating", rating.rating),
        peak_position=_deserialize_position(raw.get("peakPosition")),
        matches_since_promotion=_int_field(raw, "matchesSincePromotion", 999),
        last_match_at=raw.get("lastMatchAt"),
    )


def _deserialize_position(raw: object) -> LadderPosition | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValidationError("A ladder position must be a mapping")
    from .ladder import SeriesState

    series_raw = raw.get("series")
    series = None
    if series_raw is not None:
        if not isinstance(series_raw, dict):
            raise ValidationError("A promotion series must be a mapping")
        series = SeriesState(
            wins_needed=_int_field(series_raw, "winsNeeded", 3),
            losses_allowed=_int_field(series_raw, "lossesAllowed", 2),
            wins=_int_field(series_raw, "wins", 0),
            losses=_int_field(series_raw, "losses", 0),
        )

    division_value = raw.get("division")
    return LadderPosition(
        tier=Tier(raw["tier"]),
        division=Division(division_value) if division_value is not None else None,
        league_points=_int_field(raw, "leaguePoints", 0),
        series=series,
    )


def _int_field(raw: dict[str, Any], key: str, default: int) -> int:
    value = raw.get(key, default)
    if value is None:
        return default
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValidationError(f"{key} must be an integer", **{key: value})
    return value
