import { describe, expect, it } from 'vitest'
import type { PoEntry } from '../src/index.js'
import { parsePo, serializePo } from '../src/index.js'

/**
 * ADR 0013 makes round-tripping a proven property, not a claim. The generator is
 * seeded so a failure is reproducible on any machine (constitution IV): the same run
 * produces the same corpus every time, and the seed is printed with the case.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_0000_0000
  }
}

/** Every character class that has ever broken a PO writer, plus ordinary prose. */
const ALPHABET = [
  'a',
  'Z',
  '0',
  ' ',
  '  ',
  '"',
  '\\',
  '\n',
  '\t',
  '\r',
  '\u0000',
  '\u0007',
  '\u001f',
  '\u007f',
  'ü',
  'ß',
  'é',
  '日',
  '🎉',
  '%s',
  '`code`',
  '**bold**',
  '#~',
  '#|',
  'msgid',
  '—',
]

function randomString(random: () => number, maxParts: number): string {
  const parts = Math.floor(random() * maxParts)
  let out = ''
  for (let index = 0; index < parts; index += 1) {
    const pick = ALPHABET[Math.floor(random() * ALPHABET.length)]
    out += pick ?? 'a'
  }
  return out
}

function randomEntry(random: () => number, index: number): PoEntry {
  const comments: PoEntry['comments'] = Array.from(
    { length: Math.floor(random() * 3) },
    (_, commentIndex) => ({
      marker: (['', '.', ':'] as const)[Math.floor(random() * 3)] ?? '',
      text: ` c${commentIndex} ${randomString(random, 3).replace(/[\n\r]/g, ' ')}`,
    }),
  )
  const flags = random() < 0.4 ? ['fuzzy'] : []
  const entry: {
    -readonly [K in keyof PoEntry]: PoEntry[K]
  } = {
    comments,
    flags,
    msgctxt: `slides:c${String(index).padStart(3, '0')}:body/1`,
    msgid: randomString(random, 8),
    msgstr: [randomString(random, 8)],
    obsolete: random() < 0.2,
    line: 0,
  }
  if (random() < 0.3) entry.previous = { msgid: randomString(random, 4) }
  return entry
}

function randomFile(seed: number) {
  const random = makeRandom(seed)
  const header: PoEntry = {
    comments: [],
    flags: [],
    msgctxt: undefined,
    msgid: '',
    msgstr: ['Language: de\nContent-Type: text/plain; charset=UTF-8\n'],
    obsolete: false,
    line: 0,
  }
  const count = 1 + Math.floor(random() * 12)
  return {
    entries: [header, ...Array.from({ length: count }, (_, index) => randomEntry(random, index))],
  }
}

describe('PO codec round-trip (property)', () => {
  const seeds = Array.from({ length: 200 }, (_, index) => index + 1)

  it('serialize -> parse -> serialize is a fixed point for every generated catalog', () => {
    for (const seed of seeds) {
      const once = serializePo(randomFile(seed))
      const twice = serializePo(parsePo(once, { fileName: `seed-${seed}.po` }))
      expect(twice, `seed ${seed}`).toBe(once)
    }
  })

  it('parse recovers every payload byte-for-byte, including hostile escaping', () => {
    for (const seed of seeds) {
      const original = randomFile(seed)
      const reparsed = parsePo(serializePo(original), { fileName: `seed-${seed}.po` })
      const payload = (file: { entries: readonly PoEntry[] }) =>
        file.entries
          .map((entry) => ({
            comments: entry.comments,
            flags: entry.flags,
            previous: entry.previous,
            msgctxt: entry.msgctxt,
            msgid: entry.msgid,
            msgstr: entry.msgstr,
            obsolete: entry.obsolete,
          }))
          .sort((a, b) => ((a.msgctxt ?? '') < (b.msgctxt ?? '') ? -1 : 1))
      expect(payload(reparsed), `seed ${seed}`).toEqual(payload(original))
    }
  })
})

describe('PO codec round-trip (hostile singles)', () => {
  const hostile: readonly (readonly [string, string])[] = [
    ['embedded quotes', 'He said "hello" loudly'],
    ['backslashes', 'C:\\\\path\\to\\file and a trailing \\'],
    ['literal newlines', 'line one\nline two\nline three\n'],
    ['tabs', 'col1\tcol2\tcol3'],
    ['carriage return', 'old mac\rstyle'],
    ['non-ASCII', 'Grüße, 日本語, Ελληνικά, עברית, 🎉🇩🇪'],
    ['NUL and DEL', 'before\u0000middle\u007fafter'],
    ['very long', 'lorem ipsum '.repeat(2000)],
    ['empty', ''],
    ['only a newline', '\n'],
    ['po syntax inside the payload', 'msgid "not really"\n#~ msgstr "nor this"\n#| msgid "x"'],
    ['markdown left literal', 'Use `kubectl get pods` and **note** the [link](https://x/y)'],
  ]

  for (const [name, payload] of hostile) {
    it(`round-trips ${name} in msgid, msgstr and previous-source`, () => {
      const entry: PoEntry = {
        comments: [],
        flags: [],
        previous: { msgid: payload },
        msgctxt: 'slides:a:body/1',
        msgid: payload,
        msgstr: [payload],
        obsolete: false,
        line: 0,
      }
      const header: PoEntry = {
        comments: [],
        flags: [],
        msgctxt: undefined,
        msgid: '',
        msgstr: ['Language: de\n'],
        obsolete: false,
        line: 0,
      }
      const text = serializePo({ entries: [header, entry] })
      const back = parsePo(text, { fileName: 'hostile.po' }).entries[1]
      expect(back?.msgid).toBe(payload)
      expect(back?.msgstr).toEqual([payload])
      expect(back?.previous?.msgid).toBe(payload)
      expect(serializePo(parsePo(text, { fileName: 'hostile.po' }))).toBe(text)
    })
  }
})
