# Fixtures — hostile corpus and goldens

Golden corpora and adversarial cases for the round-trip and gate tests (ADR 0010).

Planned layout (populated by spec 001):

```text
fixtures/
  corpus-k8s/        # sampled sections/labs/quiz from Kubernetes-Workshop (pinned snapshot)
  corpus-opentofu/   # sampled sections/labs/quiz from OpenTofu-Workshop (pinned snapshot)
  adversarial/       # hand-built hostile cases: multi-frontmatter, Vue islands, magic-move,
                     # HTML-comment notes, src: includes, fence-mutation attacks
  goldens/           # expected extraction/composition outputs per fixture
```

Rules:

- Every syntax construct used by either workshop must appear in the corpus (origin pack Phase 0
  exit criterion).
- A parser bug report becomes a failing fixture here before it becomes a fix.
- Fixtures are pinned snapshots — Renovate ignores this tree; refreshes are deliberate commits.
