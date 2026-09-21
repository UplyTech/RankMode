# Security Policy

## Reporting a vulnerability

Please report security issues privately to **<security@uplytech.de>** rather than
in a public issue.

| | |
|---|---|
| First response | within 48 hours |
| Fix or mitigation plan | within 5 working days |
| Disclosure | coordinated, after a fix is available |

Include the curve configuration, the rule involved and the sequence of calls
that demonstrates the problem. Reproduction steps matter more than severity
claims.

## What counts as a vulnerability here

RankMode holds no credentials, opens no sockets and stores no data, so the
interesting failures are of one kind: **somebody being able to obtain a standing
they did not earn.** For the participation half that is points; for the ranked
half it is a rank. Specifically:

- A way to bypass a cooldown or a period cap.
- A way to make the award computation return more than the configured maximum.
- A total that can be pushed outside the safe integer range, or made to wrap.
- A crafted `MemberState` or `RankedState` (from a database an attacker can
  influence) that makes an engine misbehave rather than raise a
  `ValidationError`.
- A way to gain rating or League Points from a match that did not happen, or to
  gain more from one than the configured formula allows.
- **A rating or ladder input that makes a call raise or hang rather than return
  an answer.** The volatility solver is the only unbounded loop in the library;
  it bisects, so its step count follows from the bracket width alone, and the
  bracket is clamped into the configured volatility bounds. A case that escapes
  either bound is a vulnerability, not a curiosity — see the 3.0.0 changelog for
  two that did before release.
- Any difference between the Python and the TypeScript edition that somebody
  could exploit by moving between two of an operator's communities. This
  includes a rating that lands one micro-unit either side of a promotion
  threshold in one edition and not the other.
- A denial of service from a plausible input — a curve configuration, a
  leaderboard size or a team-balancing group that makes a call take
  unreasonably long.

## What is not a vulnerability

- **Predictable awards from `SeededRandomSource` / `FixedRandomSource`.** Both
  classes are documented as test helpers. Using it in production is a
  configuration mistake, and the documentation says so in three places.
- **Points farmed within the configured limits.** If an operator sets no
  cooldown and no cap, the library will do as it was told.
- **Rank farmed by playing weak opponents.** Both rating systems already pay
  almost nothing for beating somebody far below you, and that is the whole
  defence a rating formula offers. Detecting two accounts arranging their
  results is the caller's problem: RankMode is told a match happened and has no
  way to know whether it did.
- **`balance_teams` refusing more than twenty players.** It is exhaustive by
  design; the cap is the documented boundary, not a limitation to work around.
- Anything involving the caller's own database, Discord permissions or reward
  handling — the library has no part in those by design.

## Notes for operators

These are the two mistakes that actually cause incidents:

1. **Use a cryptographic random source in production.**
   `SystemRandomSource` (Python) and `CryptoRandomSource` (TypeScript) are the
   defaults for a reason. A predictable generator lets anyone who works out the
   algorithm predict the next award — exactly the farming the random span was
   added to prevent.

2. **Set a cooldown and a cap.** They are core functions, not optional extras.
   A rule with neither will be exploited; this is not a hypothetical.

Beyond that: RankMode never logs, so nothing you pass it — member ids included —
appears anywhere. Everything the library learns exists only for the duration of
the call.

## Supported versions

| Version | Supported |
|---|---|
| 1.x | yes |

Security fixes ship as a patch release and are back-ported to the previous major
version for six months after a new major is released.
