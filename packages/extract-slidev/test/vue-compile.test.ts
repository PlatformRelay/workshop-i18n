/**
 * Composition checked against the renderer that will actually read the deck: Vue's own
 * template parser (`@vue/compiler-dom`, pinned to the consumer's Vue 3.5.39).
 *
 * Every other guard test asserts against this package's idea of what markup is. Three
 * lanes lost a round to that idea being slightly narrower than the renderer's — a tag name
 * `<x_y>` or `<svg:a>` that this scanner read as text and Vue compiled as an element with a
 * live `v-html`. So here the oracle is Vue: a translated file must parse to the same
 * elements, attributes, directives, interpolations and parse errors as the English one.
 * Only text may differ. A composition that changes anything else must have been refused.
 *
 * The whole file is parsed, not the hole: a translation is judged in the context it lands
 * in (`Hallo Welt <img` swallows the `</div` after it only in context).
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@vue/compiler-dom'
import { formatUnitId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
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
  'Hallo Welt',
]

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

/** What Vue compiles out of `text`, minus the words: the shape a translation must keep. */
function vueShape(text: string): readonly string[] {
  const shape: string[] = []
  const root = parse(text, { onError: (error) => shape.push(`error:${error.code}`) })
  const visit = (node: { type: number; [key: string]: unknown }): void => {
    switch (node.type) {
      case 1: {
        shape.push(`element:${String(node.tag)}`)
        for (const prop of node.props as { type: number; name: string; [key: string]: unknown }[]) {
          if (prop.type === 6) shape.push(`attribute:${prop.name}`)
          else {
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
  return shape.sort()
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
    const english = vueShape(item.english)

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
        expect(vueShape(composed), `${id} <- ${JSON.stringify(payload)}`).toEqual(english)
      }
    })
  },
)
