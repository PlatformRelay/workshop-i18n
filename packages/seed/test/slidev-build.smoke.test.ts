/**
 * Smoke test against a real `slidev build` — opt-in, because it needs a Slidev install.
 *
 * Unit tests model the renderer; this asks the renderer. Every refusal rule in
 * `unit-checks.ts` exists because some translation, accepted by an earlier rule set, built
 * into live code in a real deck. This keeps that loop closed: each hostile translation
 * below is either refused by seed, or — if seed accepts it — must build to exactly the
 * same live structure as its English.
 *
 * Run it with a directory holding a Slidev install (for example a consumer workshop
 * checkout after `pnpm install`):
 *
 *     WORKSHOP_I18N_SLIDEV_SMOKE=/path/to/workshop pnpm vitest run packages/seed/test/slidev-build.smoke.test.ts
 *
 * The test builds three throwaway decks in a temporary directory, linking that install's
 * `node_modules`; it never writes to the directory it is pointed at.
 *
 * What counts as "live structure", read from the built slide chunks: the elements the
 * compiled slides create and their attributes, resolved components (imported as their own
 * chunks), tags in hoisted static markup, Slidev's code-block, KaTeX and
 * Monaco wrappers, every payload's `seedSmokeProbe()` call compiled as code, and a canary
 * string planted in a local `.env` (a snippet import that reads it would publish it).
 * Inert text can produce none of these, so a translation that renders as prose leaves the
 * counts exactly as its English left them.
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SEED_LIMITS } from '../src/types.js'
import { checkTranslation } from '../src/unit-checks.js'

const INSTALL = process.env.WORKSHOP_I18N_SLIDEV_SMOKE
const CANARY = 'seed-smoke-canary-7f3a'

/** [English unit, hostile translation]. Every one of these was live in some earlier rule set. */
const CASES: readonly (readonly [string, string])[] = [
  [
    'Kubernetes schedules Pods.',
    'O Kubernetes agenda Pods.\n<<< @/probe.json json {1}{onVnodeMounted: () => seedSmokeProbe()}',
  ],
  ['Kubernetes schedules Pods.', 'O Kubernetes agenda Pods.\n<<< @/.env txt'],
  ['Kubernetes schedules Pods.', 'O Kubernetes agenda Pods.\n<<< @/probe.json json {monaco-write}'],
  [
    'Kubernetes schedules Pods.',
    'O Kubernetes agenda Pods.\n$$ {1}{onVnodeMounted: () => seedSmokeProbe()}\nx\n$$',
  ],
  ['Kubernetes schedules Pods.', 'O Kubernetes agenda $x^2$ Pods.'],
  [
    'Kubernetes schedules Pods.',
    'Use https://helm.sh/` &#123;&#123; seedSmokeProbe() &#125;&#125; `.',
  ],
  [
    'Kubernetes schedules Pods.',
    'O Kubernetes agenda &lcub;&lcub; seedSmokeProbe() &rcub;&rcub; Pods.',
  ],
  ['Kubernetes schedules Pods.', 'O Kubernetes agenda \\{\\{ seedSmokeProbe() \\}\\} Pods.'],
  ['Render `{{ x }}` in a chart.', 'Renderize [docs](/a`) {{ seedSmokeProbe() }} ` no chart.'],
  ['Press <kbd>Enter</kbd> now.', 'Pressione <kbd onclick="alert(1)">Enter</kbd> agora.'],
  ['Press <kbd>Enter</kbd> now.', 'Pressione <KBD>Enter</KBD> agora.'],
  ['Kubernetes schedules Pods.', 'O Kubernetes agenda [Pods]{onclick="alert(1)"}.'],
  ['Kubernetes schedules Pods.', 'O Kubernetes agenda Pods.\n::right::\ntexto'],
  // Code-span braces must not fund a prose MDC attribute block.
  [
    'Print names with `kubectl get pods -o jsonpath={.items[*].metadata.name}` today.',
    'Imprima nomes com **kubectl**{onclick="seedSmokeProbe()"} hoje.',
  ],
  // Every dollar and brace funded in prose: only the `$$` line rule stands in the way.
  [
    'Costs $1, $2, $3 and $4 using {a} and {b}.',
    'Custa:\n$$ {1}{onVnodeMounted: () => seedSmokeProbe()}\nx\n$$',
  ],
  ['See the docs now.', 'Veja ![x](./.env?raw) agora.'],
  ['See the docs now.', 'Veja ![x](./probe.json) agora.'],
  ['See the docs now.', 'Veja ![x][r] agora.\n\n[r]: ./.env?raw'],
  ['See [docs](./probe.json) now.', 'Veja ![docs](./probe.json) agora.'],
  ['Kubernetes schedules Pods.', 'O Kubernetes agenda :Toc Pods.'],
  ['Kubernetes schedules Pods.', 'O Kubernetes agenda Pods.\n\n::Toc\n::'],
  ['- See\n- the docs', '- Veja\n- ```plantuml\n@startuml\nA -> B\n@enduml'],
  ['See the docs.', 'Veja\n> ```mermaid\ngraph TD\nA --> B'],
  // Every spelling the MDC block rule accepts, with the English funding the line breaks.
  ['See\nthis\nnow\nplease.', 'Veja isto.\n:: Toc\n::'],
  ['See\nthis\nnow\nplease.', 'Veja isto.\n:: toc\n::'],
  ['See\nthis\nnow\nplease.', 'Veja isto.\n  ::   Toc\n::'],
  ['See\nthis\nnow\nplease.', 'Veja isto.\n:::Toc\n:::'],
  ['See\nthis\nnow\nplease.', 'Veja isto.\n::::Toc\n::::'],
  ['See\nthis\nnow\nplease.', 'Veja isto.\n:1 texto'],
  // Benign controls: accepted, and must build exactly like their English.
  ['Press <kbd>Enter</kbd> now.', 'Pressione <kbd>Enter</kbd> agora.'],
  ['Render `{{ x }}` in a chart.', 'Renderize `{{ x }}` no chart.'],
  ['Run `kubectl get pods` to **list** them.', 'Rode `kubectl get pods` para **listar** os Pods.'],
  [
    'See [the docs](https://kubernetes.io/docs) before you start.',
    'Veja [a documentação](https://kubernetes.io/docs) antes de começar.',
  ],
  [
    'Use <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop, then\nrun it again.',
    'Use <kbd>Ctrl</kbd>+<kbd>C</kbd> para parar e\nrode de novo.',
  ],
]

