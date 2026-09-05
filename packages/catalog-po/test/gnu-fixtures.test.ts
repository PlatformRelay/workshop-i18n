import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PoSyntaxError, parsePo, serializePo } from '../src/index.js'

/**
 * The *reading* half of ADR 0013's interoperability bar.
 *
 * `msgfmt.test.ts` discharges the writing half: the reference reader compiles what we
 * write. The reading half cannot be discharged the same way, because until now every
 * catalog the codec was tested against was the codec's own authorship — including
 * `fixtures/catalogs/gnu-wrapped.po`, which imitates GNU column wrapping but was written
 * by hand to do so. "We read GNU wrapping correctly" was therefore a self-consistent
 * claim about our imitation, not a fact about gettext.
 *
 * `fixtures/catalogs/gnu-generated/` closes that: every file there is byte-for-byte what
 * a GNU tool emitted, regenerable by the script beside them. This file asserts the codec
 * reads them, and that what it writes back means the same thing to gettext.
 *
 * Note which half needs the tools. Parsing assertions run everywhere, because the
 * catalogs are committed. Only the two checks that ask *gettext itself* to judge our
 * output are gated — and gated the way `msgfmt.test.ts` gates: a named skip on a
 * developer machine, a hard failure under `CI`, so an unmet bar can never look like a
 * green run.
 */
const GNU = fileURLToPath(new URL('../../../fixtures/catalogs/gnu-generated/', import.meta.url))

const read = (name: string): string => readFileSync(join(GNU, name), 'utf8')

/** Catalogs GNU wrote that the codec accepts. Discovered, so a new fixture cannot be forgotten. */
const ACCEPTED = readdirSync(GNU)
  .filter((name) => name.endsWith('.po'))
  .sort()

/** Catalogs GNU wrote that the codec refuses. See the README beside them. */
const REFUSED = readdirSync(join(GNU, 'refused'))
  .filter((name) => name.endsWith('.po'))
  .sort()
  .map((name) => `refused/${name}`)

function gettextVersion(tool: string): string | undefined {
  const probe = spawnSync(tool, ['--version'], { encoding: 'utf8' })
  if (probe.error !== undefined || probe.status !== 0) return undefined
  return (probe.stdout.split('\n')[0] ?? '').trim()
}

const msgcatVersion = gettextVersion('msgcat')
const msgfmtVersion = gettextVersion('msgfmt')
const haveGettext = msgcatVersion !== undefined && msgfmtVersion !== undefined

/** True on GitHub Actions and every other runner that sets the conventional variable. */
const inCI = (process.env.CI ?? '') !== '' && process.env.CI !== 'false'

/**
 * gettext's own canonical spelling of a catalog: no wrapping, entries sorted. Two
 * catalogs with the same canonical form say the same thing to every gettext tool, which
 * is exactly the equivalence ADR 0013 claims its normalizations preserve.
 */
function canonicalise(text: string, label: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'workshop-i18n-msgcat-')), 'catalog.po')
  writeFileSync(path, text)
  const result = spawnSync('msgcat', ['--no-wrap', '--sort-output', path], { encoding: 'utf8' })
  expect(result.status, `${label}: ${result.stderr}`).toBe(0)
  return result.stdout
}

describe('catalogs GNU gettext actually wrote', () => {
  it('has fixtures for both outcomes', () => {
    expect(ACCEPTED.length).toBeGreaterThan(8)
    expect(REFUSED.length).toBeGreaterThan(1)
  })

  it.each(ACCEPTED)('parses %s', (name) => {
    expect(() => parsePo(read(name), { fileName: name })).not.toThrow()
  })

  /**
   * Re-writing a foreign catalog changes bytes — that is the point of owning a canonical
   * form — but it must change them *once*. A normalization that is not idempotent turns
   * every `extract` into a whole-file diff, which is the failure FR-005 exists to prevent.
   */
  it.each(ACCEPTED)('re-serializes %s to a fixed point', (name) => {
    const once = serializePo(parsePo(read(name), { fileName: name }))
    const twice = serializePo(parsePo(once, { fileName: name }))
    expect(twice).toBe(once)
  })

  /**
   * The one GNU spelling that already *is* our canonical form: `--no-wrap` output whose
   * entries happen to be in our order. Byte-exactness there is the strongest possible
   * statement that the two writers agree, with no normalization hiding a disagreement.
   */
  it('round-trips xgettext --no-wrap output byte for byte', () => {
    const text = read('xgettext-hostile-no-wrap.po')
    expect(serializePo(parsePo(text, { fileName: 'xgettext-hostile-no-wrap.po' }))).toBe(text)
  })
})

