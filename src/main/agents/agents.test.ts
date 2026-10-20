import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { firstSentence, summariseTool, type AgentEvent } from '@shared/agent'
import { NativeRunner } from '../runner/native'
import { parseClaudeLine, parseCursorLine, parseCodexLine } from './parse'
import { BLOCKED_COMMANDS, claudeArgs, startAgent, type AgentStartOptions, codexArgs } from './session'
import { BUILT_IN_CONNECTORS, customConnector } from '@shared/connectors'

const CLAUDE = BUILT_IN_CONNECTORS[0]
const CODEX = BUILT_IN_CONNECTORS[2]

const FAKE = ['node', resolve('src/main/testing/fake-claude.mjs')]

describe('parseClaudeLine (lines captured from Claude Code 2.1.303)', () => {
  it('reads init, tool use, tool results, text and the result', () => {
    expect(parseClaudeLine('{"type":"system","subtype":"init","cwd":"/tmp/p","session_id":"003d","model":"claude-haiku-5-5","permissionMode":"acceptEdits"}')).toEqual([
      { kind: 'init', sessionId: '003d', model: 'claude-haiku-5-5' }
    ])
    expect(
      parseClaudeLine('{"type":"assistant","message":{"model":"claude-haiku-5-5","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"echo probe-ok","description":"Print"}}]},"parent_tool_use_id":null}')
    ).toEqual([{ kind: 'tool', id: 'toolu_1', name: 'Bash', summary: '$ echo probe-ok' }])
    expect(parseClaudeLine('{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"probe-ok","is_error":false}]},"parent_tool_use_id":null}')).toEqual([
      { kind: 'tool-result', id: 'toolu_1', ok: true, output: 'probe-ok' }
    ])
    expect(parseClaudeLine('{"type":"assistant","message":{"content":[{"type":"text","text":"DONE"}]},"parent_tool_use_id":null}')).toEqual([{ kind: 'text', text: 'DONE' }])
    expect(
      parseClaudeLine(
        '{"duration_api_ms":4933,"stop_reason":"end_turn","session_id":"003d","total_cost_usd":0.00239112,"usage":{"input_tokens":4,"cache_creation_input_tokens":10430,"cache_read_input_tokens":26222,"output_tokens":85},"is_error":false,"num_turns":2,"subtype":"success","result":"DONE","type":"result"}'
      )
    ).toEqual([{ kind: 'result', ok: true, text: 'DONE', costUsd: 0.00239112, usage: { input: 10434, output: 85, cached: 26222 }, turns: 2 }])
  })

  it('ignores rate limit events, helper agents and other noise', () => {
    expect(parseClaudeLine('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}')).toEqual([])
    expect(parseClaudeLine('{"type":"assistant","message":{"content":[{"type":"text","text":"x"}]},"parent_tool_use_id":"toolu_9"}')).toEqual([])
    expect(parseClaudeLine('{"type":"system","subtype":"commands_changed"}')).toEqual([])
    expect(parseClaudeLine('not json')).toEqual([{ kind: 'system', text: 'not json' }])
  })
})

describe('parseCursorLine', () => {
  it('reads Cursor tool calls and results', () => {
    expect(parseCursorLine('{"type":"tool_call","subtype":"started","call_id":"c1","tool_call":{"shellToolCall":{"args":{"command":"php artisan test"}}}}')).toEqual([
      { kind: 'tool', id: 'c1', name: 'Bash', summary: '$ php artisan test' }
    ])
    expect(parseCursorLine('{"type":"tool_call","subtype":"completed","call_id":"c1","tool_call":{"shellToolCall":{"result":{"success":{"stdout":"ok"}}}}}')).toEqual([
      { kind: 'tool-result', id: 'c1', ok: true, output: 'ok' }
    ])
    expect(parseCursorLine('{"type":"result","subtype":"success","is_error":false,"result":"Done.","usage":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":4}}')).toEqual([
      { kind: 'result', ok: true, text: 'Done.', costUsd: null, usage: { input: 10, output: 2, cached: 4 }, turns: 1 }
    ])
  })
})

