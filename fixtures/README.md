# Fixtures — hostile corpus and goldens

Golden corpora and adversarial cases for the round-trip and gate tests (ADR 0010).

```text
fixtures/
  corpus-k8s/            # sampled sections from Kubernetes-Workshop (pinned snapshot)
  corpus-opentofu/       # sampled sections from OpenTofu-Workshop — not yet vendored
  adversarial/           # hand-built hostile cases for constructs the real corpora lack
  adversarial-rejected/  # files extraction must refuse, each with the diagnostic it raises
```

`PROVENANCE.md` records where every file came from and which hostile construct it covers.

Rules:

- Every syntax construct used by either workshop must appear in the corpus (origin pack
  Phase 0 exit criterion).
- The round-trip property tests run over **every** file in `corpus-k8s/` and
  `adversarial/`, never a curated subset. `packages/extract-slidev/test/corpus.test.ts`
  additionally asserts that the corpus still *contains* the hostile constructs, so a
  corpus that quietly loses its teeth fails the build instead of passing it.
- `adversarial-rejected/` exists so that "unsupported" stays a tested behaviour: each
  file must produce a named error diagnostic, and composition must still reproduce it
  byte-for-byte, because refusing is not the same as mangling.
- A parser bug report becomes a failing fixture here before it becomes a fix.
- Fixtures are pinned snapshots — Renovate ignores this tree; refreshes are deliberate
  commits.

No golden output files are checked in for extraction: the assertion is a *property*
(`compose(extract(x), {})` equals `x`, byte for byte), which is stronger than a stored
expectation and cannot rot into agreeing with a regression.
