/**
 * Composition checked against the renderers that will actually read the deck: the
 * markdown renderer Slidev puts slide bodies through (`markdown-exit` 1.0.0-beta.9, via
 * `unplugin-vue-markdown`, with Slidev's options), and then Vue's own template parser
 * (`@vue/compiler-dom`, pinned to the consumer's Vue 3.5.39) over the HTML it emits.
 *
 * Every other guard test asserts against this package's idea of what markup is. Three
 * lanes lost a round to that idea being slightly narrower than the renderer's — a tag name
 * `<x_y>` or `<svg:a>` that this scanner read as text and Vue compiled as an element with a
 * live `v-html`. So here the oracle is Vue: a translated file must parse to the same
 * elements, attributes, directives, interpolations and parse errors as the English one.
 * Only text may differ. A composition that changes anything else must have been refused.
 *
 * Markdown first, because it changes what Vue sees: markdown-it decodes `&#123;&#123;` in
 * prose into a live `{{`, which a Vue-only oracle parsing the raw file never saw.
 *
 * Every slide is rendered whole, not the hole: a translation is judged in the context it
 * lands in (`Hallo Welt <img` swallows the `</div` after it only in context). Speaker
 * notes are rendered the same way; Slidev uses its own markdown-exit 1.1.0-beta.2 for them,
 * whose prose handling this oracle does not distinguish.
 *
 * What this oracle cannot see: Slidev's own markdown extensions — snippet imports
 * (`<<< @/file`), KaTeX blocks (`$$ {…}`), slot sugar, code-block wrappers. Their sinks are
 * held by direct tests in `skeleton.test.ts` and by the hostile payloads below, which the
 * guard must refuse before any renderer runs.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@vue/compiler-dom'
import { formatUnitId } from '@workshop-i18n/core'
import MarkdownExit from 'markdown-exit'
import { describe, expect, it } from 'vitest'
import { findSpeakerNote, parseSlidevDeck } from '../src/deck.js'
import { extractSlidevFile, type SlidevExtractOptions } from '../src/extract.js'
import { planSlideIds } from '../src/init-ids.js'
import { CompositionError, composeSkeleton, type Hole, type Skeleton } from '../src/skeleton.js'
import { decodeSource } from '../src/source.js'

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/', import.meta.url))

const OPTIONS: SlidevExtractOptions = {
  componentTextProps: { KwCard: ['heading'], CodeNote: ['label'] },
}

/** Translations that try to become markup, each in a shape a narrow scanner reads as text. */
const MARKUP_PAYLOADS: readonly string[] = [
  `Hallo <x_y v-html="'<'+'img src=x onerror=alert(1)>'"></x_y> Welt`,
  'Hallo <Foo.Bar v-on:click="x">y</Foo.Bar> Welt',
  'Hallo <svg:a onmouseover="alert(1)">x</svg:a> Welt',
  'Hallo <a"b onmouseover=alert(1)>x</a"b> Welt',
  'Hallo <img src=x onerror=alert(1)> Welt',
  'Hallo Welt <img',
  'Hallo </ div> Welt',
  'Hallo Welt </1',
  'Hallo <?x> Welt',
  'Hallo <!x> Welt',
  'Hallo <!-- x --> Welt',
  "Hallo {{ constructor.constructor('alert(1)')() }} Welt",
  'Hallo {{ Welt',
  'Hallo <b>fett</b> Welt',
  'Hallo < b Welt',
  'Hallo &#123;&#123; alert(1) &#125;&#125; Welt',
  'Hallo &lbrace;&lbrace;x&rbrace;&rbrace; Welt',
  'Hallo &#x7b;&#x7b;x&#x7d;&#x7d; Welt',
  'Hallo &lcub;&lcub;x&rcub;&rcub; Welt',
  'Hallo \\{\\{ x \\}\\} Welt',
  'Hallo &lt;img src=x onerror=alert(1)&gt; Welt',
  'Hallo\n<<< @/probe.json json {1}{onVnodeMounted: () => $slidev.nav.go(9)}',
  'Hallo\n<<< @/.env txt',
  'Hallo\n$$ {1}{onVnodeMounted: () => $slidev.nav.go(3)}\nx\n$$',
  'Hallo Welt',
]

/** Slidev's markdown options for slide bodies (`@slidev/cli` 52.19.0, `markdownOptions`). */
const markdown = MarkdownExit({ html: true, xhtmlOut: true, linkify: true, quotes: '""\'\'' })

interface Loaded {
  readonly name: string
  readonly english: string
  readonly skeleton: Skeleton
}

function load(directory: string): readonly Loaded[] {
  const base = join(FIXTURE_ROOT, directory)
  return readdirSync(base)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const english = planSlideIds(decodeSource(readFileSync(join(base, name)), name), {
        sectionId: name.replace(/\.md$/, ''),
      }).text
      return {
        name: `${directory}/${name}`,
        english,
        skeleton: extractSlidevFile(english, OPTIONS).skeleton,
      }
    })
}