describe('what msgmerge --previous produces, read back', () => {
  const file = parsePo(read('msgmerge-previous.po'), { fileName: 'msgmerge-previous.po' })
  const byId = (msgid: string) => file.entries.find((entry) => entry.msgid === msgid)

  it('keeps the fuzzy flag and the previous source of an edited unit (FR-003)', () => {
    const entry = byId('A Pod is a group of one or more containers.')
    expect(entry?.flags).toEqual(['fuzzy'])
    expect(entry?.previous?.msgid).toBe('A Pod is a group of containers.')
    expect(entry?.msgstr).toEqual(['Ein Pod ist eine Gruppe von Containern.'])
  })

  it('keeps the extracted comment and the source reference', () => {
    const entry = byId('A Pod is a group of one or more containers.')
    expect(entry?.comments).toEqual([
      {
        marker: '.',
        text: ' TRANSLATORS: heading above the pod list; keep the word "Pod" untranslated.',
      },
      { marker: ':', text: ' src-v2.c:3' },
    ])
  })

  it('keeps a deleted unit as an obsolete entry with its translation (FR-004)', () => {
    const entry = byId('This unit is about to be deleted.')
    expect(entry?.obsolete).toBe(true)
    expect(entry?.msgstr).toEqual(['Diese Einheit wird gleich gelöscht.'])
    // GNU writes these two lines *unprefixed* in front of the `#~` block.
    expect(entry?.comments).toEqual([
      { marker: '', text: ' Translator note: wording taken from the 2024 glossary.' },
    ])
    expect(entry?.flags).toEqual(['no-c-format'])
  })

  it('reads plural forms and their msgid_plural', () => {
    const entry = byId('%d pod is running.')
    expect(entry?.msgidPlural).toBe('%d pods are running.')
    expect(entry?.msgstr).toEqual(['%d Pod läuft.', '%d Pods laufen.'])
    expect(entry?.flags).toEqual(['c-format'])
  })

  it('reads msgctxt', () => {
    const entry = byId('Services')
    expect(entry?.msgctxt).toBe('slides:s02:title')
    expect(entry?.msgstr).toEqual(['Dienste'])
  })

  /** GNU wraps at a column; the value it wrapped must come back whole. */
  it('recovers a column-wrapped value unwrapped', () => {
    const entry = byId(
      'A Pod is the smallest deployable unit in Kubernetes, and it wraps one or more ' +
        'containers that share a network namespace and a set of storage volumes.',
    )
    expect(entry).toBeDefined()
    expect(entry?.msgid).not.toContain('\n')
    expect(entry?.msgstr[0]).not.toContain('\n')
  })

  it('keeps embedded newlines and non-ASCII exactly', () => {
    const entry = byId('Grüße, 日本語 — first line\nand a second line.\n')
    expect(entry?.msgstr).toEqual(['Grüße, 日本語 — erste Zeile\nund eine zweite Zeile.\n'])
  })
})

