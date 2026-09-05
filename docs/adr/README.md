# Architecture decision records

Nygard-style ADRs. An accepted ADR is changed only by a superseding ADR, never by editing.

This corpus was seeded from the "Workshop Localization Hub" architecture pack developed in
[Kubernetes-Workshop ADR 0014](https://github.com/PlatformRelay/Kubernetes-Workshop) and revised
after a critical review: the domain model, identities, and policies were kept; the service runtime
(database, queue, portal, webhooks) was cut in favor of a stateless, git-native CLI. ADR 0003
records that decision and its reversal trigger.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-standalone-repository.md) | Ship one standalone tool repository shared by all consumer workshops | proposed |
| [0002](0002-build-vs-buy-boundary.md) | Integrate mature TMS products; do not build translator tooling | proposed |
| [0003](0003-stateless-git-native-cli.md) | Stateless CLI; localization state lives in the consumer repository | proposed |
| [0004](0004-po-working-format.md) | Canonical unit model with gettext PO as the working format | proposed |
| [0005](0005-explicit-content-identities.md) | Require explicit immutable content identities | proposed |
| [0006](0006-tms-port-and-conformance-kit.md) | TMS port contract + conformance kit; zero live adapters in v1 | proposed |
| [0007](0007-generated-locale-artifacts.md) | English authoritative; locale artifacts are generated, never hand-edited | proposed |
| [0008](0008-governed-slide-overrides.md) | Governed, revision-anchored slide overrides and splits | proposed |
| [0009](0009-human-approval-fail-closed.md) | Human approval through existing review mechanisms; strict compose fails closed | proposed |
| [0010](0010-story-driven-tests.md) | Every supported story is covered at multiple test layers against golden corpora | proposed |
| [0011](0011-typescript-implementation.md) | Implement in TypeScript on the Slidev/unified ecosystem | proposed |
| [0012](0012-offset-splice-skeleton.md) | The skeleton is the source file with holes, not a re-serialized AST | proposed |
| [0013](0013-own-the-po-codec.md) | Own the PO codec rather than depend on `gettext-parser` | proposed |

**Parked** (from the origin pack, resurrected only if ADR 0003's service trigger fires):
inbox/outbox idempotent event processing; sandboxed multi-tenant rendering. Until then, "no code
execution during extraction/composition" is a standing constraint recorded in SECURITY.md.
