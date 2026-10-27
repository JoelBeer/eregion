import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { AgentEvent, Usage } from '@shared/agent'
import { fillArgs, type AgentConnector } from '@shared/connectors'
import type { Runner } from '../runner'
import { parseClaudeLine, parseCodexLine, parseCursorLine, parseTextLine } from './parse'

const PID_MARKER = '__EREGION_PID__'

/**
 * What an agent may do. Every profile blocks the git and gh commands Eregion owns; Plan and Review
 * also rely on their prompts and on Eregion checking the worktree afterwards.
 */
export type PermissionProfile = 'plan' | 'build' | 'review' | 'ci-fix' | 'pr' | 'chat'

export const BLOCKED_COMMANDS = [
  'Bash(git commit *)',
  'Bash(git push *)',
  'Bash(git checkout *)',
  'Bash(git switch *)',
  'Bash(git rebase *)',
  'Bash(git reset *)',
  'Bash(git stash *)',
  'Bash(git merge *)',
  'Bash(git worktree *)',
  'Bash(gh pr *)',
  'Bash(gh issue *)'
]

export interface AgentStartOptions {
  /** Which agent CLI runs it, and what it can do. */
  connector: AgentConnector
  runner: Runner
  cwd: string
  model: string
  prompt: string
  profile: PermissionProfile
  /** Folders outside cwd the agent may use, such as the outputs folder. */
  addDirs?: string[]
  /** The run's MCP servers as JSON. With it, Claude Code loads only these (--strict-mcp-config). */
  mcpConfig?: string
  /** Extra tools the run may not use, such as Skill(deploy) for skills you haven't allowed. */
  deniedTools?: string[]
  /** Extra tools the run may use, such as mcp__laravel-boost for an allowed server. */
  allowedTools?: string[]
  /** Per-run settings JSON, such as skillOverrides. */
  settings?: string
  /** Appended to Claude Code's system prompt, so the first message can be yours (the Forge). */
  systemPrompt?: string
  /** Carries on an earlier session, such as a Forge chat after a restart. */
  resume?: string
  /** Shows the first prompt in the conversation as your message, or this text in its place. */
  recordPrompt?: boolean | string
  /** Keep the session open after a turn, waiting for the next message (Plan, the Forge). */
  conversational?: boolean
  /** Replaces the CLI command, for tests. */
  command?: string[]
}

export type SessionState = 'running' | 'waiting' | 'done' | 'failed' | 'stopped'

export interface SessionOutcome {
  state: 'done' | 'failed' | 'stopped'
  sessionId: string | null
  lastText: string
  costUsd: number | null
  usage: Usage | null
  error: string | null
}

export function claudeArgs(options: AgentStartOptions): string[] {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', options.model, '--permission-prompts', 'none']
  if (options.profile === 'chat') {
    args.push('--permission-mode', 'plan')
    if (options.allowedTools?.length) args.push('--allowedTools', ...options.allowedTools)
    if (options.deniedTools?.length) args.push('--disallowedTools', ...options.deniedTools)
  } else {
    args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', ...(options.allowedTools ?? []), '--disallowedTools', ...BLOCKED_COMMANDS, ...(options.deniedTools ?? []))
  }
  for (const dir of options.addDirs ?? []) args.push('--add-dir', dir)
  if (options.mcpConfig) args.push('--mcp-config', options.mcpConfig, '--strict-mcp-config')
  if (options.settings) args.push('--settings', options.settings)
  if (options.systemPrompt) args.push('--append-system-prompt', options.systemPrompt)
  if (options.resume) args.push('--resume', options.resume)
  return args
}

export function cursorArgs(options: AgentStartOptions, message: string, resume: string | null): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--model', options.model]
  if (options.profile !== 'chat') args.push('--force')
  if (resume) args.push('--resume', resume)
  return [...args, message]
}

/**
 * `codex exec --json` in the workspace-write sandbox (read-only for Forge chats), with the outputs folder as an
 * extra writable root. A follow-up resumes the same thread. 'default' leaves the model to your Codex config.
 */
export function codexArgs(options: AgentStartOptions, message: string, resume: string | null): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', options.profile === 'chat' ? 'read-only' : 'workspace-write']
  if (options.model && options.model !== 'default') args.push('--model', options.model)
  if (options.addDirs?.length && options.profile !== 'chat') args.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(options.addDirs)}`)
  if (resume) args.push('resume', resume)
  return [...args, message]
}

/** A custom agent's arguments for a new run, or for carrying on its conversation. */
export function customArgs(connector: AgentConnector, options: AgentStartOptions, message: string, resume: string | null): string[] {
  const template = resume && connector.resumeArgs ? connector.resumeArgs : (connector.args ?? [])
  return fillArgs(template, { prompt: message, model: options.model, session: resume ?? '' })
}

const PARSERS = {
  'claude-stream-json': parseClaudeLine,
  'cursor-stream-json': parseCursorLine,
  'codex-jsonl': parseCodexLine,
  text: parseTextLine
} as const

function userLine(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`
}

