# Security policy

## Supported versions

| Version | Supported |
|---------|-----------|
| `main`  | Yes       |
| Tags    | Latest release only |

## Reporting a vulnerability

**Do not** open public GitHub issues for security-sensitive reports.

Email **konrad.heimel@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected versions/commits if known.

You will receive an acknowledgement within **7 days** and a remediation plan or resolution within
**90 days** of triage. Please allow coordinated disclosure before publishing details.

## Scope

In scope:

- The `workshop-i18n` packages and CLI published from this repository.
- CI workflows and release artifacts of this repository.
- Parsing of untrusted workshop content: the extractor and composer consume Markdown, YAML
  frontmatter, and quiz JSON from consumer repositories — including external-contributor PRs — and
  must treat that input as hostile (no code execution during extraction/composition, path
  traversal, denial of service through pathological input).

Out of scope:

- Vulnerabilities in consumer workshops' own content or infrastructure.
- Vulnerabilities in third-party TMS products (report those upstream).
- Issues requiring a compromised local development environment.

## Hardening posture

- No network access at runtime: the CLI reads and writes files in the consumer repository only.
- Dependencies are kept current via Renovate; CI runs CodeQL and OpenSSF Scorecard.
- Releases are built in CI from tagged commits; provenance is attached where the toolchain
  supports it.
