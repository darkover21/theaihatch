# Open-source hygiene

## Purpose
Make the repository safe to publish, straightforward to contribute to, and reproducibly releasable across supported operating systems.

## Requirements

### REQ-OSS-001 — License under Apache-2.0
The repository shall contain the unmodified Apache License 2.0 text in `LICENSE` and package metadata shall identify `Apache-2.0`.

**Acceptance**
- Given a source checkout, when license checks run, then `LICENSE` matches the canonical Apache-2.0 text.
- Given published package metadata, when inspected, then its SPDX identifier is `Apache-2.0`.

### REQ-OSS-002 — Document the project
`README.md` shall describe prerequisites, install, first run, development, security contact, license, and include an animated GIF showing file/cursor/typing playback.

**Acceptance**
- Given a new contributor, when following README development steps on a supported OS, then tests and the development server start.
- Given the README renders, when its animation asset loads, then it visibly shows at least file opening, cursor movement, typing, and transport controls.

### REQ-OSS-003 — Define contribution conduct
The repository shall include `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` with setup, test, review, issue, and enforcement procedures.

**Acceptance**
- Given a proposed change, when contribution guidance is followed, then required formatting, tests, and sign-off steps are unambiguous.
- Given a conduct report, when the code is followed, then a private reporting route and enforcement owner are identified.

### REQ-OSS-004 — Provide issue and PR templates
Issue templates shall cover bugs and features; the pull-request template shall require scope, linked issue, tests, screenshots or recording for UI changes, and security impact.

**Acceptance**
- Given a new bug issue, when its template opens, then reproduction, expected result, actual result, OS, version, and logs are requested.
- Given a pull request, when its template opens, then tests and security impact are required checklist items.

### REQ-OSS-005 — Run a cross-platform CI matrix
CI shall build and test supported Windows, macOS, and Linux targets on every pull request and protected-branch push.

**Acceptance**
- Given a pull request, when CI runs, then typecheck, lint, unit tests, integration tests, and package smoke tests execute across the matrix.
- Given any required matrix job fails, when branch protection evaluates the change, then merge is blocked.

### REQ-OSS-006 — Publish semantic releases
Protected-branch commits shall drive semantic versioning, changelog generation, signed tags, checksums, and per-OS artifacts through semantic-release.

**Acceptance**
- Given conventional commits since the last release, when release CI succeeds, then the calculated version and changelog match their commit types.
- Given no release-worthy commit, when release CI runs, then no tag or artifact is published.

### REQ-OSS-007 — Prevent committed secrets
Pre-commit guidance and CI scanning shall reject provider keys, private keys, and configured high-confidence secret patterns.

**Acceptance**
- Given a fixture containing a synthetic provider key, when secret scanning runs, then the check fails and identifies its path.
- Given keychain references without secret values, when scanning runs, then they pass.

### REQ-OSS-008 — Publish security policy
`SECURITY.md` shall state supported versions, private vulnerability reporting, response targets, disclosure process, and local-data threat boundaries.

**Acceptance**
- Given a vulnerability reporter, when reading `SECURITY.md`, then a private report channel and required report fields are available.
- Given an unsupported version, when the support table is read, then its status is explicit.

## Dependencies
- packaging

## Out of scope
- Paid support commitments
- Public disclosure of unpatched vulnerabilities

