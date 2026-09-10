import { describe, expect, it } from 'vitest'
import { markupTokens, scanHtml } from '../src/html.js'

function kinds(text: string): readonly string[] {
  return scanHtml(text).map((token) => `${token.kind}:${text.slice(token.start, token.end)}`)
}

describe('scanHtml', () => {
  it('splits text, tags and interpolations, covering every byte exactly once', () => {
    const text =
      '<KwCard heading="A > B" kind=svc>\n  Hi {{ name }} <strong>there</strong>\n</KwCard>'
    const tokens = scanHtml(text)
    expect(tokens.map((token) => text.slice(token.start, token.end)).join('')).toBe(text)
    expect(kinds(text)).toEqual([
      'open:<KwCard heading="A > B" kind=svc>',
      'text:\n  Hi ',
      'interpolation:{{ name }}',
      'text: ',
      'open:<strong>',
      'text:there',
      'close:</strong>',
      'text:\n',
      'close:</KwCard>',
    ])
  })

  it('records attribute names and value ranges, quotes excluded', () => {
    const text = `<X a="one" b='two' c=three d :e="f" />`
    const [open] = scanHtml(text)
    expect(open?.kind).toBe('open')
    if (open?.kind !== 'open') return
    expect(open.selfClosing).toBe(true)
    expect(
      open.attributes.map((attribute) => [
        attribute.name,
        attribute.quote,
        attribute.valueStart < 0 ? null : text.slice(attribute.valueStart, attribute.valueEnd),
      ]),
    ).toEqual([
      ['a', '"', 'one'],
      ['b', "'", 'two'],
      ['c', '', 'three'],
      ['d', '', null],
      [':e', '"', 'f'],
    ])
  })

  it('reads a multi-line opening tag as one token', () => {
    expect(kinds('<KwCard\n  heading="x"\n  kind="pod"\n>body</KwCard>')[0]).toBe(
      'open:<KwCard\n  heading="x"\n  kind="pod"\n>',
    )
  })

  it('keeps a comment, a CDATA section and a doctype opaque', () => {
    expect(kinds('<!-- a <b> -->x<![CDATA[ <y> ]]><!DOCTYPE html>')).toEqual([
      'comment:<!-- a <b> -->',
      'text:x',
      'opaque:<![CDATA[ <y> ]]>',
      'opaque:<!DOCTYPE html>',
    ])
  })

  it('treats script and style contents as raw text, not markup', () => {
    expect(kinds('<style>a > b { }</style>')).toEqual([
      'open:<style>',
      'opaque:a > b { }',
      'close:</style>',
    ])
  })

  it('reads a bare angle bracket as text, not a tag', () => {
    expect(kinds('a < b and a<b')).toEqual(['text:a < b and a<b'])
  })

  it('reads a tag name the way Vue does: a letter, then anything up to space, / or >', () => {
    // A narrower grammar once read these as text while Vue compiled them as elements.
    for (const name of ['x_y', 'Foo.Bar', 'svg:a', 'a"b', 'https:']) {
      const [open] = scanHtml(`<${name} v-html="x">`)
      expect(open?.kind === 'open' && open.name, name).toBe(name)
    }
  })

  it('reads a closer that does not start with a letter as a bogus comment, never text', () => {
    expect(kinds('a </ div> b </1')).toEqual([
      'text:a ',
      'opaque:</ div>',
      'text: b ',
      'opaque:</1',
    ])
  })

  it('makes an unterminated tag opaque to the end instead of guessing where it ends', () => {
    expect(kinds('ok <KwCard heading="x')).toEqual(['text:ok ', 'opaque:<KwCard heading="x'])
  })

  it('makes an unterminated interpolation opaque to the end', () => {
    expect(kinds('a {{ b')).toEqual(['text:a ', 'opaque:{{ b'])
  })
})

describe('markupTokens', () => {
  it('lists the tags and interpolations a translation must keep, and nothing else', () => {
    expect(markupTokens('A <strong>b</strong> {{ c }} <!-- d --> &amp; e')).toEqual([
      '<strong>',
      '</strong>',
      '{{ c }}',
    ])
  })
})