describe('what the other GNU tools produce, read back', () => {
  it('reads `#~|` — previous source on an obsolete entry', () => {
    const name = 'msgmerge-obsolete-previous.po'
    const file = parsePo(read(name), { fileName: name })
    const entry = file.entries.find(
      (candidate) => candidate.msgid === 'A Pod is a group of one or more containers.',
    )
    expect(entry?.obsolete).toBe(true)
    expect(entry?.flags).toEqual(['fuzzy'])
    expect(entry?.previous?.msgid).toBe('A Pod is a group of containers.')
  })

  it('reads a catalog that is a header plus nothing but obsolete entries', () => {
    const name = 'msgattrib-only-obsolete.po'
    const file = parsePo(read(name), { fileName: name })
    expect(file.entries.filter((entry) => !entry.obsolete).map((entry) => entry.msgid)).toEqual([
      '',
    ])
    expect(file.entries.filter((entry) => entry.obsolete).length).toBe(2)
  })

  /** `msgcat --escape` spells every non-ASCII character as octal *bytes*. */
  it('decodes octal byte escapes back to the characters they encode', () => {
    const escaped = read('msgcat-escape.po')
    expect(escaped).toContain('\\303\\244')
    const file = parsePo(escaped, { fileName: 'msgcat-escape.po' })
    const entry = file.entries.find((candidate) => candidate.msgid === '%d pod is running.')
    expect(entry?.msgstr[0]).toBe('%d Pod läuft.')
  })

  it('reads indented style, where keywords carry leading whitespace', () => {
    const indented = read('msgcat-indent.po')
    expect(indented).toMatch(/^\s+"/m)
    const file = parsePo(indented, { fileName: 'msgcat-indent.po' })
    const entry = file.entries.find((candidate) => candidate.msgid === 'Services')
    expect(entry?.msgstr).toEqual(['Dienste'])
  })

  /** msgcat writes both candidates into the msgstr behind `#-#-#-#-#` markers. */
  it('reads a msgcat conflict marker as ordinary msgstr content', () => {
    const name = 'msgcat-conflict.po'
    const file = parsePo(read(name), { fileName: name })
    const entry = file.entries.find(
      (candidate) => candidate.msgid === 'A Service gives Pods a stable address.',
    )
    expect(entry?.msgstr[0]).toContain('#-#-#-#-#')
    expect(entry?.msgstr[0]).toContain('Ein Service gibt Pods eine stabile Adresse.')
    expect(entry?.msgstr[0]).toContain('Ein Dienst gibt Pods eine feste Adresse.')
  })

  it('reads a catalog that came back out of a compiled .mo', () => {
    const name = 'msgunfmt.po'
    const file = parsePo(read(name), { fileName: name })
    expect(file.entries.every((entry) => entry.comments.length === 0)).toBe(true)
    expect(file.entries.some((entry) => entry.msgctxt === 'slides:s02:title')).toBe(true)
  })

  /**
   * Wrapping at column 20 breaks nearly every string across many adjacent literals; the
   * value must reassemble with no wrap artefacts in it at all.
   */
  it('reassembles a value wrapped at an absurd column', () => {
    const name = 'msgcat-width20.po'
    const file = parsePo(read(name), { fileName: name })
    const entry = file.entries.find(
      (candidate) => candidate.msgid === 'A Service gives Pods a stable address.',
    )
    expect(entry?.msgstr).toEqual(['Ein Service gibt Pods eine stabile Adresse.'])
  })
})

/**
 * The normalizations ADR 0013 documents, pinned against real GNU output rather than
 * against our own description of it. Each one is deliberate; each one is idempotent
 * (proven above); none of them may become a *semantic* change (proven below).
 */
describe('normalizations applied to a GNU-written catalog', () => {
  const name = 'msgcat-no-wrap.po'
  const original = read(name)
  const written = serializePo(parsePo(original, { fileName: name }))

  it('re-flows column wrapping, breaking only at embedded newlines', () => {
    const wrapped = read('msgcat-width20.po')
    const reflowed = serializePo(parsePo(wrapped, { fileName: 'msgcat-width20.po' }))
    expect(reflowed).toContain('msgstr "Ein Service gibt Pods eine stabile Adresse."')
  })

  /**
   * `--no-wrap` output differs from ours in exactly one respect, and naming it is the
   * point: entry order. GNU keeps source order; we sort by `msgctxt` then `msgid`, which
   * is what makes a no-change extract a zero-byte diff (FR-005).
   */
  it('reorders entries into the canonical order, and changes nothing else', () => {
    expect(written).not.toBe(original)
    const block = (text: string): readonly string[] =>
      text
        .split('\n\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
    expect([...block(written)].sort()).toEqual([...block(original)].sort())
  })

  it('drops a BOM and normalises CRLF, without touching anything else', () => {
    const crlf = `﻿${original.replaceAll('\n', '\r\n')}`
    expect(serializePo(parsePo(crlf, { fileName: name }))).toBe(written)
  })

  it('re-emits octal byte escapes as the literal characters they encode', () => {
    const escaped = read('msgcat-escape.po')
    const reemitted = serializePo(parsePo(escaped, { fileName: 'msgcat-escape.po' }))
    expect(reemitted).not.toContain('\\303')
    expect(reemitted).toContain('%d Pod läuft.')
  })

  it('drops the leading whitespace of indented style', () => {
    const indented = read('msgcat-indent.po')
    const reemitted = serializePo(parsePo(indented, { fileName: 'msgcat-indent.po' }))
    expect(reemitted).not.toMatch(/^\s+"/m)
  })
})

/**
 * GNU output the codec refuses. Both files compile under `msgfmt` — they are valid
 * gettext, not garbage — so this is a deliberate limit of ours, recorded in ADR 0013 and
 * pinned here so it stays a decision rather than becoming an accident. Loosening it is a
 * change to make on purpose, with this test as the place to say so.
 */
describe('GNU output this codec deliberately refuses', () => {
  it.each(REFUSED)('refuses %s, naming the line', (name) => {
    try {
      parsePo(read(name), { fileName: name })
      expect.unreachable(`expected ${name} to be refused`)
    } catch (error) {
      expect(error).toBeInstanceOf(PoSyntaxError)
      expect((error as PoSyntaxError).message).toBe(
        `${name}:1: catalog does not start with a header entry (msgid "")`,
      )
    }
  })

  /**
   * The parser's other strictness — a comment block followed by no entry — is not
   * reachable from GNU output: no tool emits one. It is reachable from a *hand-edited*
   * catalog, and there the two readers disagree. gettext accepts the file and discards
   * the comment (asserted below where the tools are available); we refuse, because spec
   * 002 forbids dropping translator work silently. Pinning the divergence here keeps it
   * a choice.
   */
  it('refuses a trailing comment block a translator left on a GNU catalog', () => {
    const name = 'msgmerge-previous.po'
    const edited = `${read(name)}\n# a note the translator left at the end of the file\n`
    expect(() => parsePo(edited, { fileName: name })).toThrow(
      /comment block is not followed by an entry/,
    )
  })
})

describe('gettext agrees with what we write back', () => {
  it.runIf(!haveGettext && inCI)(
    'FAILS: gettext is required in CI — ADR 0013 makes interoperability the acceptance bar',
    () => {
      expect.unreachable(
        'msgcat and msgfmt are not installed on this CI runner, so the reading half of ' +
          'the gettext interoperability bar was never checked. Install gettext in the ' +
          'workflow rather than skipping this.',
      )
    },
  )

  /**
   * The claim ADR 0013's normalization list makes, put to gettext itself: reading a
   * GNU-written catalog and writing it back changes bytes but not meaning. Both sides are
   * reduced to `msgcat --no-wrap --sort-output`, gettext's own canonical spelling, so the
   * comparison is the tools' judgement rather than ours.
   */
  it.runIf(haveGettext)(
    `round-trips every fixture without semantic loss (${msgcatVersion ?? 'msgcat'})`,
    () => {
      for (const name of ACCEPTED) {
        const original = read(name)
        const written = serializePo(parsePo(original, { fileName: name }))
        expect(canonicalise(written, name), name).toBe(canonicalise(original, name))
      }
    },
  )

  /** The refused files are valid gettext. That is what makes their refusal a finding. */
  it.runIf(haveGettext)(
    `compiles every fixture, refused ones included (${msgfmtVersion ?? 'msgfmt'})`,
    () => {
      const workspace = mkdtempSync(join(tmpdir(), 'workshop-i18n-gnu-'))
      for (const name of [...ACCEPTED, ...REFUSED]) {
        const source = join(workspace, name.replace('/', '-'))
        writeFileSync(source, read(name))
        const result = spawnSync('msgfmt', ['--output-file', `${source}.mo`, source], {
          encoding: 'utf8',
        })
        expect(result.status, `${name}: ${result.stderr}`).toBe(0)
      }
    },
  )

  /** The other half of the disagreement pinned above: gettext reads it, then drops it. */
  it.runIf(haveGettext)('confirms gettext discards a trailing comment rather than refusing', () => {
    const note = '# a note the translator left at the end of the file'
    const edited = `${read('msgmerge-previous.po')}\n${note}\n`
    const canonical = canonicalise(edited, 'trailing comment')
    expect(canonical).not.toContain(note)
  })

  it.runIf(!haveGettext && !inCI)(
    'SKIPPED: gettext is not installed on this machine (hard failure under CI)',
    () => {
      expect(haveGettext).toBe(false)
    },
  )
})
