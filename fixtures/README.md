# Fixtures — hostile corpus and goldens

Golden corpora and adversarial cases for the round-trip and gate tests (ADR 0010).

```text
fixtures/
  corpus-k8s/            # sampled sections from Kubernetes-Workshop (pinned snapshot)
  corpus-opentofu/       # sampled sections from OpenTofu-Workshop — not yet vendored
  adversarial/           # hand-built hostile cases for constructs the real corpora lack
  adversarial-rejected/  # files extraction must refuse, each with the diagnostic it raises

  corpus-k8s-labs/           # sampled labs from Kubernetes-Workshop (pinned snapshot)
  corpus-opentofu-labs/      # sampled labs from OpenTofu-Workshop (pinned snapshot)
  adversarial-labs/          # hand-built hostile Markdown the real labs happen to lack
  adversarial-labs-rejected/ # lab files extraction must refuse, each with its diagnostic

  corpus-quiz/               # both consumer question banks (pinned snapshots)
  adversarial-quiz/          # hand-built hostile JSON: escapes, surrogates, formatting
  adversarial-quiz-rejected/ # quiz files extraction must refuse, each with its diagnostic

  catalogs/                  # PO catalogs for the catalog layer (spec 002)
```

`PROVENANCE.md` records where every file came from and which hostile construct it covers.

Rules:

- Every syntax construct used by either workshop must appear in the corpus (origin pack
  Phase 0 exit criterion).
- The round-trip property tests run over **every** file in `corpus-k8s/` and
  `adversarial/`, never a curated subset. `packages/extract-slidev/test/corpus.test.ts`
  additionally asserts that the corpus still *contains* the hostile constructs, so a
  corpus that quietly loses its teeth fails the build instead of passing it.
- The same holds for the lab and quiz trees: `packages/extract-markdown/test/corpus.test.ts`
  runs over every file in its corpus and adversarial trees, and
  `packages/extract-quiz/test/corpus.test.ts` over `corpus-quiz/` and `adversarial-quiz/`,
  each asserting its own hostile constructs are still present.
- **Both** consumer corpora must be represented, not one (ADR 0001/0010). The lab suite
  asserts the tree *names* it loads, so dropping a workshop fails loudly rather than
  quietly shrinking a count nobody reads.
- `adversarial-rejected/` exists so that "unsupported" stays a tested behaviour: each
  file must produce a named error diagnostic, and composition must still reproduce it
  byte-for-byte, because refusing is not the same as mangling. `adversarial-labs-rejected/`
  and `adversarial-quiz-rejected/` carry the same contract for their surfaces.
- A parser bug report becomes a failing fixture here before it becomes a fix.
- Fixtures are pinned snapshots — Renovate ignores this tree; refreshes are deliberate
  commits.

No golden output files are checked in for extraction: the assertion is a *property*
(`compose(extract(x), {})` equals `x`, byte for byte), which is stronger than a stored
expectation and cannot rot into agreeing with a regression.
