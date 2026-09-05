import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CatalogIdentity } from '../src/index.js'
import { CatalogError, PoSyntaxError, parseCatalog, parsePo, serializePo } from '../src/index.js'

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
 * catalogs are committed. Only the checks that hand something *back* to gettext — to
 * judge our round trip, to compile the fixtures, or to run the remedy an error message
 * recommends — are gated, and gated the way `msgfmt.test.ts` gates: a named skip on a
 * developer machine, a hard failure under `CI`, so an unmet bar can never look like a
 * green run.
 */
const GNU = fileURLToPath(new URL('../../../fixtures/catalogs/gnu-generated/', import.meta.url))

const read = (name: string): string => readFileSync(join(GNU, name), 'utf8')

/** Catalogs GNU wrote that the codec accepts. Discovered, so a new fixture cannot be forgotten. */
const ACCEPTED = readdirSync(GNU)
  .filter((name) => name.endsWith('.po'))
  .sort()

/** Catalogs GNU wrote that we refuse, at one layer or another. See the README beside them. */
const REFUSED = readdirSync(join(GNU, 'refused'))
  .filter((name) => name.endsWith('.po'))
  .sort()
  .map((name) => `refused/${name}`)

/** Any identity will do — none of these catalogs gets far enough for it to matter. */
const IDENTITY: CatalogIdentity = { locale: 'de', name: '03-pods' }

/**
 * The subset the *codec* refuses, derived by asking it rather than by reading the file
 * name. Selecting on a `header` substring worked for today's two files and would have
 * quietly swept in any future fixture whose name happened to contain the word. What makes
 * these tests worth anything is the exact message asserted below, so membership is settled
 * by "does `parsePo` refuse it" and the reason is settled by the assertion.
 */
const HEADERLESS = REFUSED.filter((name) => {
  try {
    parsePo(read(name), { fileName: name })
    return false
  } catch {
    return true
  }
})

function gettextVersion(tool: string): string | undefined {
  const probe = spawnSync(tool, ['--version'], { encoding: 'utf8' })
  if (probe.error !== undefined || probe.status !== 0) return undefined
  return (probe.stdout.split('\n')[0] ?? '').trim()
}

const msgcatVersion = gettextVersion('msgcat')
const msgfmtVersion = gettextVersion('msgfmt')
const haveGettext = ['msgcat', 'msgfmt', 'msgen', 'msgconv'].every(
  (tool) => gettextVersion(tool) !== undefined,
)

/**
 * The charset complaint the catalog layer raises, or `undefined` when it is happy. Any
 * other rejection is not this test's business — these are foreign catalogs and they fail
 * this tool's own `msgctxt` convention regardless.
 */
function charsetRefusal(text: string, fileName: string): string | undefined {
  try {
    parseCatalog(text, { identity: IDENTITY, fileName })
  } catch (error) {
    const { message } = error as Error
    return message.includes('charset') ? message : undefined
  }
  return undefined
}

/**
 * Which of the refusals this directory exists to pin actually fired, or `undefined` when
 * none did.
 *
 * The catalog layer is deliberately *not* asked the blunt question "did you throw?". It
 * throws for every catalog here — none of them uses this tool's `msgctxt` unit-id
 * convention — so a bare try/catch reports a refusal for any file at all, including one
 * that was never refused for the reason claimed. Only the two named refusals count.
 */
function refusalOf(name: string): 'no-header' | 'charset' | undefined {
  const text = read(name)
  try {
    parsePo(text, { fileName: name })
  } catch {
    return 'no-header'
  }
  return charsetRefusal(text, name) === undefined ? undefined : 'charset'
}

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
 * GNU output we refuse. All three compile under plain `msgfmt` — they are valid gettext,
 * not garbage — so these are deliberate limits of ours, recorded in ADR 0013 and pinned
 * here so they stay decisions rather than becoming accidents. Loosening one is a change to
 * make on purpose, with these tests as the place to say so. (`msgfmt --check` is stricter
 * and refuses the two headerless catalogs, so on that shape gettext's own strict mode
 * agrees with us; it accepts the ISO-8859-1 one, which leaves that refusal ours alone.)
 *
 * The two shapes are refused at different layers, and that is not a detail: the codec
 * (`parsePo`) refuses a headerless catalog because a PO file without `msgid ""` is
 * structurally incomplete, while the catalog layer (`parseCatalog`) refuses a non-UTF-8
 * charset, because that is a policy of this tool rather than of the format.
 */
