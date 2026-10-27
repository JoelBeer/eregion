import { describe, expect, it } from 'vitest'
import type { AgentEvent } from './agent'
import { buildLog, Redactor, withholdsOutput, type BuildLogRun } from './buildLog'
import type { RunSummary } from './runs'

function run(id: number, stage: string, stageName: string, events: AgentEvent[], extra: Partial<RunSummary> = {}): BuildLogRun {
  const summary: RunSummary = {
    id,
    ticketId: 1,
    chatId: null,
    stage,
    crewId: null,
    adapter: 'claude-code',
    model: 'opus',
    loop: 1,
    sessionId: null,
    startedAt: '2026-10-20 09:41:00',
    endedAt: '2026-10-20 10:02:00',
    endNote: null,
    result: 'done',
    tokensIn: null,
    tokensOut: null,
    tokensCached: null,
    costUsd: null,
    ...extra
  }
  return { run: summary, stageName, events }
}

const writtenAt = new Date('2026-10-21T09:07:00Z')

describe('buildLog', () => {
  it('writes each run as a conversation, then the verdicts and build notes', () => {
    const long = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n')
    const log = buildLog({
      ticket: { key: 'WM-1', title: 'Show a hint', branch: 'wm-1-show-a-hint' },
      runs: [
        run(1, 'build', 'Build', [
          { kind: 'user', text: 'Stage: Build. The whole prompt.' },
          { kind: 'text', text: 'I will add the hint.' },
          { kind: 'tool', id: 't1', name: 'Read', summary: 'read app/hint.ts' },
          { kind: 'tool-result', id: 't1', ok: true, output: 'export const hint = 1' },
          { kind: 'tool', id: 't2', name: 'Bash', summary: '$ npm test' },
          { kind: 'tool-result', id: 't2', ok: true, output: long },
          { kind: 'tool', id: 't3', name: 'Edit', summary: 'edited app/hint.ts' },
          { kind: 'tool-result', id: 't3', ok: false, output: 'Tool call was denied.' },
          { kind: 'user', text: 'Use the existing view.' },
          { kind: 'text', text: 'Done.' },
          { kind: 'result', ok: true, text: '', costUsd: null, usage: null, turns: 2 }
        ]),
        run(2, 'review', 'Review', [{ kind: 'user', text: 'Stage: Review' }, { kind: 'text', text: 'Pass.' }], { adapter: 'cursor', model: 'gpt-5', endedAt: '2026-10-20 16:41:00' })
      ],
      verdicts: [{ stageName: 'Review', reviews: [{ loop: 1, verdict: 'pass', summary: 'Good.', issues: [{ id: 'r1-1', severity: 'low', repo: 'app', file: 'hint.ts', line: 3, problem: 'Name | unclear', fix: 'Rename' }], spec: [{ id: 'S1', met: true, evidence: 'Two wrong guesses show the hint (ran it).' }] }] }],
      spec: '# Spec · WM-1 · Show a hint\n\n## Behaviour\n- S1: Two wrong guesses show the first letter',
      buildNotes: '# Build notes\n\n## Summary\nAdded the hint.',
      writtenAt
    })
    expect(log).toContain('# Build log: WM-1 Show a hint\n\n- Branch: `wm-1-show-a-hint`\n- Models: claude-code/opus, cursor/gpt-5\n- Started 2026-10-20 09:41 UTC, last activity 2026-10-20 16:41 UTC\n- 2 runs, 1 message from the person, 3 agent replies, 3 tool calls\n- Written 2026-10-21 09:07 UTC.')
    // Eregion's prompt is left out; your later messages are in.
    expect(log).not.toContain('The whole prompt')
    expect(log).toContain('_Eregion started the Build stage with its prompt (left out here)._')
    expect(log).toContain('### Person\n\nUse the existing view.')
    // Reads show no output, commands show the first 12 lines, and errors show what went wrong.
    expect(log).toContain('- Tool: `read app/hint.ts`\n\n')
    expect(log).toContain('    line 12\n    ```\n    _... 8 more lines_')
    expect(log).not.toContain('line 13')
    expect(log).toContain('- Tool: `edited app/hint.ts`\n  - Error:\n\n    ```\n    Tool call was denied.\n    ```')
    expect(log).toContain('### Review\n\n> RESULT: PASS\n\nGood.\n\n| # | Severity | Where | Problem | Fix |')
    expect(log).toContain('| r1-1 | low | `app/hint.ts:3` | Name \\| unclear | Rename |')
    expect(log).toContain('| Spec | Status | Evidence |\n|---|---|---|\n| S1 | Met | Two wrong guesses show the hint (ran it). |')
    expect(log).toContain('## Appendix: reviews\n\n### Spec\n\n#### Spec · WM-1 · Show a hint\n\n##### Behaviour\n- S1: Two wrong guesses show the first letter')
    // The notes' headings sit under the appendix's.
    expect(log).toContain('### Build notes\n\n#### Build notes\n\n##### Summary\nAdded the hint.')
  })

  it('numbers passes of a stage that ran more than once', () => {
    const log = buildLog({ ticket: { key: 'WM-1', title: 'Hint', branch: null }, runs: [run(1, 'build', 'Build', []), run(2, 'build', 'Build', [], { loop: 2 })], verdicts: [], buildNotes: null, writtenAt })
    expect(log.match(/^## .*/gm)).toEqual(['## Build, pass 1', '## Build, pass 2'])
    expect(log).not.toContain('Branch')
    expect(log).not.toContain('Appendix')
  })

  it('takes secrets and personal details out of everything it writes', () => {
    const log = buildLog({
      ticket: { key: 'WM-1', title: 'Hint', branch: null },
      runs: [
        run(1, 'build', 'Build', [
          { kind: 'user', text: 'prompt' },
          { kind: 'text', text: 'Mail sam@example.com about /Users/joel/app.' },
          { kind: 'tool', id: 't1', name: 'Bash', summary: '$ git remote -v' },
          { kind: 'tool-result', id: 't1', ok: true, output: 'origin https://joel:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/me/app.git\nSAM@example.com' },
          { kind: 'tool', id: 't2', name: 'Bash', summary: '$ cat .env' },
          { kind: 'tool-result', id: 't2', ok: true, output: 'STRIPE_KEY=whatever' }
        ])
      ],
      verdicts: [],
      buildNotes: null,
      writtenAt
    })
    expect(log).toContain('**Agent:** Mail [email-1] about ~/app.')
    expect(log).toContain('origin https://[secret]@github.com/me/app.git')
    expect(log).toContain('    [email-1]\n')
    expect(log).toContain('- Tool: `$ cat .env`\n  - Output withheld: it may hold secrets or live data.')
    expect(log).not.toContain('whatever')
    expect(log).not.toContain('ghp_')
  })
})

describe('Redactor', () => {
  const redact = (text: string): string => new Redactor().redact(text)

  it('replaces token shapes, secret values and private keys', () => {
    expect(redact('token lin_api_abcdefghijklmnopqrstuvwxyz')).toBe('token [secret]')
    expect(redact('Authorization: Bearer abcdefghijklmnop.qrs')).toBe('Authorization: Bearer [secret]')
    expect(redact('export GITHUB_TOKEN="abc12345"')).toBe('export GITHUB_TOKEN="[secret]"')
    expect(redact('db_password: hunter22')).toBe('db_password: [secret]')
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')).toBe('[private key]')
    expect(redact('AKIAABCDEFGHIJKLMNOP')).toBe('[secret]')
  })

  it("shortens the ticket's folders", () => {
    const redactor = new Redactor({ '/Users/joel/.eregion/wm/work/WM-1': '', '/Users/joel/.eregion/wm/tickets/WM-1/': 'outputs/' })
    expect(redactor.redact('read /Users/joel/.eregion/wm/work/WM-1/app/hint.ts and /Users/joel/.eregion/wm/tickets/WM-1/plan.md')).toBe('read app/hint.ts and outputs/plan.md')
  })

  it('leaves ordinary code and paths alone', () => {
    expect(redact('const author = "Sam"')).toBe('const author = "Sam"')
    expect(redact('src/home/index.ts')).toBe('src/home/index.ts')
    expect(redact('react@18.3.1')).toBe('react@18.3.1')
  })
})

describe('withholdsOutput', () => {
  it('holds back what commands that read secrets or live data printed', () => {
    expect(withholdsOutput('$ cat .env.local')).toBe(true)
    expect(withholdsOutput('$ printenv')).toBe(true)
    expect(withholdsOutput('$ gh auth status')).toBe(true)
    expect(withholdsOutput('$ psql -c "select * from users"')).toBe(true)
    expect(withholdsOutput('$ npm test')).toBe(false)
    expect(withholdsOutput('$ git status')).toBe(false)
  })
})
