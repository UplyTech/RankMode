# Roadmap

This roadmap lists the work that is open in the issue tracker. It has no dates:
nothing here is promised for a particular day. The issues are the source of
truth; this page only groups them.

## Next: first publication

- [#28](https://github.com/UplyTech/RankMode/issues/28) First publication to npm and PyPI with Trusted Publishing
- [#33](https://github.com/UplyTech/RankMode/issues/33) OpenSSF Scorecard and Best Practices
- [#32](https://github.com/UplyTech/RankMode/issues/32) Second maintainer and honest OpenSSF level

## Quality and trust

- [#25](https://github.com/UplyTech/RankMode/issues/25) Anti-abuse tests for cooldowns, caps and decay
- [#30](https://github.com/UplyTech/RankMode/issues/30) Parity tests between the Python and TypeScript implementations
- [#31](https://github.com/UplyTech/RankMode/issues/31) Benchmarks with a viewable report
- [#34](https://github.com/UplyTech/RankMode/issues/34) Code and dependency scanners at the maximum (free plans)

## Documentation and community

- [#29](https://github.com/UplyTech/RankMode/issues/29) API reference and runnable examples for both editions
- [#35](https://github.com/UplyTech/RankMode/issues/35) GitHub Discussions and Wiki
- [#36](https://github.com/UplyTech/RankMode/issues/36) README for every audience
- [#27](https://github.com/UplyTech/RankMode/issues/27) Adopt in the Discord bot and other callers

## Competition half

- [#26](https://github.com/UplyTech/RankMode/issues/26) Ratings, divisions and matchmaking validation

## Deferred on purpose

- [#23](https://github.com/UplyTech/RankMode/issues/23) TypeScript 7 and `@types/node` 26, until `typescript-eslint` supports TypeScript 7 and the Node floor moves

## What RankMode will not become

The library ranks; it does not fetch, store, queue or send. No I/O, no clock, no
ambient randomness. See "What belongs in this library" in
[CONTRIBUTING.md](./CONTRIBUTING.md).
