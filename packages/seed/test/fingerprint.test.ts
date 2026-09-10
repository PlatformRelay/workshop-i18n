import { describe, expect, it } from 'vitest'
import { fingerprintParts } from '../src/fingerprint.js'

const parts = (body: string, keys: readonly string[] = ['body/h1-1/title']) =>
  fingerprintParts(body, keys)

describe('fingerprintParts', () => {
  it('is blind to translated prose, translated fence comments and translated attribute prose', () => {
    const english = parts(`# One Pod

A Pod is **small**; see [docs](https://k8s.io/pods) and \`kubectl get pods\`.

<KwCard heading="Containers that share a context" kind="pod" icon="x">
  Prose inside a card.
</KwCard>

\`\`\`yaml
# the smallest pod
kind: Pod   # a comment after code
\`\`\`
`)
    const translated = parts(`# Um Pod

Um Pod é **pequeno**; veja [doc](https://k8s.io/pods) e \`kubectl get pods\`.

<KwCard heading="Containers que compartilham um contexto" kind="pod" icon="x">
  Prosa dentro de um card.
</KwCard>

\`\`\`yaml
# o menor pod
kind: Pod   # um comentário
\`\`\`
`)
    expect(translated).toEqual(english)
  })

  it.each([
    [
      'a different fence body',
      '```sh\nkubectl apply -f a.yaml\n```',
      '```sh\nkubectl delete -f a.yaml\n```',
    ],
    ['a different fence language', '```sh\nls\n```', '```bash\nls\n```'],
    ['a different code span', 'Run `kubectl get pods`.', 'Execute `kubectl get svc`.'],
    ['a different link target', 'See [a](https://a.example).', 'Veja [a](https://b.example).'],
    ['a different image', '![x](/img/a.png)', '![x](/img/b.png)'],
    ['a different component', '<KwCard kind="pod">x</KwCard>', '<KwCard kind="svc">x</KwCard>'],
    ['a different element', '<div class="a">x</div>', '<span class="a">x</span>'],
  ])('tells apart %s', (_label, left, right) => {
    expect(parts(left)).not.toEqual(parts(right))
  })

  it('tells apart different unit structure', () => {
    expect(parts('x', ['body/h1-1/title', 'body/h1-1/p-1'])).not.toEqual(
      parts('x', ['body/h1-1/title']),
    )
  })

  // Each of these was a real false divergence in PR #55.
  it.each([
    [
      'a translated component prop',
      '<ServiceRouting :step="$clicks" reason="readiness probe failing" />',
      '<ServiceRouting :step="$clicks" reason="com a readiness probe falhando" />',
    ],
    [
      'translated command output in a console fence',
      '```console {none|1-2}\n$ trivy image app\n0 known CVEs\n```',
      '```console {none|1-2}\n$ trivy image app\n0 CVEs conhecidos\n```',
    ],
    [
      'a code span re-wrapped across lines',
      'Run `helm install` now.',
      'Execute `helm\ninstall` agora.',
    ],
    [
      'a translated placeholder in the speaker note',
      '# T\n\nx\n\n<!--\nreturns as web-<newhash>\n-->\n',
      '# T\n\ny\n\n<!--\nvolta como web-<novohash>\n-->\n',
    ],
  ])('is blind to %s', (_label, left, right) => {
    expect(parts(left)).toEqual(parts(right))
  })

  it('still reads the bound and machinery attributes of a component', () => {
    expect(parts('<X :step="1" class="a" />')).not.toEqual(parts('<X :step="2" class="a" />'))
    expect(parts('<X class="a" />')).not.toEqual(parts('<X class="b" />'))
  })

  it('still reads a console fence whose line count changed', () => {
    expect(parts('```console\n$ a\nb\n```')).not.toEqual(parts('```console\n$ a\n```'))
  })

  it('does not read a URL out of a fence comment it has already stripped', () => {
    expect(parts('```sh\n# see https://a.example\nls\n```')).toEqual(
      parts('```sh\n# veja https://b.example\nls\n```'),
    )
  })
})
