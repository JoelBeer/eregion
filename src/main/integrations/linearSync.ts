import { DEFAULT_IMPORT_STATE_TYPES, type LinearIssue } from '@shared/integrations'
import type { Project } from '@shared/model'
import type { LinearData, Ticket } from '@shared/tickets'
import { getSetting, setSetting, type Db } from '../db'
import type { TicketStore } from '../pipeline/stores'
import type { ProjectStore } from '../projects/store'
import type { LinearAuth } from './linearAuth'

export function linearData(issue: LinearIssue, previous: LinearData = {}): LinearData {
  return {
    ...previous,
    state: issue.state.name,
    priority: issue.priorityLabel,
    estimate: issue.estimate,
    labels: issue.labels,
    comments: issue.comments,
    assignee: issue.assignee?.name ?? null,
    pulledAt: new Date().toISOString()
  }
}

export interface SyncResult {
  imported: string[]
  refreshed: number
  removed: string[]
  flagged: string[]
}

/**
 * Imports Linear issues assigned to the chosen person into each project's Backlog, refreshes the
 * ones already here, and handles issues assigned away. Runs on start, on focus and on a timer.
 */
export class LinearSync {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private lastRun = new Map<number, number>()

  constructor(
    private readonly db: Db,
    private readonly auth: LinearAuth,
    private readonly projects: ProjectStore,
    private readonly tickets: TicketStore,
    private readonly events: { ticketChanged(ticket: Ticket): void; ticketRemoved(projectId: number): void; notify(title: string, body: string): void; statusChanged(): void }
  ) {}

