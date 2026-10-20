import type { Project } from '@shared/model'
import type { StageConfig } from '@shared/pipeline'
import { sourceOf, SOURCE_NAMES, type TicketSourceKind } from '@shared/sources'
import type { LinearData, Ticket } from '@shared/tickets'
import { getSetting, setSetting, type Db } from '../db'
import type { Integrations } from '../pipeline/engine'
import type { TicketStore } from '../pipeline/stores'
import type { ProjectStore } from '../projects/store'

/**
 * An issue as a ticket source gives it. A ticket keeps the issue's id in its linearId field and the
 * details (state, labels, assignee, comments) in its linear field, whichever tracker it came from.
 */
export interface SourceIssue {
  id: string
  /** WM-12 (Linear, Jira), GH-12 (GitHub), GL-12 (GitLab). */
  key: string
  title: string
  description: string
  url: string
  data: Omit<LinearData, 'isNew' | 'reassigned' | 'pulledAt'>
  /** Finished, cancelled or closed in the tracker. */
  closed: boolean
  /** Assigned to the account Eregion is connected as. */
  mine: boolean
}

/** One tracker Eregion can take tickets from. Linear, GitHub Issues, Jira and GitLab each have one. */
export interface TicketSource {
  readonly kind: Exclude<TicketSourceKind, 'manual'>
  /** Why it can't sync this project now (not connected, no team chosen), or null when it can. */
  notReady(project: Project): string | null
  /** The team, repo or project it reads this project's issues from, for the screens. */
  location(project: Project): string | null
  /** Issues that should be in the Backlog now: whoever the rules say, in importable states, with the right labels. */
  candidates(project: Project): Promise<SourceIssue[]>
  /** Current versions of these issues, for ones that dropped out of the candidates. */
  byIds(project: Project, ids: string[]): Promise<SourceIssue[]>
  /** One issue by its key (or id), to import by hand or pull again. */
  byKey(project: Project, key: string): Promise<SourceIssue>
  /** Whether the issue is still assigned to whoever this project imports for. */
  wanted(project: Project, issue: SourceIssue): boolean
  /** A new issue in the tracker, assigned to you, for New ticket in a linked project. */
  create?(project: Project, input: { title: string; description: string }): Promise<SourceIssue>
  /** Pipeline hooks: status as the ticket moves, the approved plan, PR links. */
  hooks: Pick<Integrations, 'stageEntered' | 'ticketDone' | 'planApproved' | 'prsOpened'>
}

export interface SyncResult {
  imported: string[]
  refreshed: number
  removed: string[]
  flagged: string[]
}

export interface SyncEvents {
  ticketChanged(ticket: Ticket): void
  ticketRemoved(projectId: number): void
  notify(title: string, body: string): void
  statusChanged(): void
}

function ticketData(source: TicketSource, issue: SourceIssue, previous: LinearData = {}): LinearData {
  return { ...previous, ...issue.data, source: source.kind, pulledAt: new Date().toISOString() }
}

/** Whether a ticket's issue is in this tracker: a project that changed trackers keeps its old tickets untouched. */
export function fromSource(ticket: Ticket, kind: TicketSource['kind']): boolean {
  return ticket.linearId !== null && (ticket.linear.source ?? 'linear') === kind
}

/**
 * Brings each project's issues into its Backlog from wherever its tickets come from, refreshes the ones
 * already here, and handles issues assigned away: a Backlog ticket goes, one already being worked on is
 * flagged. Runs on start, on focus and on a timer.
 */
export class IssueSync {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private readonly lastRun = new Map<number, number>()

  constructor(
    private readonly db: Db,
    private readonly sources: TicketSource[],
    private readonly projects: ProjectStore,
    private readonly tickets: TicketStore,
    private readonly events: SyncEvents
  ) {}

  source(project: Project): TicketSource | null {
    const { kind } = sourceOf(project)
    return this.sources.find((source) => source.kind === kind) ?? null
  }

  private requireSource(project: Project): TicketSource {
    const source = this.source(project)
    if (!source) throw new Error(`${project.name} takes its tickets from Eregion only`)
    const notReady = source.notReady(project)
    if (notReady) throw new Error(notReady)
    return source
  }