/**
 * One agent run: the CLI process, its normalised events, and messages from you. Claude Code takes
 * messages while it works (they arrive at its next turn boundary); every other agent runs one process per
 * turn and gets them as a follow-up in the same conversation once the current turn ends, if it can.
 */
export class AgentSession extends EventEmitter {
  readonly events: AgentEvent[] = []
  state: SessionState = 'running'
  sessionId: string | null = null
  private child: ChildProcess | null = null
  private innerPid: number | undefined
  private readonly queue: string[] = []
  private lastText = ''
  private costUsd: number | null = null
  private usage: Usage | null = null
  private error: string | null = null
  private stopping = false
  private finishing = false
  private resolveDone!: (outcome: SessionOutcome) => void
  readonly done: Promise<SessionOutcome>

  constructor(private readonly options: AgentStartOptions) {
    super()
    this.done = new Promise((resolve) => (this.resolveDone = resolve))
  }

  /** True when a message can reach the agent before its current turn ends. */
  get takesMessagesMidRun(): boolean {
    return this.options.connector.capabilities.midRunMessages
  }

  /** Claude Code keeps one process for the whole conversation, reading your messages as stream-json. */
  private get streaming(): boolean {
    return this.options.connector.id === 'claude-code'
  }

  start(): this {
    if (this.streaming) {
      // A stand-in for the CLI (tests, the web preview) still hears which conversation it carries on.
      const resume = this.options.resume ? ['--resume', this.options.resume] : []
      this.spawn(this.options.command ? [...this.options.command, ...resume] : ['claude', ...claudeArgs(this.options)])
      this.child?.stdin?.write(userLine(this.options.prompt))
    } else {
      // Only Claude Code has a system prompt flag, so for the others the Forge's instructions lead the first message.
      const message = this.options.systemPrompt ? `${this.options.systemPrompt}\n\n${this.options.prompt}` : this.options.prompt
      this.turn(message, this.options.resume ?? null)
    }
    if (this.options.recordPrompt) this.recordPromptSoon()
    return this
  }

  /** Starts one turn of an agent that runs a process per turn: a new run, or a follow-up when `resume` is set. */
  private turn(message: string, resume: string | null): void {
    const { connector } = this.options
    let argv: string[]
    if (connector.id === 'cursor') argv = ['cursor-agent', ...cursorArgs(this.options, message, resume)]
    else if (connector.id === 'codex') argv = ['codex', ...codexArgs(this.options, message, resume)]
    else argv = [connector.command, ...customArgs(connector, this.options, message, resume)]
    this.spawn(this.options.command ?? argv)
    // A custom template without {{prompt}} reads the message from its input.
    const template = resume && connector.resumeArgs ? connector.resumeArgs : connector.args
    if (!connector.builtIn && !template?.some((arg) => arg.includes('{{prompt}}'))) this.child?.stdin?.write(message)
    this.child?.stdin?.end()
  }

