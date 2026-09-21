"""RankMode -- experience points, levels and leaderboards, calculated, never stored.

One formula, one abuse guard, one behaviour, everywhere UplyTech awards points.
The library computes; where the points come from and where the new total is
written is the caller's decision.

    >>> from rankmode import RankEngine, create_event_rule, create_member_state
    >>> engine = RankEngine(rules=[create_event_rule("message", 15, 25, cooldown_seconds=60)])
    >>> state = create_member_state()
    >>> result = engine.award(state, "message", now=1_700_000_000_000, base_xp=20)
    >>> result.new_total_xp
    20
    >>> result.progress.level
    0

The result carries the new state; store it, and hand it back on the next call.
"""

from __future__ import annotations

from .constants import (
    DEFAULT_MAX_LEVEL,
    DEFAULT_PERIOD_SECONDS,
    GLOBAL_CAP_KEY,
    MAX_SUPPORTED_LEVEL,
    MAX_TOTAL_XP,
    MIN_TOTAL_XP,
    PERMILLE_ONE,
)
from .curves import (
    Curve,
    ExponentialCurve,
    LinearCurve,
    QuadraticCurve,
    TabularCurve,
    create_curve,
    default_curve,
)
from .engine import (
    RankConfig,
    RankEngine,
    apply_multipliers,
    combined_permille,
    create_event_rule,
    default_rules,
)
from .errors import (
    ConfigurationError,
    CurveError,
    LadderError,
    MigrationError,
    RankModeError,
    SeasonError,
    ValidationError,
    XpOverflowError,
)
from .fixed import (
    SCALE,
    fixed_div,
    fixed_exp,
    fixed_ln,
    fixed_mul,
    fixed_sqrt,
    from_fixed,
    isqrt,
    to_fixed,
)
from .ladder import (
    Division,
    LadderChange,
    LadderConfig,
    LadderOutcome,
    LadderPosition,
    SeriesState,
    Tier,
    apply_league_points,
    compare_positions,
    default_tiers,
    format_position,
    position_for_rating,
    rating_for_position,
)
from .leaderboard import build_leaderboard, page_count, paginate, rank_of
from .matchmaking import (
    MatchQuality,
    TeamSplit,
    balance_teams,
    is_acceptable,
    match_quality,
    team_rating,
)
from .migration import (
    MigrationReport,
    migrate_all,
    migrate_total_xp,
    preview_migration,
)
from .random_source import (
    FixedRandomSource,
    RandomSource,
    SeededRandomSource,
    SystemRandomSource,
)
from .ranked import (
    MatchResult,
    RankedConfig,
    RankedEngine,
    RankedState,
    clone_ranked_state,
    create_ranked_state,
    deserialize_ranked_state,
    serialize_ranked_state,
)
from .rating import (
    DEFAULT_DEVIATION,
    DEFAULT_RATING,
    DEFAULT_VOLATILITY,
    EloConfig,
    Glicko2Config,
    MatchOutcome,
    Rating,
    RatingSystem,
    create_rating,
    expected_score_permille,
    rating_interval,
    update_elo,
    update_glicko2,
)
from .season import (
    ResetPolicy,
    Season,
    SeasonResetConfig,
    SeasonSummary,
    is_within,
    reset_position,
    reset_rating,
    season_for,
)
from .state import (
    clone_member_state,
    create_member_state,
    deserialize_member_state,
    prune_member_state,
    serialize_member_state,
)
from .types import (
    AwardOutcome,
    AwardResult,
    DecayRule,
    EventRule,
    GlobalCap,
    LeaderboardEntry,
    LevelProgress,
    MemberState,
    MigrationResult,
    MigrationStrategy,
    Multiplier,
    TieMode,
)

__version__ = "3.0.0"

__all__ = [
    "__version__",
    # engine
    "RankEngine",
    "RankConfig",
    "create_event_rule",
    "default_rules",
    "apply_multipliers",
    "combined_permille",
    # curves
    "Curve",
    "LinearCurve",
    "QuadraticCurve",
    "ExponentialCurve",
    "TabularCurve",
    "create_curve",
    "default_curve",
    # randomness
    "RandomSource",
    "SystemRandomSource",
    "SeededRandomSource",
    "FixedRandomSource",
    # state
    "create_member_state",
    "clone_member_state",
    "serialize_member_state",
    "deserialize_member_state",
    "prune_member_state",
    # leaderboard
    "build_leaderboard",
    "rank_of",
    "paginate",
    "page_count",
    # migration
    "migrate_total_xp",
    "migrate_all",
    "preview_migration",
    "MigrationReport",
    # types
    "AwardOutcome",
    "AwardResult",
    "DecayRule",
    "EventRule",
    "GlobalCap",
    "LeaderboardEntry",
    "LevelProgress",
    "MemberState",
    "MigrationResult",
    "MigrationStrategy",
    "Multiplier",
    "TieMode",
    # --- competitive ranking -------------------------------------------
    # ratings
    "Rating",
    "RatingSystem",
    "MatchOutcome",
    "EloConfig",
    "Glicko2Config",
    "create_rating",
    "expected_score_permille",
    "update_elo",
    "update_glicko2",
    "rating_interval",
    "DEFAULT_RATING",
    "DEFAULT_DEVIATION",
    "DEFAULT_VOLATILITY",
    # the ladder
    "Tier",
    "Division",
    "LadderPosition",
    "LadderConfig",
    "LadderChange",
    "LadderOutcome",
    "SeriesState",
    "default_tiers",
    "position_for_rating",
    "rating_for_position",
    "compare_positions",
    "format_position",
    "apply_league_points",
    # seasons
    "Season",
    "ResetPolicy",
    "SeasonResetConfig",
    "SeasonSummary",
    "reset_rating",
    "reset_position",
    "season_for",
    "is_within",
    # matchmaking
    "MatchQuality",
    "TeamSplit",
    "match_quality",
    "team_rating",
    "balance_teams",
    "is_acceptable",
    # the ranked engine
    "RankedEngine",
    "RankedConfig",
    "RankedState",
    "MatchResult",
    "create_ranked_state",
    "clone_ranked_state",
    "serialize_ranked_state",
    "deserialize_ranked_state",
    # deterministic fixed-point arithmetic
    "SCALE",
    "to_fixed",
    "from_fixed",
    "fixed_mul",
    "fixed_div",
    "fixed_sqrt",
    "fixed_ln",
    "fixed_exp",
    "isqrt",
    # errors
    "RankModeError",
    "ConfigurationError",
    "ValidationError",
    "CurveError",
    "XpOverflowError",
    "MigrationError",
    "LadderError",
    "SeasonError",
    # constants
    "MAX_TOTAL_XP",
    "MIN_TOTAL_XP",
    "PERMILLE_ONE",
    "DEFAULT_MAX_LEVEL",
    "MAX_SUPPORTED_LEVEL",
    "DEFAULT_PERIOD_SECONDS",
    "GLOBAL_CAP_KEY",
]
