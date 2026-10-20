import type { AgentEvent } from '@shared/agent'
import type { CrewMember, RunView } from '@shared/runs'
import type { Runner } from '../runner'
import type { RunStore } from './runs'
import { startAgent, type AgentSession, type AgentStartOptions, type PermissionProfile, type SessionOutcome } from './session'

export interface StartRun {
  ticketId?: number | null
  chatId?: number | null
  stage: string
  loop?: number
  crew: CrewMember
  runner: Runner
  cwd: string
  prompt: string
  profile: PermissionProfile
  addDirs?: string[]
  mcpConfig?: string
  allowedTools?: string[]
  deniedTools?: string[]
  settings?: string
  systemPrompt?: string
  resume?: string
  recordPrompt?: boolean
  conversational?: boolean
  /** Replaces the agent CLI, for tests and the web preview. */
  command?: string[]
}

export type RunNotice = { type: 'run-event'; runId: number; event: AgentEvent } | { type: 'run-state'; runId: number; state: RunView['state']; queued: number }

/** Starts agent runs, saves everything they do, and passes it on to screens as it happens. */
export class AgentManager {
  private readonly sessions = new Map<number, AgentSession>()
  private readonly observers = new Map<number, Set<(notice: RunNotice) => void>>()

  /** Listens to one run's events and state changes, for the pipeline engine. */
  observe(runId: number, listener: (notice: RunNotice) => void): () => void {
    if (!this.observers.has(runId)) this.observers.set(runId, new Set())
    this.observers.get(runId)?.add(listener)
    return () => this.observers.get(runId)?.delete(listener)
  }

  private tell(notice: RunNotice): void {
    this.notify(notice)
    for (const listener of this.observers.get(notice.runId) ?? []) listener(notice)
  }

  /** The live session's state, or null when the run isn't going any more. */
  liveState(runId: number): RunView['state'] | null {
    return this.sessions.get(runId)?.state ?? null
  }

  constructor(
    private readonly runs: RunStore,
    private readonly notify: (notice: RunNotice) => void,
    private readonly commandFor?: (crew: CrewMember) => string[] | undefined
  ) {}

  start(request: StartRun): { runId: number; done: Promise<SessionOutcome> } {
    // A Forge Visitor has no crew record (id 0).
    const run = this.runs.create({ ticketId: request.ticketId, chatId: request.chatId, stage: request.stage, crewId: request.crew.id > 0 ? request.crew.id : null, adapter: request.crew.adapter, model: request.crew.model, loop: request.loop })
    const options: AgentStartOptions = {
      adapter: request.crew.adapter,
      runner: request.runner,
      cwd: request.cwd,
      model: request.crew.model,
      prompt: request.prompt,
      profile: request.profile,
      addDirs: request.addDirs,
      mcpConfig: request.mcpConfig,
      allowedTools: request.allowedTools,
      deniedTools: request.deniedTools,
      settings: request.settings,
      systemPrompt: request.systemPrompt,
      resume: request.resume,
      recordPrompt: request.recordPrompt,
      conversational: request.conversational,
      command: request.command ?? this.commandFor?.(request.crew)
    }
    const session = startAgent(options)
    this.sessions.set(run.id, session)

    let sessionSaved = false
    session.on('event', (event: AgentEvent) => {
      this.runs.addEvent(run.id, event)
      if (event.kind === 'init' && event.sessionId && !sessionSaved) {
        this.runs.setSession(run.id, event.sessionId)
        sessionSaved = true
      }
      if (event.kind === 'result' || event.kind === 'init') this.runs.markDelivered(run.id)
      this.tell({ type: 'run-event', runId: run.id, event })
    })
    session.on('state', (state: RunView['state']) => {
      if (state === 'running' || state === 'waiting') this.runs.markDelivered(run.id)
      this.tell({ type: 'run-state', runId: run.id, state, queued: this.runs.queuedCount(run.id) })
    })
    const done = session.done.then((outcome) => {
      this.runs.finish(run.id, outcome)
      this.sessions.delete(run.id)
      this.tell({ type: 'run-state', runId: run.id, state: outcome.state, queued: 0 })
      this.observers.delete(run.id)
      return outcome
    })
    return { runId: run.id, done }
  }

  view(runId: number): RunView {
    const run = this.runs.get(runId)
    const session = this.sessions.get(runId)
    return {
      run,
      state: session ? session.state : run.result === 'running' ? 'stopped' : run.result,
      events: this.runs.events(runId),
      queued: this.runs.queuedCount(runId),
      takesMessagesMidRun: run.adapter === 'claude-code'
    }
  }

  isLive(runId: number): boolean {
    return this.sessions.has(runId)
  }

  send(runId: number, text: string, delivery: 'now' | 'queue', dictated = false): 'delivered' | 'queued' {
    const session = this.sessions.get(runId)
    if (!session) throw new Error('This run has ended')
    const handled = session.send(text, delivery, dictated)
    this.runs.addMessage(runId, text, delivery, dictated, handled)
    this.tell({ type: 'run-state', runId, state: session.state, queued: this.runs.queuedCount(runId) })
    return handled
  }

  end(runId: number): void {
    this.sessions.get(runId)?.end()
  }

  async stop(runId: number): Promise<void> {
    await this.sessions.get(runId)?.stop()
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((runId) => this.stop(runId)))
  }
}