const CORPUS = [...load('corpus-k8s'), ...load('adversarial')]

/** What the rendered slides compile to, minus the words: the shape a translation must keep. */
function renderedShape(file: string): ReadonlyMap<string, number> {
  const shape = new Map<string, number>()
  const add = (slide: number, part: string, entries: readonly string[]): void => {
    for (const entry of entries) {
      const key = `${slide}/${part}/${entry}`
      shape.set(key, (shape.get(key) ?? 0) + 1)
    }
  }
  for (const [index, slide] of parseSlidevDeck(file).slides.entries()) {
    const note = findSpeakerNote(file, slide.bodyStart, slide.bodyEnd)
    add(
      index,
      'body',
      vueShape(markdown.render(file.slice(slide.bodyStart, note?.start ?? slide.bodyEnd))),
    )
    if (note !== undefined) {
      add(index, 'note', vueShape(markdown.render(file.slice(note.innerStart, note.innerEnd))))
    }
  }
  return shape
}

/**
 * What `composed` renders to that the English does not: every interpolation, directive,
 * attribute, element, comment or parse error it holds more of. Formatting a translator
 * may legitimately add or drop — emphasis, a link's text, a list — is left out of the
 * shape (see {@link MARKDOWN_ELEMENTS}), so only what markdown cannot produce counts.
 */
function addedShape(
  composed: ReadonlyMap<string, number>,
  english: ReadonlyMap<string, number>,
): readonly string[] {
  return [...composed].filter(([key, count]) => count > (english.get(key) ?? 0)).map(([key]) => key)
}

/** Elements and attributes markdown itself produces from prose a translator may format. */
const MARKDOWN_ELEMENTS = new Set([
  'p',
  'br',
  'strong',
  'em',
  'code',
  's',
  'del',
  'a',
  'ul',
  'ol',
  'li',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'pre',
])
const MARKDOWN_ATTRIBUTES = new Set(['href', 'title', 'style', 'start'])

/** What Vue compiles out of `text`, minus the words. */
function vueShape(text: string): readonly string[] {
  const shape: string[] = []
  const root = parse(text, { onError: (error) => shape.push(`error:${error.code}`) })
  const visit = (node: { type: number; [key: string]: unknown }): void => {
    switch (node.type) {
      case 1: {
        const markdownElement = MARKDOWN_ELEMENTS.has(String(node.tag))
        if (!markdownElement) shape.push(`element:${String(node.tag)}`)
        for (const prop of node.props as { type: number; name: string; [key: string]: unknown }[]) {
          if (prop.type === 6) {
            if (!markdownElement || !MARKDOWN_ATTRIBUTES.has(prop.name)) {
              shape.push(`attribute:${String(node.tag)}:${prop.name}`)
            }
          } else {
            const arg = (prop.arg as { content?: string } | undefined)?.content ?? ''
            const exp = (prop.exp as { content?: string } | undefined)?.content ?? ''
            shape.push(`directive:${prop.name}:${arg}:${exp}`)
          }
        }
        break
      }
      case 3:
        shape.push('comment')
        break
      case 5:
        shape.push(`interpolation:${String((node.content as { content?: string }).content)}`)
        break
      default:
        break
    }
    for (const child of (node.children as { type: number }[] | undefined) ?? []) {
      visit(child as { type: number; [key: string]: unknown })
    }
  }
  visit(root as unknown as { type: number })
  return shape
}

/** One hole per encoding and landing shape, so every guard path is reached. */
function holesToTry(skeleton: Skeleton): readonly Hole[] {
  const byBucket = new Map<string, Hole>()
  for (const hole of skeleton.holes) {
    // Frontmatter is data a layout interpolates, escaped — Vue never compiles it as markup.
    if (hole.encoding.kind === 'yaml-scalar') continue
    const prefix = skeleton.source.slice(
      skeleton.source.lastIndexOf('\n', hole.start - 1) + 1,
      hole.start,
    )
    const shape = prefix === '' ? 'start' : prefix.trim() === '' ? 'blank' : 'text'
    const markup = /[<{]/.test(hole.source) ? 'markup' : 'plain'
    const bucket = `${hole.encoding.kind}/${shape}/${markup}`
    if (!byBucket.has(bucket)) byBucket.set(bucket, hole)
  }
  return [...byBucket.values()]
}

describe.each(CORPUS.map((item) => [item.name, item] as const))(
  'Vue compiles %s to the same shape after composition',
  (_name, item) => {
    const english = renderedShape(item.english)

    it.each(MARKUP_PAYLOADS)('when one unit becomes %j, or composition refuses it', (payload) => {
      for (const hole of holesToTry(item.skeleton)) {
        const id = formatUnitId(hole.id)
        let composed: string
        try {
          composed = composeSkeleton(item.skeleton, { [id]: payload })
        } catch (error) {
          expect(error).toBeInstanceOf(CompositionError)
          continue
        }
        expect(
          addedShape(renderedShape(composed), english),
          `${id} <- ${JSON.stringify(payload)}`,
        ).toEqual([])
      }
    })
  },
)