  private spawn(argv: string[]): void {
    const { runner, cwd } = this.options
    const posix = !(runner.runtime.kind === 'native' && process.platform === 'win32')
    // On POSIX runtimes a login shell loads the user's PATH and reports the real pid, which from
    // Windows is otherwise hidden behind wsl.exe.
    const command = posix ? ['bash', '-lc', `echo ${PID_MARKER}$$; exec "$@"`, 'bash', ...argv] : argv
    const child = runner.spawn(command, { cwd })
    this.child = child
    this.innerPid = posix ? undefined : child.pid
    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        this.handleLine(line)
      }
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000)
    })
    child.on('error', (error) => {
      this.error = error.message
    })
    child.on('close', (code) => {
      if (buffer.trim()) this.handleLine(buffer)
      buffer = ''
      if (this.child !== child) return
      this.child = null
      if (this.stopping) return this.finish('stopped')
      // Plain-text agents have no result line: the turn ended when the process did.
      if (this.options.connector.output === 'text') this.handleEvent({ kind: 'result', ok: code === 0, text: code === 0 ? this.lastText : stderr.trim(), costUsd: null, usage: null, turns: 1 })
      const followUps = this.options.connector.capabilities.followUps
      if (!this.streaming && this.state === 'running' && code === 0 && followUps) {
        if (this.queue.length > 0) return this.followUp()
        if (this.options.conversational && !this.finishing) return this.setState('waiting')
      }
      if (code !== 0 && !this.error) this.error = stderr.trim() || `The agent exited with code ${code}`
      this.finish(code === 0 && !this.error ? 'done' : 'failed')
    })
  }

  private handleLine(line: string): void {
    if (line.startsWith(PID_MARKER)) {
      this.innerPid = Number(line.slice(PID_MARKER.length))
      return
    }
    const parsed = PARSERS[this.options.connector.output](line)
    for (const event of parsed) this.handleEvent(event)
  }

  private handleEvent(event: AgentEvent): void {
    if (event.kind === 'init') this.sessionId = event.sessionId || this.sessionId
    if (event.kind === 'text') this.lastText = event.text
    if (event.kind === 'result') {
      // Claude Code reports the session's running cost but each turn's own tokens.
      if (event.costUsd !== null) this.costUsd = event.costUsd
      if (event.usage) {
        this.usage = {
          input: (this.usage?.input ?? 0) + event.usage.input,
          output: (this.usage?.output ?? 0) + event.usage.output,
          cached: (this.usage?.cached ?? 0) + event.usage.cached
        }
      }
      if (!event.ok && !this.error) this.error = event.text || 'The agent reported an error'
    }
    this.record(event)
    if (event.kind === 'result' && this.streaming) this.afterTurn()
  }

  private record(event: AgentEvent): void {
    this.events.push(event)
    this.emit('event', event)
  }

  /** Shows the first prompt as your message, once whoever started the session is listening. */
  private recordPromptSoon(): void {
    const shown = this.options.recordPrompt
    queueMicrotask(() => this.record({ kind: 'user', text: typeof shown === 'string' ? shown : this.options.prompt, dictated: false, delivery: 'now' }))
  }

  private setState(state: SessionState): void {
    this.state = state
    this.emit('state', state)
  }

  private afterTurn(): void {
    if (this.queue.length > 0) {
      const next = this.queue.splice(0)
      for (const text of next) this.child?.stdin?.write(userLine(text))
      return
    }
    if (this.options.conversational && !this.finishing) {
      this.setState('waiting')
      return
    }
    this.child?.stdin?.end()
  }

  private followUp(): void {
    const text = this.queue.splice(0).join('\n\n')
    this.setState('running')
    this.turn(text, this.sessionId)
  }

  /**
   * Gives the agent a message from you. "now" reaches Claude Code at its next turn boundary;
   * "queue" waits until the current turn ends. Returns how it was handled.
   */
  send(text: string, delivery: 'now' | 'queue', dictated = false): 'delivered' | 'queued' {
    if (this.state === 'done' || this.state === 'failed' || this.state === 'stopped') {
      throw new Error('This run has ended')
    }
    if (!this.options.connector.capabilities.followUps && !this.streaming) throw new Error(`${this.options.connector.name} can't carry on a conversation`)
    this.record({ kind: 'user', text, dictated, delivery })
    if (this.state === 'waiting') {
      this.setState('running')
      if (this.streaming) {
        this.child?.stdin?.write(userLine(text))
      } else {
        this.queue.push(text)
        this.followUp()
      }
      return 'delivered'
    }
    if (delivery === 'now' && this.takesMessagesMidRun) {
      this.child?.stdin?.write(userLine(text))
      return 'delivered'
    }
    this.queue.push(text)
    return 'queued'
  }

  /** For conversational runs: end once the current turn finishes (or now, if waiting). */
  end(): void {
    this.finishing = true
    if (this.state === 'waiting') {
      if (this.child) this.child.stdin?.end()
      else this.finish('done')
    }
  }

  async stop(): Promise<void> {
    if (!this.child) {
      if (this.state === 'waiting') this.finish('stopped')
      return
    }
    this.stopping = true
    if (this.innerPid !== undefined) await this.options.runner.killTree(this.innerPid)
    this.child?.kill()
  }

  private finish(state: 'done' | 'failed' | 'stopped'): void {
    if (this.state === 'done' || this.state === 'failed' || this.state === 'stopped') return
    this.setState(state)
    this.resolveDone({ state, sessionId: this.sessionId, lastText: this.lastText, costUsd: this.costUsd, usage: this.usage, error: state === 'failed' ? this.error : null })
  }
}

export function startAgent(options: AgentStartOptions): AgentSession {
  return new AgentSession(options).start()
}
