import { describe, expect, it } from 'vitest'
import { fromRecord, placeholdersIn, render } from './template'
import { evaluateArithmetic, resolveVariables } from './variables'

describe('render', () => {
  const lookup = fromRecord({ 'ticket.key': 'PP-412', slot: 3, empty: '' })

  it('fills placeholders and reports missing ones', () => {
    expect(render('herd link api-{{ticket.key}}', lookup)).toEqual({ text: 'herd link api-PP-412', missing: [], unknownFilters: [] })
    expect(render('{{nope}} and {{ slot }}', lookup).missing).toEqual(['nope'])
    expect(render('{{nope}} and {{ slot }}', lookup).text).toBe('{{nope}} and 3')
  })

  it('applies filters left to right', () => {
    expect(render('perchpeak_{{ticket.key | snake}}', lookup).text).toBe('perchpeak_pp_412')
    expect(render('api-{{ticket.key|slug}}.test', lookup).text).toBe('api-pp-412.test')
    expect(render('{{ticket.key | lower | upper}}', lookup).text).toBe('PP-412')
    expect(render('{{ticket.key | shout}}', lookup).unknownFilters).toEqual(['shout'])
  })

  it('keeps an if block only when its value is not empty', () => {
    expect(render('a{{#if slot}} slot {{slot}}{{/if}}b', lookup).text).toBe('a slot 3b')
    expect(render('a{{#if empty}}x{{/if}}b', lookup).text).toBe('ab')
    expect(render('a{{#if missing}}x{{/if}}b', lookup).text).toBe('ab')
  })

  it('lists the placeholders a template uses', () => {
    expect(placeholdersIn('{{a}} {{b | slug}} {{a}} {{#if c}}{{/if}}')).toEqual(['a', 'b', 'c'])
  })
})

describe('evaluateArithmetic', () => {
  it('handles precedence, brackets and negatives', () => {
    expect(evaluateArithmetic('3000 + 3')).toBe(3003)
    expect(evaluateArithmetic('2 + 3 * 4')).toBe(14)
    expect(evaluateArithmetic('(2 + 3) * 4')).toBe(20)
    expect(evaluateArithmetic('7 / 2')).toBe(3)
    expect(evaluateArithmetic('-2 + 5')).toBe(3)
  })

  it('rejects anything that is not arithmetic', () => {
    expect(() => evaluateArithmetic('1 / 0')).toThrow()
    expect(() => evaluateArithmetic('2 +')).toThrow()
    expect(() => evaluateArithmetic('rm -rf')).toThrow()
  })
})

describe('resolveVariables', () => {
  const builtins = { slot: '3', 'ticket.key': 'PP-412' }

  it('resolves the PerchPeak example in any order', () => {
    const { values, errors } = resolveVariables(
      [
        { name: 'app_url', formula: 'http://localhost:{{web_port}}' },
        { name: 'web_port', formula: '3000 + {{slot}}' },
        { name: 'db_name', formula: 'perchpeak_{{ticket.key | snake}}' },
        { name: 'api_host', formula: 'api-{{ticket.key | slug}}.test' },
        { name: 'api_url', formula: 'https://{{api_host}}' }
      ],
      builtins
    )
    expect(errors).toEqual({})
    expect(values).toEqual({
      app_url: 'http://localhost:3003',
      web_port: '3003',
      db_name: 'perchpeak_pp_412',
      api_host: 'api-pp-412.test',
      api_url: 'https://api-pp-412.test'
    })
  })

  it('does not treat plain numbers or dashes in words as arithmetic', () => {
    const { values } = resolveVariables([{ name: 'port', formula: '8100' }, { name: 'host', formula: 'a-1.test' }], builtins)
    expect(values).toEqual({ port: '8100', host: 'a-1.test' })
  })

  it('reports cycles, unknown names and bad names per variable', () => {
    const { values, errors } = resolveVariables(
      [
        { name: 'a', formula: '{{b}}' },
        { name: 'b', formula: '{{a}}' },
        { name: 'c', formula: '{{nothing}}' },
        { name: 'Bad-Name', formula: '1' },
        { name: 'ok', formula: '{{slot}}' }
      ],
      builtins
    )
    expect(values).toEqual({ ok: '3' })
    expect(Object.keys(errors).sort()).toEqual(['Bad-Name', 'a', 'b', 'c'])
    expect(errors.c).toContain('nothing')
  })
})
