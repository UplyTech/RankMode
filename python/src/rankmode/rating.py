"""Skill ratings: what a player is worth, as a number.

Two systems ship, and the choice between them is a real one rather than a
preference:

**Elo** is one number and one formula. Everybody understands it, it is cheap,
and it has one weakness that matters: it treats a player who has played four
matches exactly like one who has played four hundred. A newcomer who wins three
times climbs as slowly as a veteran, and a veteran who is having a bad week
falls as fast as a newcomer. The K-factor schedule papers over that; it does not
fix it.

**Glicko-2** carries the missing piece: how *sure* the system is. A rating
deviation says "we think 1500, give or take 350" for a newcomer and "1500, give
or take 60" for a regular. An uncertain player moves fast, a settled one moves
slowly, and a player who stops playing becomes uncertain again on their own.
The volatility on top of that catches the player whose results are erratic for
reasons the rating cannot see.

**Glicko-2 is the default, and the reason is written down.** Elo is here for the
caller who needs a number a player can compute in their head, and for a scope
small enough that uncertainty never settles.

Everything is integers. The rating a caller sees is whole points; everything
inside is micro-units through :mod:`rankmode.fixed`, because a rating system
that used floating point would give two editions two different answers - and
this library's whole promise is that it does not.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import Enum

from .constants import PERMILLE_ONE
from .errors import ConfigurationError, ValidationError
from .fixed import SCALE, fixed_div, fixed_exp, fixed_mul, fixed_sqrt, from_fixed

__all__ = [
    "MatchOutcome",
    "Rating",
    "EloConfig",
    "Glicko2Config",
    "RatingSystem",
    "create_rating",
    "expected_score_permille",
    "update_elo",
    "update_glicko2",
    "rating_interval",
    "DEFAULT_RATING",
    "DEFAULT_DEVIATION",
    "DEFAULT_VOLATILITY",
]

#: Where a player starts. 1500 is the convention every rating system inherited
#: from Elo's chess work, and keeping it means a number from somewhere else is
#: comparable without a conversion table.
DEFAULT_RATING = 1500

#: How unsure the system is about a new player, in rating points. 350 is
#: Glickman's own figure: it puts the 95 % interval at roughly 800 to 2200,
#: which is "we have no idea" said in numbers.
DEFAULT_DEVIATION = 350

#: How erratic a player's results are, in micro-units. 0.06 is Glickman's
#: recommendation for a population whose ratings are meant to be stable.
DEFAULT_VOLATILITY = 60_000

#: The constant that converts between the visible scale and Glicko-2's internal
#: one: 173.7178, in micro-units. It is 400 / ln(10), and it exists so that the
#: internal maths is unitless while the numbers a player sees stay on the scale
#: they know.
_GLICKO_SCALE = 173_717_793

#: 3 / pi^2, in micro-units. Appears in the g(phi) damping term.
_THREE_OVER_PI_SQUARED = 303_963

#: The convergence threshold for the volatility iteration, in micro-units.
#: Glickman suggests 0.000001; at micro-unit precision that is one unit.
_CONVERGENCE = 1

#: A hard stop on the volatility iteration. Illinois converges in a handful of
#: steps; a hundred means something is wrong, and looping forever in a library
#: that a bot calls per match is worse than raising.
_MAX_ITERATIONS = 100

#: The largest estimated variance the update will carry, in micro-units.
#:
#: Glicko-2's ``v`` is ``1 / sum(g^2 E (1 - E))``, and when a result was very
#: improbable - a 200-rated player beating a 2200-rated one - ``E`` is about one
#: in a hundred thousand and the sum collapses to a handful of micro-units. The
#: reciprocal then reaches a million, ``delta`` follows it, and ``delta^2``
#: reaches 10^18: a hundred times past the largest integer JavaScript represents
#: exactly, which is where the two editions would stop agreeing.
#:
#: Ten thousand is far outside anything a real population produces - a settled
#: player sits near 0.2 - and it is the honest ceiling: above it the estimate
#: carries no usable information, and capping says so rather than pretending the
#: arithmetic still means something.
_MAX_VARIANCE = 10_000 * SCALE


class MatchOutcome(str, Enum):
    """How a match ended, from one player's point of view.

    Derives from :class:`str` so the value can be stored and compared against
    the shared vectors without conversion.
    """

    #: The player won.
    WIN = "WIN"
    #: The player lost.
    LOSS = "LOSS"
    #: Neither won. Counts as half a win in every formula here.
    DRAW = "DRAW"

    @property
    def score_permille(self) -> int:
        """The outcome as a score in permille: 1000, 0 or 500."""
        if self is MatchOutcome.WIN:
            return PERMILLE_ONE
        if self is MatchOutcome.LOSS:
            return 0
        return PERMILLE_ONE // 2


class RatingSystem(str, Enum):
    """Which formula an engine uses."""

    #: One number, one formula, a K-factor schedule.
    ELO = "ELO"
    #: Rating, deviation and volatility. The default.
    GLICKO2 = "GLICKO2"


@dataclass(frozen=True)
class Rating:
    """A player's skill, and how sure the system is about it.

    ``rating`` and ``deviation`` are whole rating points, because those are the
    numbers a caller displays and stores. ``volatility`` is in micro-units,
    because it is never displayed and a whole number would be far too coarse -
    the useful range is 0.03 to 0.10.
    """

    #: The skill estimate, in rating points.
    rating: int = DEFAULT_RATING
    #: How far the true skill might be from the estimate, in rating points.
    deviation: int = DEFAULT_DEVIATION
    #: How erratic the player's results are, in micro-units. Glicko-2 only.
    volatility: int = DEFAULT_VOLATILITY
    #: Matches that have counted towards this rating. Drives the K-factor
    #: schedule in Elo and the placement logic elsewhere.
    matches_played: int = 0

    def __post_init__(self) -> None:
        for name, value in (
            ("rating", self.rating),
            ("deviation", self.deviation),
            ("volatility", self.volatility),
            ("matches_played", self.matches_played),
        ):
            if not isinstance(value, int) or isinstance(value, bool):
                raise ValidationError(f"{name} must be an integer", **{name: value})
        if self.deviation < 0:
            raise ValidationError("deviation cannot be negative", deviation=self.deviation)
        if self.volatility <= 0:
            raise ValidationError("volatility must be positive", volatility=self.volatility)
        if self.matches_played < 0:
            raise ValidationError(
                "matches_played cannot be negative", matches_played=self.matches_played
            )


def create_rating(
    rating: int = DEFAULT_RATING,
    deviation: int = DEFAULT_DEVIATION,
    volatility: int = DEFAULT_VOLATILITY,
    matches_played: int = 0,
) -> Rating:
    """A rating for a player who has not been rated yet, or a known one."""
    return Rating(
        rating=rating,
        deviation=deviation,
        volatility=volatility,
        matches_played=matches_played,
    )


@dataclass(frozen=True)
class EloConfig:
    """The K-factor schedule.

    K decides how far one match can move a rating. One value for everybody is
    the classic mistake: too high and every veteran's rating jitters, too low
    and a newcomer takes fifty matches to reach where they belong. The schedule
    below is the usual answer - fast while the system is learning, slow once it
    has.
    """

    #: K while a player is still in their placement matches.
    placement_k: int = 40
    #: K for a settled player below the elite threshold.
    standard_k: int = 20
    #: K above the elite threshold, where a rating is expected to be stable.
    elite_k: int = 10
    #: How many matches count as placement for the K schedule.
    placement_matches: int = 10
    #: The rating above which ``elite_k`` applies.
    elite_threshold: int = 2400
    #: The lowest rating the system will produce. A floor stops a player who
    #: loses badly from falling somewhere no opponent can be found.
    floor: int = 0
    #: The highest rating the system will produce.
    ceiling: int = 5000

    def __post_init__(self) -> None:
        for name in ("placement_k", "standard_k", "elite_k"):
            value = getattr(self, name)
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                raise ConfigurationError(f"{name} must be a positive integer", **{name: value})
        if self.placement_matches < 0:
            raise ConfigurationError(
                "placement_matches cannot be negative",
                placement_matches=self.placement_matches,
            )
        if self.floor >= self.ceiling:
            raise ConfigurationError(
                "floor must be below ceiling", floor=self.floor, ceiling=self.ceiling
            )

    def k_for(self, rating: Rating) -> int:
        """The K-factor that applies to this player right now."""
        if rating.matches_played < self.placement_matches:
            return self.placement_k
        if rating.rating >= self.elite_threshold:
            return self.elite_k
        return self.standard_k


@dataclass(frozen=True)
class Glicko2Config:
    """The two numbers Glicko-2 needs beyond the rating itself."""

    #: The system constant, tau, in micro-units. It caps how fast volatility
    #: can move. Glickman: "smaller values prevent the volatility from changing
    #: by large amounts"; 0.5 is his suggested middle for most applications.
    tau: int = 500_000
    #: The largest deviation the system will report, in rating points. Without
    #: a cap an inactive player's deviation grows without bound and their next
    #: match swings them across the whole ladder.
    max_deviation: int = DEFAULT_DEVIATION
    #: The smallest deviation, in rating points. A floor keeps the system from
    #: becoming so sure of a player that it stops learning.
    min_deviation: int = 30
    #: The lowest and highest rating the system will produce.
    floor: int = 0
    ceiling: int = 5000
    #: The bounds on volatility itself, in micro-units. Glickman leaves sigma
    #: unbounded; every implementation that runs against a real population puts
    #: bounds on it, because a single improbable result otherwise sends it
    #: somewhere no later match brings it back from. 0.001 to 0.5 is wide enough
    #: that a normal ladder never touches either end.
    min_volatility: int = 1_000
    max_volatility: int = 500_000

    def __post_init__(self) -> None:
        if self.tau <= 0:
            raise ConfigurationError("tau must be positive", tau=self.tau)
        if self.min_volatility <= 0:
            raise ConfigurationError(
                "min_volatility must be positive", min_volatility=self.min_volatility
            )
        if self.min_volatility > self.max_volatility:
            raise ConfigurationError(
                "min_volatility cannot exceed max_volatility",
                min_volatility=self.min_volatility,
                max_volatility=self.max_volatility,
            )
        if self.min_deviation <= 0:
            raise ConfigurationError(
                "min_deviation must be positive", min_deviation=self.min_deviation
            )
        if self.min_deviation > self.max_deviation:
            raise ConfigurationError(
                "min_deviation cannot exceed max_deviation",
                min_deviation=self.min_deviation,
                max_deviation=self.max_deviation,
            )
        if self.floor >= self.ceiling:
            raise ConfigurationError(
                "floor must be below ceiling", floor=self.floor, ceiling=self.ceiling
            )


# ---------------------------------------------------------------------------
# Expected score
# ---------------------------------------------------------------------------
def expected_score_permille(
    player: Rating,
    opponent: Rating,
    system: RatingSystem = RatingSystem.GLICKO2,
) -> int:
    """The chance the player beats the opponent, in permille.

    Permille rather than a float for the same reason progress is: a probability
    is displayed, compared and stored, and a float would let two editions
    disagree in the last digit of something a player sees.

    Under Glicko-2 the opponent's *deviation* widens the answer towards 500:
    an uncertain opponent is closer to a coin toss than their rating alone
    suggests. Under Elo only the two ratings count, which is exactly the
    difference between the two systems.
    """
    difference = opponent.rating - player.rating

    if system is RatingSystem.ELO:
        # 1 / (1 + 10^(diff/400)), computed as 1 / (1 + e^(diff * ln10 / 400)).
        exponent = fixed_div(difference * SCALE, 400 * SCALE)
        exponent = fixed_mul(exponent, 2_302_585)  # ln(10)
        return _logistic_permille(exponent)

    # Glicko-2 damps the exponent by g(phi) of the opponent's deviation.
    phi = fixed_div(opponent.deviation * SCALE, _GLICKO_SCALE)
    g = _g_of_phi(phi)
    mu_difference = fixed_div(difference * SCALE, _GLICKO_SCALE)
    return _logistic_permille(fixed_mul(g, mu_difference))


def _logistic_permille(exponent: int) -> int:
    """``1 / (1 + e^exponent)`` as permille, clamped into 0..1000."""
    # Beyond +/- 20 the answer is 0 or 1000 to far more precision than permille
    # can carry, and fixed_exp refuses the input anyway.
    if exponent >= 20 * SCALE:
        return 0
    if exponent <= -20 * SCALE:
        return PERMILLE_ONE
    probability = fixed_div(SCALE, SCALE + fixed_exp(exponent))
    permille = (probability * PERMILLE_ONE + SCALE // 2) // SCALE
    return max(0, min(PERMILLE_ONE, permille))


def _g_of_phi(phi: int) -> int:
    """Glicko-2's ``g``: how much an uncertain opponent damps the expectation.

    ``1 / sqrt(1 + 3 phi^2 / pi^2)``. At phi = 0 it is 1 - a perfectly known
    opponent tells you everything. As phi grows it falls towards zero, and the
    expected score is pulled towards a coin toss.
    """
    phi_squared = fixed_mul(phi, phi)
    inner = SCALE + fixed_mul(_THREE_OVER_PI_SQUARED, phi_squared)
    return fixed_div(SCALE, fixed_sqrt(inner))


# ---------------------------------------------------------------------------
# Elo
# ---------------------------------------------------------------------------
def update_elo(
    player: Rating,
    opponent: Rating,
    outcome: MatchOutcome,
    config: EloConfig | None = None,
) -> Rating:
    """One Elo update, for one match against one opponent.

    ``new = old + K * (score - expected)``, with everything in permille until
    the final rounding so that the two editions round once, in the same place,
    on the same number.
    """
    settings = config if config is not None else EloConfig()
    k = settings.k_for(player)
    expected = expected_score_permille(player, opponent, RatingSystem.ELO)
    delta_permille = k * (outcome.score_permille - expected)

    # Round half away from zero, so a gain and the matching loss are symmetric.
    if delta_permille >= 0:
        delta = (delta_permille + PERMILLE_ONE // 2) // PERMILLE_ONE
    else:
        delta = -((-delta_permille + PERMILLE_ONE // 2) // PERMILLE_ONE)

    new_rating = max(settings.floor, min(settings.ceiling, player.rating + delta))
    return replace(
        player,
        rating=new_rating,
        matches_played=player.matches_played + 1,
    )


# ---------------------------------------------------------------------------
# Glicko-2
# ---------------------------------------------------------------------------
def update_glicko2(
    player: Rating,
    results: list[tuple[Rating, MatchOutcome]],
    config: Glicko2Config | None = None,
) -> Rating:
    """A Glicko-2 update over a rating period.

    Glicko-2 is defined over a *period*, not a match: the player's results
    since the last update are applied together. A caller who updates per match
    passes a single result and gets the same behaviour, slightly noisier - which
    is the trade every implementation makes.

    An empty ``results`` list is not an error. It is the case Glicko-2 has an
    answer for that Elo does not: a player who did not play gets no rating
    change and a *wider* deviation, because the system knows less about them
    than it did.
    """
    settings = config if config is not None else Glicko2Config()

    if not results:
        return _decay_deviation(player, settings)

    # Step 2: onto the internal scale.
    mu = fixed_div((player.rating - DEFAULT_RATING) * SCALE, _GLICKO_SCALE)
    phi = fixed_div(player.deviation * SCALE, _GLICKO_SCALE)
    sigma = player.volatility

    # Step 3 and 4: the estimated variance, and the estimated improvement.
    variance_inverse = 0
    delta_sum = 0
    for opponent, outcome in results:
        opponent_mu = fixed_div((opponent.rating - DEFAULT_RATING) * SCALE, _GLICKO_SCALE)
        opponent_phi = fixed_div(opponent.deviation * SCALE, _GLICKO_SCALE)
        g = _g_of_phi(opponent_phi)
        expected = _expected_internal(mu, opponent_mu, g)
        g_squared = fixed_mul(g, g)
        variance_inverse += fixed_mul(g_squared, fixed_mul(expected, SCALE - expected))
        score = outcome.score_permille * SCALE // PERMILLE_ONE
        delta_sum += fixed_mul(g, score - expected)

    if variance_inverse <= 0:
        # Every opponent was so far away that ``E`` rounded to zero or one, and
        # the sum carries no information at all. The rating cannot move and the
        # deviation still widens, because time passed - but the matches were
        # played, so they are counted. Dropping them here would leave a player
        # who only ever met opponents from the far end of the ladder stuck on
        # zero matches for ever.
        return _decay_deviation(player, settings, matches=len(results))

    variance = min(_MAX_VARIANCE, fixed_div(SCALE, variance_inverse))
    delta = fixed_mul(variance, delta_sum)

    # Step 5: the new volatility, by bisection on Glickman's function.
    sigma_new = _solve_volatility(
        sigma,
        phi,
        variance,
        delta,
        settings.tau,
        settings.min_volatility,
        settings.max_volatility,
    )

    # Step 6 and 7: pre-period deviation, then the new one.
    phi_star = fixed_sqrt(fixed_mul(phi, phi) + fixed_mul(sigma_new, sigma_new))
    phi_new = fixed_div(
        SCALE,
        fixed_sqrt(fixed_div(SCALE, fixed_mul(phi_star, phi_star)) + variance_inverse),
    )

    # Step 8: the new rating.
    mu_new = mu + fixed_mul(fixed_mul(phi_new, phi_new), delta_sum)

    rating = DEFAULT_RATING + from_fixed(fixed_mul(mu_new, _GLICKO_SCALE))
    deviation = from_fixed(fixed_mul(phi_new, _GLICKO_SCALE))

    return Rating(
        rating=max(settings.floor, min(settings.ceiling, rating)),
        deviation=max(settings.min_deviation, min(settings.max_deviation, deviation)),
        volatility=sigma_new,
        matches_played=player.matches_played + len(results),
    )


def _expected_internal(mu: int, opponent_mu: int, g: int) -> int:
    """``E`` on the internal scale, as a fixed-point value in 0..1."""
    exponent = -fixed_mul(g, mu - opponent_mu)
    if exponent >= 20 * SCALE:
        return 0
    if exponent <= -20 * SCALE:
        return SCALE
    return fixed_div(SCALE, SCALE + fixed_exp(exponent))


def _decay_deviation(player: Rating, config: Glicko2Config, matches: int = 0) -> Rating:
    """A rating period the player sat out.

    The rating does not move - nothing happened to move it. The deviation
    grows, because the system's knowledge is a month older than it was. This is
    the mechanism that makes a returning player's first few matches count for
    more, and it is the reason Glicko-2 needs no separate "rust" rule.

    **The growth is forced to at least one point**, and that is not a rounding
    nicety. ``phi* = sqrt(phi^2 + sigma^2)`` is computed from the deviation as
    it is stored, in whole rating points, and once the deviation is large
    enough one period's growth is under half a point: it rounds back to the
    number it started from, and that number becomes a fixed point of the
    iteration. At the default volatility that happens at 109, so without this
    an idle player's deviation climbed for forty-nine periods and then stopped
    for ever - a player gone for two years would still be treated as one the
    system knew to within a hundred points, which is the opposite of what the
    decay is for.
    """
    phi = fixed_div(player.deviation * SCALE, _GLICKO_SCALE)
    sigma = player.volatility
    phi_star = fixed_sqrt(fixed_mul(phi, phi) + fixed_mul(sigma, sigma))
    deviation = from_fixed(fixed_mul(phi_star, _GLICKO_SCALE))

    # An idle period leaves the system strictly less certain than it was, so
    # when the arithmetic rounds that to nothing the deviation still moves.
    if deviation <= player.deviation < config.max_deviation:
        deviation = player.deviation + 1

    return replace(
        player,
        deviation=max(config.min_deviation, min(config.max_deviation, deviation)),
        matches_played=player.matches_played + matches,
    )


def _solve_volatility(
    sigma: int,
    phi: int,
    variance: int,
    delta: int,
    tau: int,
    min_volatility: int,
    max_volatility: int,
) -> int:
    """Glickman's volatility iteration, by bisection on his function.

    Glickman specifies the Illinois variant of regula falsi, and in floating
    point that is the right choice: it converges in three or four steps.

    In fixed point it does not converge at all for some inputs. The secant step
    is computed on integers, and once the bracket is narrow the rounding sends
    it to the same two points for ever - a two-cycle 122 micro-units wide that
    no iteration count escapes. That is not a bug in the transcription; it is
    what regula falsi does when the arithmetic underneath it has a floor.

    So the root is found by bisection instead. It is slower - about two dozen
    halvings rather than four secant steps - and it has the property that
    matters more here: on integers it *always* terminates, in a number of steps
    that follows from the bracket width alone. Both editions therefore take the
    same number of steps and land on the same integer.

    **The bracket is clamped into the volatility bounds**, and that clamp is
    load-bearing rather than defensive. Glickman's upper end is
    ``ln(delta^2 - phi^2 - v)``, and after a sufficiently improbable result -
    a 200-rated player beating a 2200-rated one - ``delta`` reaches six figures
    and that logarithm passes 22, outside the domain where ``fixed_exp`` is
    defined at all. Clamping it to ``ln(max_volatility^2)`` keeps every
    evaluation inside the representable range, and when the root genuinely lies
    beyond the clamp the answer is the bound itself, which is what a volatility
    ceiling is for.

    The result is checked against Glickman's own worked example, which it
    reproduces to the last digit the paper prints - the clamp never binds
    there, or anywhere a real population reaches.
    """
    a = _ln_fixed(fixed_mul(sigma, sigma))
    delta_squared = fixed_mul(delta, delta)
    phi_squared = fixed_mul(phi, phi)
    tau_squared = fixed_mul(tau, tau)

    # The log-variance window the answer is allowed to live in. Everything the
    # iteration evaluates is clamped into it, so ``fixed_exp`` is never handed
    # an argument it cannot represent.
    lower_bound = _ln_fixed(fixed_mul(min_volatility, min_volatility))
    upper_bound = _ln_fixed(fixed_mul(max_volatility, max_volatility))

    def clamp(x: int) -> int:
        return max(lower_bound, min(upper_bound, x))

    def f(x: int) -> int:
        exp_x = fixed_exp(x)
        denominator = phi_squared + variance + exp_x
        numerator = fixed_mul(exp_x, delta_squared - denominator)
        first = fixed_div(numerator, 2 * fixed_mul(denominator, denominator))
        second = fixed_div(x - a, tau_squared)
        return first - second

    def volatility_at(x: int) -> int:
        return max(min_volatility, min(max_volatility, fixed_exp(clamp(x) // 2)))

    a = clamp(a)
    low = a

    # The bracket, as Glickman defines it, held inside the window.
    if delta_squared > phi_squared + variance:
        high = clamp(_ln_fixed(delta_squared - phi_squared - variance))
    else:
        k = 1
        high = clamp(a - tau)
        while high > lower_bound and f(high) < 0:
            k += 1
            if k > _MAX_ITERATIONS:
                raise ValidationError(
                    "The volatility iteration could not be bracketed",
                    sigma=sigma,
                    phi=phi,
                )
            high = clamp(a - k * tau)

    f_low = f(low)
    f_high = f(high)

    # A bracket needs opposite signs. If one end is already the root, take it.
    if f_low == 0:
        return volatility_at(low)
    if f_high == 0:
        return volatility_at(high)
    if (f_low > 0) == (f_high > 0):
        # The root lies outside the window. ``f`` falls towards minus infinity
        # as x grows, so a pair of positive values means the crossing is above
        # the window and a pair of negative ones means it is below: either way
        # the answer is the end of the window it lies beyond.
        return volatility_at(max(low, high) if f_low > 0 else min(low, high))

    # Order the bracket so that ``low`` is the end with the negative value. The
    # ordering is by sign rather than by magnitude, because ``high`` may be the
    # numerically smaller of the two.
    if f_low > 0:
        low, high = high, low
        f_low, f_high = f_high, f_low

    # Bisection. The bracket halves every step, so the count follows from its
    # width: 2^25 micro-units is thirty-three units of ln, far more than any
    # bracket this function is handed.
    for _ in range(_MAX_ITERATIONS):
        if abs(high - low) <= _CONVERGENCE:
            break
        middle = (low + high) // 2
        if middle in (low, high):
            # The integers are adjacent: this is as close as the arithmetic
            # goes, and going round again would change nothing.
            break
        f_middle = f(middle)
        if f_middle == 0:
            low = high = middle
            break
        if f_middle < 0:
            low, f_low = middle, f_middle
        else:
            high, f_high = middle, f_middle

    # The midpoint of the final bracket, so the answer does not favour whichever
    # end happened to be evaluated last.
    return volatility_at((low + high) // 2)


def _ln_fixed(value: int) -> int:
    """``ln`` of a fixed-point value, guarding the degenerate input."""
    from .fixed import fixed_ln

    if value <= 0:
        raise ValidationError("Logarithm of a non-positive value", value=value)
    return fixed_ln(value)


def rating_interval(rating: Rating, confidence_permille: int = 950) -> tuple[int, int]:
    """The range the player's true skill is probably in.

    The number a rating system is actually asked for. "1500" is a point
    estimate that nobody should trust on its own; "1500, and we are 95 % sure
    it is between 1240 and 1760" is what a placement screen should say.

    The multiplier is the normal quantile for the requested confidence. Three
    are supported because three are used; anything else is a decision about
    what the interval means, not about arithmetic.
    """
    multipliers = {680: 1_000_000, 900: 1_644_854, 950: 1_959_964, 990: 2_575_829}
    if confidence_permille not in multipliers:
        raise ValidationError(
            "confidence_permille must be one of 680, 900, 950 or 990",
            confidence_permille=confidence_permille,
        )
    half_width = from_fixed(
        fixed_mul(multipliers[confidence_permille], rating.deviation * SCALE)
    )
    return rating.rating - half_width, rating.rating + half_width
