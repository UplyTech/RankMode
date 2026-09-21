# Support

| You want to | Go to |
|---|---|
| Understand how something works | [README](../README.md), [Python edition](../python/README.md), [TypeScript edition](../typescript/README.md) |
| See it working | [`python/examples/`](../python/examples), [`typescript/examples/`](../typescript/examples) |
| Ask "how do I ...?" | [Discussions](https://github.com/uplytech/rankmode/discussions) |
| Report a wrong answer | [Bug report](https://github.com/uplytech/rankmode/issues/new?template=bug_report.yml) |
| Report that the two editions disagree | [Edition drift](https://github.com/uplytech/rankmode/issues/new?template=edition_drift.yml) |
| Report a security problem | **<security@uplytech.de>**, never a public issue - see [SECURITY.md](../SECURITY.md) |

## Before you open an issue

RankMode turns 'this member did something' into 'here is their new total, their new level, and whether they just levelled up' - and nothing else. Currency, balances and everything economic built on them - shops, banking, credit, markets - are EconomyWorld.

Check the boundaries in [CONTRIBUTING.md](../CONTRIBUTING.md) first: most
questions turn out to be about something on the other side of them, and the
answer is then "your code", not "this library".

## Response times

This is maintained alongside other work, so an issue may sit for a few days.
Two things are treated differently:

- **Security reports** - first response within 48 hours (see SECURITY.md).
- **Edition drift** - the two editions disagreeing breaks the promise the whole
  library rests on. It is picked up ahead of everything else and never goes
  stale.
