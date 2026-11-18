# Governance

RankMode is maintained by UplyTech, the owner of the `UplyTech` GitHub
organisation. This document says who decides what, and how.

## Roles

| Role | Who | What they can do |
|---|---|---|
| Owner | The organisation owners (`VectoDE`, `imrkumar`) | Repository settings, rulesets, secrets, teams, the `release` environment |
| Maintainer | Members of `@UplyTech/maintainers` (see [CODEOWNERS](./.github/CODEOWNERS)) | Review and merge pull requests, triage issues, decide on versions |
| Release approver | The reviewer set on the `release` environment (currently `VectoDE`) | Approve a tag build before it publishes to npm and PyPI |
| Contributor | Anyone | Open issues and pull requests, take part in Discussions |

Today one person does almost all of the work. That is a fact, not a target; the
plan to change it is tracked in
[#32](https://github.com/UplyTech/RankMode/issues/32).

## How decisions are made

- Day to day, a maintainer decides. A pull request needs the checks to pass and
  a look from the code owners listed in [CODEOWNERS](./.github/CODEOWNERS) for
  the files they own.
- What a curve or a rating formula computes is a release decision, not a code
  decision. It is always a major version, announced in the changelog and shipped
  with a migration. See [CONTRIBUTING.md](./CONTRIBUTING.md).
- If maintainers disagree, the owners decide, and the reasoning goes into the
  issue or pull request so it can be found later.
- Security reports follow [SECURITY.md](./SECURITY.md), not this process.

## Releases

A release is a tag `v*` on `main`. The release workflow builds the artefacts,
signs them, and waits for the release approver before publishing. Details are
in the README section on releases and in
[.github/SETTINGS.md](./.github/SETTINGS.md).

## Code of conduct

[CODE_OF_CONDUCT.md](./.github/CODE_OF_CONDUCT.md) applies in issues, pull
requests and Discussions.

## Changing this document

By pull request, approved by an owner.
