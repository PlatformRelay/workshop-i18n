import { describe, expect, it } from 'vitest'
import {
  checkLabIds,
  collectLabIds,
  LAB_ID_KEY,
  planLabId,
  proposeLabId,
  renderLabIdMarker,
} from '../src/lab-id.js'

const LAB = '# Lab 05 — Pod (S05)\n\n<!-- lab-contract:v1 -->\n\nRun the pod.\n'

describe('renderLabIdMarker', () => {
  it('renders the marker the corpus already models with <!-- lab-contract:v1 -->', () => {
    expect(renderLabIdMarker('day-1-05-pod')).toBe('<!-- labId: day-1-05-pod -->')
    expect(LAB_ID_KEY).toBe('labId')
  })
})

describe('proposeLabId', () => {
  it('prefers the repo-relative path stem, which is the lab’s stable human name', () => {
    expect(proposeLabId('Lab 05 — Pod (S05)', { pathStem: 'labs/day-1/05-pod' })).toBe(
      'labs-day-1-05-pod',
    )
  })

  it('falls back to the title when the path stem slugifies to nothing', () => {
    expect(proposeLabId('Lab 05 — Pod', { pathStem: '///' })).toBe('lab-05-pod')
  })

  it('falls back to a fixed stem when there is neither', () => {
    expect(proposeLabId(undefined, { pathStem: '' })).toBe('lab')
  })

  it('disambiguates against ids already taken', () => {
    expect(
      proposeLabId(undefined, { pathStem: 'day-1/05-pod', taken: new Set(['day-1-05-pod']) }),
    ).toBe('day-1-05-pod-2')
  })

  it('escapes a candidate that core would reject as a Windows device name', () => {
    expect(proposeLabId(undefined, { pathStem: 'con' })).toBe('con-lab')
  })

  it('always proposes something core accepts as a container id', () => {
    for (const stem of ['..', '../../etc/passwd', 'ÜBER/Größe', '9', 'a.', 'NUL']) {
      const id = proposeLabId(undefined, { pathStem: stem })
      expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    }
  })
})