/** Translations seed must never accept, forced into the "teeth" deck to prove detection works. */
const KNOWN_LIVE: readonly string[] = [
  'O Kubernetes agenda Pods.\n<<< @/.env txt',
  'O Kubernetes agenda Pods.\n$$ {1}{onVnodeMounted: () => seedSmokeProbe()}\nx\n$$',
  'O Kubernetes agenda {{ seedSmokeProbe() }} Pods.',
  'O Kubernetes agenda :Toc Pods.',
  'Veja isto.\n:: toc\n::',
  'Imprima nomes com **kubectl**{onclick="seedSmokeProbe()"} hoje.',
]

function deck(bodies: readonly string[]): string {
  // `mdc: true`, so MDC syntax is live in all three decks alike.
  return `---\ntheme: default\nmdc: true\n---\n\n${bodies.map((body, index) => `# Slide ${index}\n\n${body}\n`).join('\n---\n\n')}`
}

function files(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

/** Build `slides` in a fresh project and read the live structure out of its slide chunks. */
function build(slides: string): Map<string, number> {
  const root = mkdtempSync(join(tmpdir(), 'seed-smoke-'))
  try {
    symlinkSync(join(INSTALL as string, 'node_modules'), join(root, 'node_modules'), 'dir')
    if (existsSync(join(INSTALL as string, 'package.json'))) {
      writeFileSync(
        join(root, 'package.json'),
        readFileSync(join(INSTALL as string, 'package.json')),
      )
    }
    writeFileSync(join(root, '.env'), `SECRET=${CANARY}\n`)
    writeFileSync(join(root, 'probe.json'), '{"name":"probe"}\n')
    writeFileSync(join(root, 'slides.md'), slides)
    const run = spawnSync(
      join(root, 'node_modules', '.bin', 'slidev'),
      ['build', 'slides.md', '--out', 'dist'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 300_000,
      },
    )
    const counts = new Map<string, number>()
    const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
    if (run.status !== 0) bump('build-failed')
    const chunks = existsSync(join(root, 'dist'))
      ? files(join(root, 'dist', 'assets')).filter((path) => /[\\/]md-[^\\/]*\.js$/.test(path))
      : []
    for (const chunk of chunks) {
      const code = readFileSync(chunk, 'utf8')
      // Element creation in the minified render functions: `c(\`kbd\`,null,…)`.
      for (const match of code.matchAll(/\(`([A-Za-z][\w-]*)`,(?:null|\{)/g)) {
        bump(`element:${match[1]}`)
      }
      // Attributes on created elements: `c(\`strong\`,{onclick:…},…)`.
      for (const match of code.matchAll(/\(`([A-Za-z][\w-]*)`,\{([^{}]*)\}/g)) {
        for (const key of (match[2] ?? '').matchAll(/([A-Za-z_$][\w$-]*):/g)) {
          bump(`attr:${match[1]}.${key[1]}`)
        }
      }
      // Resolved components arrive as imports of their own chunks (`./slidev/Toc-….js`), or,
      // when a slide is their only user, inlined with their `__name` into its chunk.
      for (const match of code.matchAll(/["'`]\.\/(?:slidev\/)?([A-Z][A-Za-z0-9]*)-[\w-]+\.js/g)) {
        bump(`component:${match[1]}`)
      }
      for (const match of code.matchAll(/__name:[`"']([A-Z][A-Za-z0-9]*)[`"']/g)) {
        bump(`component:${match[1]}`)
      }
      // Vue hoists static markup into HTML strings, so tags are read there too.
      for (const match of code.matchAll(/<([A-Za-z][\w-]*)/g)) bump(`markup:${match[1]}`)
      for (const match of code.matchAll(/\b(CodeBlockWrapper|KaTexBlockWrapper|Monaco)\b/g)) {
        bump(`live:${match[1]}`)
      }
      // Every payload calls `seedSmokeProbe()`. Compiled as code it is read off the render
      // context (`e.seedSmokeProbe`); left as text it is never preceded by a dot.
      for (const _ of code.matchAll(/\.seedSmokeProbe\b/g)) bump('live:probe')
      if (code.includes(CANARY)) bump('canary')
    }
    return counts
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe.skipIf(INSTALL === undefined)('seed against a real slidev build', () => {
  it('builds every translation seed accepts exactly like its English, and proves it would notice', () => {
    const verdicts = CASES.map(([english, translation]) => ({
      english,
      translation,
      accepted: checkTranslation(english, translation, DEFAULT_SEED_LIMITS).miss === undefined,
    }))
    const englishDeck = build(deck(verdicts.map((item) => item.english)))
    const seededDeck = build(
      deck(verdicts.map((item) => (item.accepted ? item.translation : item.english))),
    )
    const teethDeck = build(deck([...verdicts.map((item) => item.english), ...KNOWN_LIVE]))

    if (process.env.WORKSHOP_I18N_SLIDEV_SMOKE_DEBUG !== undefined) {
      console.log({ englishDeck, seededDeck, teethDeck })
    }
    expect(englishDeck.get('build-failed')).toBeUndefined()
    // The teeth: live payloads the rules refuse, forced in, are visible to this test — a
    // file read, a KaTeX wrapper with bound options, and a live interpolation.
    for (const payload of KNOWN_LIVE) {
      expect(
        checkTranslation('Kubernetes schedules Pods.', payload, DEFAULT_SEED_LIMITS).miss,
      ).toBe('markup-divergence')
    }
    expect(teethDeck.get('canary')).toBeGreaterThan(0)
    expect(teethDeck.get('live:KaTexBlockWrapper') ?? 0).toBeGreaterThan(
      englishDeck.get('live:KaTexBlockWrapper') ?? 0,
    )
    expect(teethDeck.get('live:probe') ?? 0).toBeGreaterThan(englishDeck.get('live:probe') ?? 0)
    expect(teethDeck.get('component:Toc') ?? 0).toBeGreaterThan(
      englishDeck.get('component:Toc') ?? 0,
    )
    expect(teethDeck.get('attr:strong.onclick') ?? 0).toBeGreaterThan(
      englishDeck.get('attr:strong.onclick') ?? 0,
    )
    // Plain slides are read too, or the comparison below would compare nothing.
    expect(englishDeck.get('element:kbd')).toBeGreaterThan(0)
    // The claim: whatever seed accepted builds to the same live structure as the English.
    expect(Object.fromEntries(seededDeck)).toEqual(Object.fromEntries(englishDeck))
    // And the benign controls were in fact accepted, so the comparison is not vacuous.
    expect(verdicts.filter((item) => item.accepted)).toHaveLength(5)
  }, 900_000)
})