  lastSync(): { at: string | null; error: string | null } {
    return getSetting(this.db, 'linear.lastSync', { at: null, error: null })
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

  private linkedProjects(): Project[] {
    return this.projects
      .list()
      .map((summary) => this.projects.get(summary.id))
      .filter((project) => project.linear.teamId && (project.linear.pullFrom ?? 'assigned') === 'assigned')
  }

  /** Syncs projects whose interval has passed. */
  async syncDue(): Promise<void> {
    const now = Date.now()
    const due = this.linkedProjects().filter((project) => now - (this.lastRun.get(project.id) ?? 0) >= (project.linear.pollSec ?? 60) * 1000)
    if (due.length > 0) await this.syncAll(due)
  }

  /** Syncs now (on focus, or when you ask). Overlapping calls share one sync. */
  syncAll(projects: Project[] = this.linkedProjects()): Promise<void> {
    if (this.running) return this.running
    this.running = (async () => {
      const client = this.auth.client()
      if (!client) return
      try {
        for (const project of projects) {
          this.lastRun.set(project.id, Date.now())
          await this.syncProject(project)
        }
        setSetting(this.db, 'linear.lastSync', { at: new Date().toISOString(), error: null })
      } catch (error) {
        setSetting(this.db, 'linear.lastSync', { at: new Date().toISOString(), error: (error as Error).message })
      }
      this.events.statusChanged()
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  async syncProject(project: Project): Promise<SyncResult> {
    const client = this.auth.client()
    const result: SyncResult = { imported: [], refreshed: 0, removed: [], flagged: [] }
    if (!client || !project.linear.teamId) return result
    const assignees = this.auth.importAssignees()
    const viewer = this.auth.viewer()
    const assigneeIds = assignees.mode === 'me' ? 'me' : assignees.people.map((person) => person.id)
    const stateTypes = project.linear.importStateTypes?.length ? project.linear.importStateTypes : DEFAULT_IMPORT_STATE_TYPES
    const issues = await client.assignedIssues({ teamId: project.linear.teamId, assigneeIds, stateTypes })
    const seen = new Set<string>()

    for (const issue of issues) {
      seen.add(issue.id)
      const existing = this.tickets.findByLinearId(project.id, issue.id)
      if (existing) {
        this.refresh(existing, issue)
        result.refreshed++
        continue
      }
      const clash = this.tickets.findByKey(project.id, issue.identifier)
      if (clash) {
        this.tickets.log(clash.id, 'warning', `Linear issue ${issue.identifier} has the same key as this ticket made in Eregion, so it wasn't imported`)
        continue
      }
      const ticket = this.tickets.create({
        projectId: project.id,
        key: issue.identifier,
        title: issue.title,
        description: issue.description,
        url: issue.url,
        linearId: issue.id,
        linear: { ...linearData(issue), isNew: true }
      })
      this.tickets.log(ticket.id, 'linear', `Imported from Linear (assigned to ${issue.assignee?.name ?? 'you'})`)
      result.imported.push(issue.identifier)
      this.events.ticketChanged(ticket)
      this.events.notify(`${issue.identifier} assigned to ${assignees.mode === 'me' ? 'you' : (issue.assignee?.name ?? 'you')}`, issue.title)
    }

    // Issues that dropped out of the list: assigned away, finished, or moved on in Linear.
    const missing = this.tickets.list(project.id).filter((ticket) => ticket.linearId && !seen.has(ticket.linearId) && ticket.stage !== 'done')
    const current = await client.issuesById(missing.map((ticket) => ticket.linearId as string))
    for (const ticket of missing) {
      const issue = current.find((item) => item.id === ticket.linearId)
      const assignedToUs = issue?.assignee ? (assigneeIds === 'me' ? issue.assignee.id === viewer?.id : assigneeIds.includes(issue.assignee.id)) : false
      const closed = !issue || issue.state.type === 'completed' || issue.state.type === 'canceled'
      if (ticket.stage === 'backlog' && (!assignedToUs || closed)) {
        this.tickets.delete(ticket.id)
        result.removed.push(ticket.key)
        this.events.ticketRemoved(project.id)
        continue
      }
      if (issue) this.refresh(ticket, issue)
      if (!assignedToUs && !ticket.linear.reassigned && ticket.stage !== 'backlog') {
        const flagged = this.tickets.update(ticket.id, { linear: { ...this.tickets.get(ticket.id).linear, reassigned: true } })
        this.tickets.log(ticket.id, 'linear', `Reassigned in Linear to ${issue?.assignee?.name ?? 'nobody'}`)
        result.flagged.push(ticket.key)
        this.events.ticketChanged(flagged)
      }
    }
    return result
  }

  private refresh(ticket: Ticket, issue: LinearIssue): void {
    const linear = linearData(issue, ticket.linear)
    const assigneeIds = this.auth.importAssignees()
    const stillOurs = assigneeIds.mode === 'me' ? issue.assignee?.id === this.auth.viewer()?.id : assigneeIds.people.some((person) => person.id === issue.assignee?.id)
    if (stillOurs) linear.reassigned = false
    const changed = ticket.title !== issue.title || ticket.description !== issue.description || JSON.stringify({ ...ticket.linear, pulledAt: null }) !== JSON.stringify({ ...linear, pulledAt: null })
    const updated = this.tickets.update(ticket.id, { title: issue.title, description: issue.description, url: issue.url, linear })
    if (changed) this.events.ticketChanged(updated)
  }

  /** Pulls one issue by its key (for projects that import by hand, and for Pull again). */
  async importByKey(project: Project, key: string): Promise<Ticket> {
    const client = this.auth.client()
    if (!client) throw new Error('Connect Linear first, in Settings › Integrations')
    const issue = await client.issue(key.trim().toUpperCase())
    const existing = this.tickets.findByLinearId(project.id, issue.id)
    if (existing) {
      this.refresh(existing, issue)
      return this.tickets.get(existing.id)
    }
    if (this.tickets.findByKey(project.id, issue.identifier)) throw new Error(`${issue.identifier} is already used by a ticket made in Eregion`)
    const ticket = this.tickets.create({ projectId: project.id, key: issue.identifier, title: issue.title, description: issue.description, url: issue.url, linearId: issue.id, linear: linearData(issue) })
    this.tickets.log(ticket.id, 'linear', 'Imported from Linear by key')
    this.events.ticketChanged(ticket)
    return ticket
  }

  async pullAgain(ticket: Ticket): Promise<Ticket> {
    const client = this.auth.client()
    if (!client) throw new Error('Connect Linear first, in Settings › Integrations')
    if (!ticket.linearId) throw new Error(`${ticket.key} didn't come from Linear`)
    this.refresh(ticket, await client.issue(ticket.linearId))
    return this.tickets.get(ticket.id)
  }
}