describe('shared helpers', () => {
  it('summarises tools and finds the first sentence for speech bubbles', () => {
    expect(summariseTool('Edit', { file_path: 'app/Models/User.php' })).toBe('edited app/Models/User.php')
    expect(firstSentence('2 tests failing. Fixing the UTC offset now.')).toBe('2 tests failing.')
    expect(firstSentence('No full stop here')).toBe('No full stop here')
    expect(firstSentence('a'.repeat(100)).length).toBe(80)
  })

  it('blocks the git and gh commands Eregion owns, and makes the Forge read-only', () => {
    const base = { connector: CLAUDE, runner: new NativeRunner(), cwd: '/tmp', model: 'sonnet', prompt: 'x' } as const
    const build = claudeArgs({ ...base, profile: 'build', addDirs: ['/out'] })
    expect(build).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--add-dir', '/out', ...BLOCKED_COMMANDS]))
    expect(claudeArgs({ ...base, profile: 'chat' })).toEqual(expect.arrayContaining(['--permission-mode', 'plan']))
  })

  it("passes a run's MCP servers strictly, its allowed MCP tools, and turns off skills you haven't allowed", () => {
    const base = { connector: CLAUDE, runner: new NativeRunner(), cwd: '/tmp', model: 'sonnet', prompt: 'x', profile: 'build' } as const
    const args = claudeArgs({ ...base, mcpConfig: '{"mcpServers":{}}', allowedTools: ['mcp__laravel-boost', 'Skill'], deniedTools: ['Skill(deploy)'], settings: '{"skillOverrides":{"deploy":"off"}}' })
    expect(args.join(' ')).toContain("--allowedTools Bash Read Edit Write Glob Grep WebFetch WebSearch TodoWrite mcp__laravel-boost Skill --disallowedTools")
    expect(args.slice(args.indexOf('--disallowedTools')).join(' ')).toContain('Skill(deploy)')
    expect(args.slice(args.indexOf('--mcp-config'))).toEqual(['--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config', '--settings', '{"skillOverrides":{"deploy":"off"}}'])
  })
})

describe.skipIf(process.platform === 'win32')('AgentSession with a fake Claude Code', () => {
  async function run(prompt: string, extra: Partial<AgentStartOptions> = {}) {
    const cwd = await mkdtemp(join(tmpdir(), 'eregion-agent-'))
    const session = startAgent({ connector: CLAUDE, runner: new NativeRunner(), cwd, model: 'fake', prompt, profile: 'build', command: FAKE, ...extra })
    return { session, cwd }
  }

  it('runs one turn, records events and reports cost and tokens', async () => {
    const { session, cwd } = await run('write notes.md hello')
    const outcome = await session.done
    expect(outcome).toMatchObject({ state: 'done', sessionId: 'fake-session-1', lastText: 'You said: write notes.md hello.', costUsd: 0.01, usage: { input: 105, output: 20, cached: 50 } })
    expect(await readFile(join(cwd, 'notes.md'), 'utf8')).toBe('hello')
    expect(session.events.map((event: AgentEvent) => event.kind)).toEqual(['init', 'tool', 'tool-result', 'text', 'result'])
  })

  it('delivers a "send now" message during a turn, then ends after it', async () => {
    const { session } = await run('slow')
    await new Promise((done) => setTimeout(done, 300))
    expect(session.send('also this', 'now')).toBe('delivered')
    const outcome = await session.done
    expect(outcome.lastText).toBe('You said: also this.')
    expect(outcome.costUsd).toBeCloseTo(0.02)
    expect(outcome.usage).toEqual({ input: 210, output: 40, cached: 100 })
    expect(session.events.filter((event) => event.kind === 'user')).toEqual([{ kind: 'user', text: 'also this', dictated: false, delivery: 'now' }])
  })

  it('holds a queued message until the turn ends', async () => {
    const { session } = await run('slow')
    await new Promise((done) => setTimeout(done, 300))
    expect(session.send('after that', 'queue', true)).toBe('queued')
    const outcome = await session.done
    expect(outcome.lastText).toBe('You said: after that.')
    const texts = session.events.filter((event) => event.kind === 'text').map((event) => (event as { text: string }).text)
    expect(texts).toEqual(['You said: slow.', 'You said: after that.'])
  })

  it('waits between turns in a conversation and ends when asked', async () => {
    const { session } = await run('hello', { conversational: true })
    await new Promise<void>((done) => session.on('state', (state) => state === 'waiting' && done()))
    expect(session.state).toBe('waiting')
    expect(session.send('second', 'now')).toBe('delivered')
    await new Promise<void>((done) => session.on('state', (state) => state === 'waiting' && done()))
    session.end()
    const outcome = await session.done
    expect(outcome).toMatchObject({ state: 'done', lastText: 'You said: second.' })
  })

  it('reports a failed turn with the agent message', async () => {
    const { session } = await run('fail')
    expect(await session.done).toMatchObject({ state: 'failed', error: 'Something broke.' })
  })

  it('stops a running agent', async () => {
    const { session } = await run('slow', { conversational: true })
    await new Promise((done) => setTimeout(done, 300))
    await session.stop()
    expect((await session.done).state).toBe('stopped')
    expect(() => session.send('too late', 'now')).toThrow('This run has ended')
  })

  it('fails clearly when the agent CLI is not installed', async () => {
    const { session } = await run('hi', { command: ['definitely-not-claude'] })
    const outcome = await session.done
    expect(outcome.state).toBe('failed')
    expect(outcome.error).toBeTruthy()
  })
})

