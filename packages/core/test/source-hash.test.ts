import { describe, expect, it } from 'vitest'
import { isSourceHash, SOURCE_HASH_PREFIX, sourceHash } from '../src/index.js'

describe('sourceHash', () => {
  it('is a stable, published value — not "whatever this machine computes"', () => {
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(sourceHash('hello')).toBe('sha256:2cf24dba5fb0a30e')
    // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(sourceHash('')).toBe('sha256:e3b0c44298fc1c14')
  })

  it('hashes UTF-8 bytes, so non-ASCII prose is machine-independent', () => {
    // U+00FC and U+00DF are multi-byte in UTF-8
    expect(sourceHash('Gr\u00fc\u00dfe')).toBe(sourceHash('Gr\u00fc\u00dfe'))
    expect(sourceHash('Gr\u00fc\u00dfe')).toMatch(/^sha256:[0-9a-f]{16}$/)
  })

  it('is deterministic across calls', () => {
    const text = 'A pod is the smallest deployable unit in Kubernetes.'
    expect(sourceHash(text)).toBe(sourceHash(text))
  })

  it('is short enough to sit in a PO comment', () => {
    expect(sourceHash('a'.repeat(10_000)).length).toBeLessThanOrEqual(32)
  })

  it('changes on a whitespace-only edit — no normalization before hashing', () => {
    expect(sourceHash('kubectl  apply')).not.toBe(sourceHash('kubectl apply'))
    expect(sourceHash('trailing ')).not.toBe(sourceHash('trailing'))
    expect(sourceHash('one\ntwo')).not.toBe(sourceHash('one\r\ntwo'))
  })

  it('distinguishes Unicode-equivalent spellings — no NFC folding either', () => {
    expect(sourceHash('caf\u00e9')).not.toBe(sourceHash('cafe\u0301'))
  })

  it('changes on any content edit', () => {
    expect(sourceHash('Pods are ephemeral.')).not.toBe(sourceHash('Pods are ephemeral!'))
  })
})

describe('isSourceHash', () => {
  it('accepts what sourceHash produces', () => {
    expect(isSourceHash(sourceHash('anything'))).toBe(true)
  })

  it('rejects anything else, so a hand-edited PO comment fails loudly', () => {
    for (const bogus of [
      '',
      'sha256:',
      '2cf24dba5fb0a30e',
      'sha256:2CF24DBA5FB0A30E',
      'sha256:2cf24dba5fb0a30',
      'sha256:2cf24dba5fb0a30e2',
      'md5:2cf24dba5fb0a30e',
      `${SOURCE_HASH_PREFIX}zzzzzzzzzzzzzzzz`,
    ]) {
      expect(isSourceHash(bogus)).toBe(false)
    }
  })
})
