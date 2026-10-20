import { describe, expect, it } from 'vitest'
import { parseTestOutput } from './agents'

describe('parseTestOutput', () => {
  it('reads a successful Claude Code reply with its usage and cost', () => {
    const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.0021, usage: { input_tokens: 9, output_tokens: 2 } })
    expect(parseTestOutput(stdout, '', 0)).toEqual({ ok: true, signedIn: true, usageReported: true, costUsd: 0.0021, detail: 'ok' })
  })

  it('spots a signed-out CLI', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' })
    expect(parseTestOutput(stdout, '', 1)).toMatchObject({ ok: false, signedIn: false })
  })

  it('reports output that is not JSON as it came', () => {
    expect(parseTestOutput('', 'zsh: command not found: claude', 127)).toMatchObject({ ok: false, detail: 'zsh: command not found: claude' })
  })
})
