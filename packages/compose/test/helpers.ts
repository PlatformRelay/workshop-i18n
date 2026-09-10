/** Shared test inputs. Not a test file itself (no `.test.` in the name). */

import { type Catalog, emptyCatalog, parseCatalog } from '@workshop-i18n/catalog-po'
import { type Manifest, parseManifest } from '@workshop-i18n/core'

export const MANIFEST: Manifest = parseManifest(`
apiVersion: workshop-i18n/v1
locales:
  source: en
  targets: [de, pt-BR]
surfaces:
  slides:
    include: ["slides/**/*.md"]
  labs:
    include: ["labs/**/*.md"]
  quiz:
    include: ["quiz/*.json"]
    schema: kubernetes-workshop
protectedTerms: [Pod, kubectl]
lengthBudgets:
  default: 1.4
  statement: 1.2
`)

export const DECK = `---
slideId: intro
layout: statement
heading: Welcome to the workshop
---

A Pod is the smallest unit.

\`\`\`bash
kubectl get pods
\`\`\`

---
slideId: second
---

# Second slide

Run \`kubectl apply\` in <v-click>the lab</v-click>.
`

export const LAB = `<!-- labId: lab-one -->
# Lab one

Do the thing with kubectl.

\`\`\`bash
kubectl apply -f pod.yaml
\`\`\`
`

export const QUIZ = `{
  "schemaVersion": 1,
  "questions": [
    {
      "id": "S01-Q-ONE-01",
      "section": "S01",
      "difficulty": "beginner",
      "prompt": "What is a Pod?",
      "options": [
        { "id": "a", "text": "A group of containers", "rationale": "Right." },
        { "id": "b", "text": "A node", "rationale": "Nodes run Pods." }
      ],
      "answer": "a",
      "explanation": "Pods group containers.",
      "learningObjective": "Name the smallest unit.",
      "references": ["https://kubernetes.io/docs/concepts/workloads/pods/"]
    }
  ]
}
`

/** One catalog entry to write: id, English msgid, translation and flags. */
export interface EntrySpec {
  readonly id: string
  readonly source: string
  readonly translation: string
  readonly flags?: readonly string[]
}

function poString(text: string): string {
  return JSON.stringify(text)
}

/** Build a catalog through the real PO codec, so tests exercise what a TMS would write. */
export function catalog(locale: string, name: string, entries: readonly EntrySpec[]): Catalog {
  if (entries.length === 0) return emptyCatalog({ locale, name })
  const body = entries
    .map((entry) =>
      [
        ...(entry.flags === undefined || entry.flags.length === 0
          ? []
          : [`#, ${entry.flags.join(', ')}`]),
        `msgctxt ${poString(entry.id)}`,
        `msgid ${poString(entry.source)}`,
        `msgstr ${poString(entry.translation)}`,
      ].join('\n'),
    )
    .join('\n\n')
  const text = `msgid ""\nmsgstr ""\n"Language: ${locale}\\n"\n"Content-Type: text/plain; charset=UTF-8\\n"\n\n${body}\n`
  return parseCatalog(text, { identity: { locale, name }, fileName: `${locale}/${name}.po` })
}