describe('planLabId', () => {
  it('inserts the marker after the H1 title and changes nothing else', () => {
    const plan = planLabId(LAB, { pathStem: 'day-1/05-pod' })
    expect(plan.insertion).toBeDefined()
    expect(plan.labId).toBe('day-1-05-pod')
    expect(plan.text).toBe(
      '# Lab 05 — Pod (S05)\n\n<!-- labId: day-1-05-pod -->\n\n<!-- lab-contract:v1 -->\n\nRun the pod.\n',
    )
  })

  it('is an insertion only — deleting exactly what it added gives the original back', () => {
    const plan = planLabId(LAB, { pathStem: 'day-1/05-pod' })
    const insertion = plan.insertion
    if (insertion === undefined) throw new Error('expected an insertion')
    const undone =
      plan.text.slice(0, insertion.offset) +
      plan.text.slice(insertion.offset + insertion.text.length)
    expect(undone).toBe(LAB)
  })

  it('is idempotent: a second run changes nothing', () => {
    const once = planLabId(LAB, { pathStem: 'day-1/05-pod' }).text
    const twice = planLabId(once, { pathStem: 'day-1/05-pod' })
    expect(twice.text).toBe(once)
    expect(twice.insertion).toBeUndefined()
    expect(twice.labId).toBe('day-1-05-pod')
  })

  it('inserts at the top when the file does not open with a heading', () => {
    const plan = planLabId('Just prose.\n', { pathStem: 'notes' })
    expect(plan.text).toBe('<!-- labId: notes -->\n\nJust prose.\n')
  })

  it('inserts after a byte-order mark, never before it', () => {
    const plan = planLabId('﻿Just prose.\n', { pathStem: 'notes' })
    expect(plan.text.startsWith('﻿')).toBe(true)
    expect(plan.text).toBe('﻿<!-- labId: notes -->\n\nJust prose.\n')
  })

  // A marker this run writes but the next run cannot read is worse than no marker: the
  // codemod stops being idempotent, and every re-run leaves another dead comment behind
  // in English source. So what is asserted here is a *second* run and a read-back, not
  // the first run's bytes — pinning first-run output is exactly what hid this.
  describe('a byte-order mark does not break the round trip through the marker', () => {
    const BOM_LAB = '﻿# Lab 05 — Pod (S05)\n\nRun the pod.\n'

    it('still inserts after the H1, exactly as it does without the mark', () => {
      expect(planLabId(BOM_LAB, { pathStem: 'day-1/05-pod' }).text).toBe(
        '﻿# Lab 05 — Pod (S05)\n\n<!-- labId: day-1-05-pod -->\n\nRun the pod.\n',
      )
    })

    it('reads back the marker it just wrote', () => {
      const once = planLabId(BOM_LAB, { pathStem: 'day-1/05-pod' }).text
      expect(collectLabIds(once).map((record) => record.labId)).toEqual(['day-1-05-pod'])
    })

    it('is idempotent: the second run inserts nothing', () => {
      const once = planLabId(BOM_LAB, { pathStem: 'day-1/05-pod' }).text
      const twice = planLabId(once, { pathStem: 'day-1/05-pod' })
      expect(twice.text).toBe(once)
      expect(twice.insertion).toBeUndefined()
      expect(twice.labId).toBe('day-1-05-pod')
    })

    it('passes --check, rather than reporting the identity it just wrote as missing', () => {
      const once = planLabId(BOM_LAB, { pathStem: 'day-1/05-pod' }).text
      expect(checkLabIds([{ path: 'labs/day-1/05-pod.md', source: once }])).toEqual([])
    })

    it('reads a marker sharing the first line with the mark', () => {
      expect(collectLabIds('﻿<!-- labId: day-1-05-pod -->\n\nProse.\n')).toHaveLength(1)
    })
  })

  it('uses the line break the file already uses', () => {
    const plan = planLabId('# Lab\r\n\r\nProse.\r\n', { pathStem: 'x' })
    expect(plan.text).toBe('# Lab\r\n\r\n<!-- labId: x -->\r\n\r\nProse.\r\n')
  })

  it('does not mistake a heading inside a fence for the title', () => {
    const source = '```md\n# Not the title\n```\n\nProse.\n'
    expect(planLabId(source, { pathStem: 'x' }).text).toBe(`<!-- labId: x -->\n\n${source}`)
  })

  it('reads the whole H1 when the file has no trailing newline', () => {
    // The title was derived as slice(0, offset - 1), which assumed the heading line ended
    // with a newline; on the last line of a file without one it lost the final character
    // (`# Lab Zero Five` proposed `lab-zero-fiv`). Only reachable through the title
    // fallback, so the path stem is made to slugify to nothing on purpose.
    expect(planLabId('# Lab Zero Five', { pathStem: '///' }).labId).toBe('lab-zero-five')
    expect(planLabId('# Lab Zero Five\n', { pathStem: '///' }).labId).toBe('lab-zero-five')
  })

  it('strips a closing hash run from the title', () => {
    expect(planLabId('# Lab Zero Five #\n', { pathStem: '///' }).labId).toBe('lab-zero-five')
  })

  it('refuses to overwrite an identity a human already wrote, even an unsafe one', () => {
    const source = '# Lab\n\n<!-- labId: ../escape -->\n\nProse.\n'
    const plan = planLabId(source, { pathStem: 'x' })
    expect(plan.text).toBe(source)
    expect(plan.insertion).toBeUndefined()
    expect(plan.diagnostics.map((item) => item.code)).toEqual(['unsafe-lab-id'])
  })

  it('reports a second marker as a duplicate rather than silently taking the first', () => {
    const source = '# Lab\n\n<!-- labId: a -->\n\n<!-- labId: b -->\n\nProse.\n'
    expect(planLabId(source, { pathStem: 'x' }).diagnostics.map((item) => item.code)).toEqual([
      'duplicate-lab-id',
    ])
  })
})

describe('collectLabIds', () => {
  it('ignores a marker inside a fenced code block', () => {
    const source = '# Lab\n\n```md\n<!-- labId: fake -->\n```\n\n<!-- labId: real -->\n'
    expect(collectLabIds(source).map((record) => record.labId)).toEqual(['real'])
  })

  it('ignores a marker inside a tilde fence', () => {
    const source = '~~~\n<!-- labId: fake -->\n~~~\n'
    expect(collectLabIds(source)).toEqual([])
  })

  it('reports the line of each marker', () => {
    expect(collectLabIds('# Lab\n\n<!-- labId: real -->\n')[0]?.line).toBe(3)
  })
})

describe('checkLabIds', () => {
  it('passes an adopted corpus', () => {
    expect(
      checkLabIds([
        { path: 'labs/a.md', source: '<!-- labId: a -->\n' },
        { path: 'labs/b.md', source: '<!-- labId: b -->\n' },
      ]),
    ).toEqual([])
  })

  it('fails on a missing identity, naming the file', () => {
    const issues = checkLabIds([{ path: 'labs/a.md', source: '# Lab\n' }])
    expect(issues.map((issue) => issue.code)).toEqual(['missing-lab-id'])
    expect(issues[0]?.message).toContain('labs/a.md')
  })

  it('fails on a duplicate identity, naming both files', () => {
    const issues = checkLabIds([
      { path: 'labs/a.md', source: '<!-- labId: same -->\n' },
      { path: 'labs/b.md', source: '<!-- labId: same -->\n' },
    ])
    expect(issues.map((issue) => issue.code)).toEqual(['duplicate-lab-id'])
    expect(issues[0]?.message).toContain('labs/a.md')
    expect(issues[0]?.message).toContain('labs/b.md')
  })

  it('fails on an identity that is not usable as a file name', () => {
    const issues = checkLabIds([{ path: 'labs/a.md', source: '<!-- labId: ../escape -->\n' }])
    expect(issues.map((issue) => issue.code)).toEqual(['unsafe-lab-id'])
  })
})