  /** When each source last synced, and what went wrong if it failed. */
  lastSync(kind: TicketSourceKind): { at: string | null; error: string | null } {
    return getSetting(this.db, `${kind}.lastSync`, { at: null, error: null })
  }

  start(): void {
    if (this.timer) return
    void this.syncDue()
    this.timer = setInterval(() => void this.syncDue(), 15_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Projects whose issues come in by themselves. */
  private syncingProjects(): Project[] {
    return this.projects
      .list()
      .map((summary) => this.projects.get(summary.id))
      .filter((project) => {
        const source = this.source(project)
        const config = sourceOf(project)
        const pullFrom = config.kind === 'linear' ? (project.linear.pullFrom ?? 'assigned') : (config.pullFrom ?? 'auto')
        return source !== null && source.notReady(project) === null && pullFrom !== 'manual'
      })
  }

  private pollSec(project: Project): number {
    const config = sourceOf(project)
    return (config.kind === 'linear' ? project.linear.pollSec : config.pollSec) ?? 60
  }

  async syncDue(): Promise<void> {
    const now = Date.now()
    const due = this.syncingProjects().filter((project) => now - (this.lastRun.get(project.id) ?? 0) >= this.pollSec(project) * 1000)
    if (due.length > 0) await this.syncAll(due)
  }

  /** Syncs now (on focus, or when you ask). Overlapping calls share one sync. */
  syncAll(projects: Project[] = this.syncingProjects()): Promise<void> {
    if (this.running) return this.running
    this.running = (async () => {
      const outcome = new Map<TicketSourceKind, string | null>()
      for (const project of projects) {
        const kind = sourceOf(project).kind
        this.lastRun.set(project.id, Date.now())
        try {
          await this.syncProject(project)
          if (!outcome.has(kind)) outcome.set(kind, null)
        } catch (error) {
          outcome.set(kind, `${project.name}: ${(error as Error).message}`)
        }
      }
      for (const [kind, error] of outcome) setSetting(this.db, `${kind}.lastSync`, { at: new Date().toISOString(), error })
      this.events.statusChanged()
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  async syncProject(project: Project): Promise<SyncResult> {
    const result: SyncResult = { imported: [], refreshed: 0, removed: [], flagged: [] }
    const source = this.source(project)
    if (!source || source.notReady(project)) return result
    const name = SOURCE_NAMES[source.kind]
    const issues = await source.candidates(project)
    const seen = new Set<string>()

    for (const issue of issues) {
      seen.add(issue.id)
      const existing = this.tickets.findByLinearId(project.id, issue.id)
      if (existing && fromSource(existing, source.kind)) {
        this.refresh(project, source, existing, issue)
        result.refreshed++
        continue
      }
      const clash = this.tickets.findByKey(project.id, issue.key)
      if (clash) {
        this.tickets.log(clash.id, 'warning', `${name} issue ${issue.key} has the same key as this ticket made in Eregion, so it wasn't imported`)
        continue
      }
      const ticket = this.tickets.create({ projectId: project.id, key: issue.key, title: issue.title, description: issue.description, url: issue.url, linearId: issue.id, linear: { ...ticketData(source, issue), isNew: true } })
      this.tickets.log(ticket.id, 'source', `Imported from ${name}${issue.data.assignee ? ` (assigned to ${issue.data.assignee})` : ''}`)
      result.imported.push(issue.key)
      this.events.ticketChanged(ticket)
      this.events.notify(issue.mine ? `${issue.key} assigned to you` : issue.data.assignee ? `${issue.key} assigned to ${issue.data.assignee}` : `${issue.key} came in from ${name}`, issue.title)
    }

    // Issues that dropped out of the list: assigned away, finished, or moved on in the tracker.
    const missing = this.tickets.list(project.id).filter((ticket) => fromSource(ticket, source.kind) && !seen.has(ticket.linearId as string) && ticket.stage !== 'done')
    const current = missing.length > 0 ? await source.byIds(project, missing.map((ticket) => ticket.linearId as string)) : []
    for (const ticket of missing) {
      const issue = current.find((item) => item.id === ticket.linearId)
      const wanted = issue ? source.wanted(project, issue) : false
      if (ticket.stage === 'backlog' && (!wanted || !issue || issue.closed)) {
        this.tickets.delete(ticket.id)
        result.removed.push(ticket.key)
        this.events.ticketRemoved(project.id)
        continue
      }
      if (issue) this.refresh(project, source, ticket, issue)
      if (!wanted && !ticket.linear.reassigned && ticket.stage !== 'backlog') {
        const flagged = this.tickets.update(ticket.id, { linear: { ...this.tickets.get(ticket.id).linear, reassigned: true } })
        this.tickets.log(ticket.id, 'source', `Reassigned in ${name} to ${issue?.data.assignee ?? 'nobody'}`)
        result.flagged.push(ticket.key)
        this.events.ticketChanged(flagged)
      }
    }
    return result
  }

  private refresh(project: Project, source: TicketSource, ticket: Ticket, issue: SourceIssue): void {
    const data = ticketData(source, issue, ticket.linear)
    if (source.wanted(project, issue)) data.reassigned = false
    const changed = ticket.title !== issue.title || ticket.description !== issue.description || JSON.stringify({ ...ticket.linear, pulledAt: null }) !== JSON.stringify({ ...data, pulledAt: null })
    const updated = this.tickets.update(ticket.id, { title: issue.title, description: issue.description, url: issue.url, linear: data })
    if (changed) this.events.ticketChanged(updated)
  }

  /** Pulls one issue by its key, for projects that import by hand. */
  async importByKey(project: Project, key: string): Promise<Ticket> {
    const source = this.requireSource(project)
    const issue = await source.byKey(project, key.trim())
    const existing = this.tickets.findByLinearId(project.id, issue.id)
    if (existing && fromSource(existing, source.kind)) {
      this.refresh(project, source, existing, issue)
      return this.tickets.get(existing.id)
    }
    if (this.tickets.findByKey(project.id, issue.key)) throw new Error(`${issue.key} is already used by another ticket in this project`)
    const ticket = this.tickets.create({ projectId: project.id, key: issue.key, title: issue.title, description: issue.description, url: issue.url, linearId: issue.id, linear: ticketData(source, issue) })
    this.tickets.log(ticket.id, 'source', `Imported from ${SOURCE_NAMES[source.kind]} by key`)
    this.events.ticketChanged(ticket)
    return ticket
  }

  async pullAgain(ticket: Ticket): Promise<Ticket> {
    const project = this.projects.get(ticket.projectId)
    const source = this.requireSource(project)
    if (!fromSource(ticket, source.kind)) throw new Error(`${ticket.key} didn't come from ${SOURCE_NAMES[source.kind]}`)
    this.refresh(project, source, ticket, await source.byKey(project, ticket.key))
    return this.tickets.get(ticket.id)
  }

  /** New ticket in a linked project: a new issue in the tracker, assigned to you, imported straight away. */
  async create(project: Project, title: string, description: string): Promise<Ticket | null> {
    const source = this.source(project)
    if (!source?.create || source.notReady(project)) return null
    if (!title.trim()) throw new Error('Give the ticket a title')
    const issue = await source.create(project, { title: title.trim(), description })
    return this.importByKey(project, issue.key)
  }
}

/** The pipeline's hooks into whichever tracker each project's tickets come from. Hooks skip tickets made in Eregion. */
export function sourceIntegrations(sync: IssueSync, notify: (title: string, body: string) => void): Integrations {
  const hook =
    <K extends keyof TicketSource['hooks']>(name: K) =>
    async (ticket: Ticket, ...rest: unknown[]): Promise<void> => {
      const project = rest.at(-1) as Project
      const source = sync.source(project)
      if (!source || !fromSource(ticket, source.kind) || source.notReady(project)) return
      const fn = source.hooks[name] as ((...args: unknown[]) => Promise<void>) | undefined
      await fn?.(ticket, ...rest)
    }
  return {
    stageEntered: hook('stageEntered') as (ticket: Ticket, stage: StageConfig, project: Project) => Promise<void>,
    ticketDone: hook('ticketDone') as (ticket: Ticket, project: Project) => Promise<void>,
    planApproved: hook('planApproved') as (ticket: Ticket, markdown: string, project: Project) => Promise<void>,
    prsOpened: hook('prsOpened') as Integrations['prsOpened'],
    notify
  }
}