describe('GNU output this codec deliberately refuses', () => {
  /**
   * The guard on the directory itself: every file under `refused/` must be refused for
   * one of the two reasons this directory claims, and adding a fourth fixture must not
   * earn a green tick it did not deserve.
   *
   * The first version of this test asked only "did some layer throw?", which made it
   * inert — `parseCatalog` throws for every foreign catalog over the `msgctxt` convention,
   * so an accepted catalog dropped into `refused/` passed. A fixture that trips neither
   * named refusal now fails here, and the right response is to give it its own test rather
   * than to widen this one.
   */
  it.each(REFUSED)('refuses %s for a reason this directory claims', (name) => {
    expect(
      refusalOf(name),
      `${name} sits under refused/ but neither refusal fired: it is either accepted now, ` +
        'or refused for a new reason that needs a test of its own',
    ).toBeDefined()
  })

  it('has a fixture for each refusal it claims', () => {
    expect(REFUSED.map(refusalOf)).toEqual(expect.arrayContaining(['no-header', 'charset']))
    expect(HEADERLESS.length).toBeGreaterThan(1)
  })

  it.each(HEADERLESS)('refuses %s, naming the line', (name) => {
    try {
      parsePo(read(name), { fileName: name })
      expect.unreachable(`expected ${name} to be refused`)
    } catch (error) {
      expect(error).toBeInstanceOf(PoSyntaxError)
      expect((error as PoSyntaxError).message).toBe(
        `${name}:1: catalog has no header entry (msgid ""), so its encoding and plural ` +
          'rules are undeclared — synthesize one with `msgen <file> | msgconv ' +
          '--to-code=UTF-8`, or re-export the catalog from your TMS with its header ' +
          '(`--omit-header` output is a template for diffing, not a catalog to ship)',
      )
    }
  })

  /**
   * The message a translator is left holding has to name the way out, not just the rule
   * — the shape `packages/core` uses for its reserved-locale rejection, where the message
   * is all a facilitator typing `--locale con` will ever read. Asserted separately from
   * the exact string above so that what matters about it survives a rewording.
   *
   * `msgconv` is in the advice, not decoration: `msgen` and `msginit` both synthesize a
   * header declaring `charset=ASCII`, which this tool then refuses at the catalog layer.
   * Advice that walks the reader into a second wall is not advice, so the pipe is part of
   * it — and the test below runs the whole thing to prove it lands somewhere better.
   */
  it.each(HEADERLESS)('tells the reader how to fix %s, not only what is wrong', (name) => {
    try {
      parsePo(read(name), { fileName: name })
      expect.unreachable(`expected ${name} to be refused`)
    } catch (error) {
      const { message } = error as PoSyntaxError
      // Commands that produce a header this tool will accept, so the reader can act.
      expect(message).toContain('msgen')
      expect(message).toContain('msgconv --to-code=UTF-8')
      // And where a headerless catalog comes from, so they recognise their own situation.
      expect(message).toContain('--omit-header')
    }
  })

  /**
   * The second shape, and the reason the section is no longer called "the one shape":
   * any catalog is one `msgconv` away from declaring a charset we refuse, and `msgfmt`
   * compiles the result happily.
   */
  it('refuses a catalog that declares a charset other than UTF-8', () => {
    const name = 'refused/msgconv-iso-8859-1.po'
    const text = read(name)
    // The codec is indifferent — this is a policy of the tool, not of the format.
    expect(() => parsePo(text, { fileName: name })).not.toThrow()
    try {
      parseCatalog(text, { identity: IDENTITY, fileName: name })
      expect.unreachable('expected a non-UTF-8 charset to be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogError)
      expect((error as CatalogError).message).toContain('charset "ISO-8859-1"')
    }
  })

  /**
   * The rule is written as an ordering rule and kept that way deliberately: narrowing it
   * to "a header exists somewhere" would newly *accept* a hand-edited catalog with a late
   * header, a behaviour change nobody asked for. But the condition and the message have
   * to agree. Telling someone whose header sits at line 17 to synthesize a header is
   * advice they cannot act on, so the message branches even though what is accepted does
   * not. No GNU producer can reach this branch — every one of them writes the header
   * first — which is exactly why it is worth a test rather than a comment.
   */
  it('tells a late header apart from a missing one', () => {
    const blocks = read('msgcat-no-wrap.po')
      .split('\n\n')
      .filter((entry) => entry.trim() !== '')
    const [header, first, ...rest] = blocks
    const moved = `${[first, header, ...rest].join('\n\n')}\n`

    try {
      parsePo(moved, { fileName: 'late-header.po' })
      expect.unreachable('expected a late header to be refused')
    } catch (error) {
      const { message } = error as PoSyntaxError
      expect(message).toContain('does not start with its header entry')
      // It names where the header actually is, instead of claiming there is none.
      expect(message).toMatch(/header is at line \d+/)
      expect(message).not.toContain('msgen')
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

  /**
   * The refused files are valid gettext. That is what makes their refusal a finding. Plain
   * `msgfmt` is the right bar here: `--check` additionally enforces the header we are
   * arguing about, so using it would beg the question.
   */
  it.runIf(haveGettext)(
    `compiles every fixture, refused ones included (${msgfmtVersion ?? 'msgfmt'})`,
    () => {
      const workspace = mkdtempSync(join(tmpdir(), 'workshop-i18n-gnu-'))
      for (const name of [...ACCEPTED, ...REFUSED]) {
        const source = join(workspace, name.replace('/', '-'))
        // Bytes, not text: one fixture is genuinely ISO-8859-1, and decoding it as UTF-8
        // on the way through would hand msgfmt a file no tool ever produced.
        writeFileSync(source, readFileSync(join(GNU, name)))
        const result = spawnSync('msgfmt', ['--output-file', `${source}.mo`, source], {
          encoding: 'utf8',
        })
        expect(result.status, `${name}: ${result.stderr}`).toBe(0)
      }
    },
  )

  /**
   * The remedy the error message names, executed rather than asserted. This is the shape
   * of mistake worth guarding: the first version of that message said `msginit` or
   * `msgen`, both of which do synthesize a header — declaring `charset=ASCII`, which the
   * catalog layer then refuses. The advice was true and useless. Running it here means a
   * future reword cannot quietly reintroduce a dead end.
   */
  it.runIf(haveGettext)('fixes a headerless catalog by following its own error message', () => {
    for (const name of HEADERLESS) {
      const source = join(mkdtempSync(join(tmpdir(), 'workshop-i18n-remedy-')), 'in.po')
      writeFileSync(source, readFileSync(join(GNU, name)))

      // Exactly what the message says: msgen <file> | msgconv --to-code=UTF-8
      const generated = spawnSync('msgen', [source], { encoding: 'utf8' })
      expect(generated.status, `msgen ${name}: ${generated.stderr}`).toBe(0)
      const converted = spawnSync('msgconv', ['--to-code=UTF-8'], {
        encoding: 'utf8',
        input: generated.stdout,
      })
      expect(converted.status, `msgconv ${name}: ${converted.stderr}`).toBe(0)

      // The codec now accepts it, and the charset gate no longer fires.
      expect(() => parsePo(converted.stdout, { fileName: name })).not.toThrow()
      expect(charsetRefusal(converted.stdout, name)).toBeUndefined()

      // Whereas msgen alone — the advice that message used to give — walks into a wall.
      expect(charsetRefusal(generated.stdout, name)).toContain('charset "ASCII"')
    }
  })

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
