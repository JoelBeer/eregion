import { describe, expect, it } from 'vitest'
import { BUILT_IN_CONNECTORS, customAgentProblems, customConnector, fillArgs, missingCapabilities, noCostLabel, type CustomAgent } from './connectors'

const aider: CustomAgent = { id: 'aider', name: 'Aider', command: 'aider', output: 'text', args: ['--yes', '--message', '{{prompt}}'], models: ['sonnet'] }

describe('custom agents', () => {
  it("works out what an agent can do from its output and whether it can carry on a conversation", () => {
    expect(customConnector(aider).capabilities).toEqual({ midRunMessages: false, followUps: false, tooling: false, blocksGit: false, reportsTokens: false, reportsCost: false })
    expect(customConnector({ ...aider, output: 'codex-jsonl', resumeArgs: ['resume', '{{session}}', '{{prompt}}'] }).capabilities).toMatchObject({ followUps: true, reportsTokens: true, reportsCost: false })
    expect(customConnector({ ...aider, output: 'claude-stream-json' }).capabilities).toMatchObject({ followUps: false, reportsCost: true })
  })

  it('checks the id, name, command and where {{session}} goes', () => {
    expect(customAgentProblems(aider, ['claude-code'])).toEqual([])
    expect(customAgentProblems({ ...aider, id: 'Aider!' }, [])).toEqual(['The id is 2 to 31 lowercase letters, numbers or dashes, starting with a letter'])
    expect(customAgentProblems(aider, ['aider'])).toEqual(["There's already an agent called aider"])
    expect(customAgentProblems({ ...aider, name: ' ', command: 'aider --yes' }, [])).toEqual(['Give it a name', 'The command is one program name or path, like aider or ~/bin/my-agent'])
    expect(customAgentProblems({ ...aider, args: ['{{session}}'], resumeArgs: ['--continue'] }, [])).toEqual([
      '{{session}} belongs in the follow-up arguments',
      'The follow-up arguments need {{session}}, so it carries on the same conversation'
    ])
  })

  it('fills the prompt, model and session into its arguments', () => {
    expect(fillArgs(['--model', '{{model}}', '-m', 'Do {{prompt}}', '--resume={{session}}'], { prompt: 'it', model: 'sonnet', session: 's-1' })).toEqual(['--model', 'sonnet', '-m', 'Do it', '--resume=s-1'])
  })
})

describe('missingCapabilities', () => {
  it("says what an agent can't do for a run, in words", () => {
    const [claude, cursor, codex] = BUILT_IN_CONNECTORS
    expect(missingCapabilities(claude, { followUps: true, tooling: true })).toEqual([])
    expect(missingCapabilities(codex, { followUps: true, tooling: true })).toEqual(["Codex CLI runs don't get per-run MCP servers or skills"])
    expect(missingCapabilities(customConnector(aider), { followUps: true })).toEqual(["Aider can't carry on a conversation, so it can't plan, chat in the Forge, or be asked to fix a file"])
    expect([noCostLabel(cursor), noCostLabel(codex), noCostLabel(customConnector(aider)), noCostLabel(undefined)]).toEqual(['Cursor plan', 'Codex plan', 'not reported', 'not reported'])
  })
})