describe('Codex', () => {
  it('reads codex exec --json: the thread, commands, messages, file changes and usage without the cached tokens', () => {
    const lines = [
      { type: 'thread.started', thread_id: 'th-1' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: '', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: 'app\n', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: 'app/hint.txt', kind: 'add' }], status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Added the hint.' } },
      { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 80, reasoning_output_tokens: 20 } }
    ].flatMap((line) => parseCodexLine(JSON.stringify(line)))
    expect(lines).toEqual([
      { kind: 'init', sessionId: 'th-1', model: '' },
      { kind: 'tool', id: 'item_1', name: 'Bash', summary: '$ bash -lc ls' },
      { kind: 'tool-result', id: 'item_1', ok: true, output: 'app\n' },
      { kind: 'tool', id: 'item_2', name: 'Edit', summary: 'edited app/hint.txt' },
      { kind: 'tool-result', id: 'item_2', ok: true, output: '' },
      { kind: 'text', text: 'Added the hint.' },
      { kind: 'result', ok: true, text: '', costUsd: null, usage: { input: 200, output: 80, cached: 1000 }, turns: 1 }
    ])
    expect(parseCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit" } }))).toEqual([
      { kind: 'result', ok: false, text: "You've hit your usage limit", costUsd: null, usage: null, turns: 1 }
    ])
  })

  it('runs codex exec in the workspace-write sandbox with the outputs folder writable, and resumes the thread for a follow-up', () => {
    const base = { connector: CODEX, runner: new NativeRunner(), cwd: '/tmp', prompt: 'x', profile: 'build' } as const
    expect(codexArgs({ ...base, model: 'default', addDirs: ['/out'] }, 'Do it', null)).toEqual(['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.writable_roots=["/out"]', 'Do it'])
    expect(codexArgs({ ...base, model: 'gpt-x', profile: 'chat', addDirs: ['/out'] }, 'Hi', 'th-1')).toEqual(['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', 'gpt-x', 'resume', 'th-1', 'Hi'])
  })
})

describe.skipIf(process.platform === 'win32')('custom agents', () => {
  // Prints Codex-style JSON lines, carrying on the thread it was given.
  const script = "const [p, s] = process.argv.slice(1); const t = s || 'thread-1'; for (const e of [{ type: 'thread.started', thread_id: t }, { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'You said: ' + p + ' (' + t + ')' } }, { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }]) console.log(JSON.stringify(e))"

  it('runs a command template, reads its output format, and carries on the conversation with its follow-up arguments', async () => {
    const connector = customConnector({ id: 'echo-agent', name: 'Echo', command: 'node', output: 'codex-jsonl', args: ['-e', script, '{{prompt}}'], resumeArgs: ['-e', script, '{{prompt}}', '{{session}}'], models: ['m'] })
    const session = startAgent({ connector, runner: new NativeRunner(), cwd: await mkdtemp(join(tmpdir(), 'eregion-custom-')), model: 'm', prompt: 'first', profile: 'build', conversational: true })
    await new Promise<void>((resolve) => session.on('state', (state) => state === 'waiting' && resolve()))
    expect(session.send('second', 'now')).toBe('delivered')
    await new Promise<void>((resolve) => session.on('state', (state) => state === 'waiting' && resolve()))
    session.end()
    const outcome = await session.done
    expect(outcome).toMatchObject({ state: 'done', sessionId: 'thread-1', lastText: 'You said: second (thread-1)', usage: { input: 20, output: 10, cached: 0 } })
  })

  it("runs a plain-text agent once, and says it can't carry on a conversation", async () => {
    const connector = customConnector({ id: 'shell-agent', name: 'Shell', command: 'sh', output: 'text', args: ['-c', 'echo thinking; echo "Done: $0"', '{{prompt}}'], models: [] })
    expect(connector.capabilities).toMatchObject({ followUps: false, reportsTokens: false })
    const session = startAgent({ connector, runner: new NativeRunner(), cwd: await mkdtemp(join(tmpdir(), 'eregion-custom-')), model: '', prompt: 'the task', profile: 'build', conversational: true })
    const outcome = await session.done
    expect(outcome).toMatchObject({ state: 'done', lastText: 'Done: the task', usage: null })
    expect(() => session.send('more', 'now')).toThrow('This run has ended')
  })
})
