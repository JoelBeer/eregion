import { DEFAULT_IMPORT_STATE_TYPES, type ImportAssignees, type LinearIssue } from '@shared/integrations'
import { DEFAULT_LINEAR_PUSH, type Project } from '@shared/model'
import { importRules, labelsMatch, sourceOf } from '@shared/sources'
import type { Connections } from './connections'
import { descriptionWithPlan } from './hooks'
import { LinearClient, type FetchLike } from './linear'
import type { LinearAuth } from './linearAuth'
import type { SourceIssue, TicketSource } from './sources'

const CLOSED = new Set(['completed', 'canceled', 'duplicate'])

/** The titles of the documents Eregion keeps in an issue's resources, found again by title to update them. */
export const PLAN_DOCUMENT = 'Approved plan'
export const SPEC_DOCUMENT = 'Approved spec'
export const BUILD_LOG_DOCUMENT = 'Build log'

/**
 * Whose Linear issues a project imports: its own choice. Projects on the main account that haven't made one
 * keep the choice Settings used to hold for every project; with a connection, it's you.
 */
export function linearAssignees(project: Project, settingsChoice: () => ImportAssignees): ImportAssignees {
  const source = sourceOf(project)
  if (!source.rules?.who) return source.connectionId ? { mode: 'me' } : settingsChoice()
  const rules = importRules(source)
  return rules.who === 'people' ? { mode: 'people', people: rules.people } : { mode: rules.who }
}

/**
 * Linear as a ticket source: issues in the project's team, assigned to whoever the project imports for, in
 * the importable states, with the project's labels. A project uses the account signed in under Linear in
 * Settings › Accounts, or another workspace's connection (a personal API key).
 */
export class LinearSource implements TicketSource {
  readonly kind = 'linear' as const
  private readonly viewers = new Map<string, Promise<string>>()

  constructor(
    private readonly auth: LinearAuth,
    private readonly connections?: Connections,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  /** The connection a project uses instead of the main account, if any. */
  private connectionId(project: Project): string | null {
    return sourceOf(project).connectionId ?? null
  }

  client(project: Project): LinearClient {
    const id = this.connectionId(project)
    if (id && this.connections) return new LinearClient({ kind: 'api-key', key: this.connections.token(id) }, this.fetchImpl)
    const client = this.auth.client()
    if (!client) throw new Error('Connect Linear first, in Settings › Accounts')
    return client
  }

  /** The signed-in account's id: the main one, or the connection's (asked once). */
  private viewerId(project: Project): Promise<string | null> {
    const id = this.connectionId(project)
    if (!id) return Promise.resolve(this.auth.viewer()?.id ?? null)
    if (!this.viewers.has(id)) {
      const viewer = this.client(project)
        .viewer()
        .then((me) => me.id)
      viewer.catch(() => this.viewers.delete(id))
      this.viewers.set(id, viewer)
    }
    return this.viewers.get(id) as Promise<string>
  }

  private assignees(project: Project): ImportAssignees {
    return linearAssignees(project, () => this.auth.importAssignees())
  }

  location(project: Project): string | null {
    return project.linear.teamName ?? project.linear.teamKey ?? null
  }

  notReady(project: Project): string | null {
    const id = this.connectionId(project)
    if (id && !this.connections?.list().some((connection) => connection.id === id)) return `Choose ${project.name}'s Linear account in its Tickets and code step`
    if (!id && !this.auth.client()) return `Choose ${project.name}'s Linear account in its Tickets and code step`
    if (!project.linear.teamId) return `Choose ${project.name}'s Linear team in its Tickets and code step`
    return null
  }

  toIssue(issue: LinearIssue, viewerId: string | null): SourceIssue {
    return {
      id: issue.id,
      key: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      data: { state: issue.state.name, priority: issue.priorityLabel, estimate: issue.estimate, labels: issue.labels, comments: issue.comments, assignee: issue.assignee?.name ?? null, assigneeId: issue.assignee?.id ?? null },
      closed: CLOSED.has(issue.state.type),
      mine: Boolean(issue.assignee && issue.assignee.id === viewerId)
    }
  }

  async candidates(project: Project): Promise<SourceIssue[]> {
    const assignees = this.assignees(project)
    const assigneeIds = assignees.mode === 'people' ? assignees.people.map((person) => person.id) : assignees.mode
    const stateTypes = project.linear.importStateTypes?.length ? project.linear.importStateTypes : DEFAULT_IMPORT_STATE_TYPES
    const issues = await this.client(project).assignedIssues({ teamId: project.linear.teamId as string, assigneeIds, stateTypes })
    const rules = importRules(sourceOf(project))
    const viewerId = await this.viewerId(project)
    return issues.filter((issue) => labelsMatch(issue.labels, rules)).map((issue) => this.toIssue(issue, viewerId))
  }

  async byIds(project: Project, ids: string[]): Promise<SourceIssue[]> {
    const viewerId = await this.viewerId(project)
    return (await this.client(project).issuesById(ids)).map((issue) => this.toIssue(issue, viewerId))
  }

  async byKey(project: Project, key: string): Promise<SourceIssue> {
    return this.toIssue(await this.client(project).issue(key.toUpperCase()), await this.viewerId(project))
  }

  wanted(project: Project, issue: SourceIssue): boolean {
    const assignees = this.assignees(project)
    if (assignees.mode === 'everyone') return true
    if (assignees.mode === 'me') return issue.mine
    return assignees.people.some((person) => person.id === issue.data.assigneeId)
  }

  async create(project: Project, input: { title: string; description: string }): Promise<SourceIssue> {
    const viewerId = await this.viewerId(project)
    const issue = await this.client(project).createIssue({ teamId: project.linear.teamId as string, title: input.title, description: input.description, assigneeId: viewerId ?? undefined })
    return this.toIssue(issue, viewerId)
  }

  readonly hooks: TicketSource['hooks'] = {
    stageEntered: (ticket, stage, project) => this.setState(ticket.linearId as string, project, stage.id),
    ticketDone: (ticket, project) => this.setState(ticket.linearId as string, project, 'done'),
    planApproved: async (ticket, markdown, project) => {
      const push = { ...DEFAULT_LINEAR_PUSH, ...project.linear.push }
      if (push.planComment) await this.client(project).comment(ticket.linearId as string, `**Plan approved in Eregion**\n\n${markdown.trim()}`)
      if (push.planDescription) await this.client(project).updateIssue(ticket.linearId as string, { description: descriptionWithPlan(ticket.description, markdown) })
      if (push.planDocument) await this.client(project).saveIssueDocument(ticket.linearId as string, PLAN_DOCUMENT, markdown.trim())
    },
    prsOpened: async (ticket, prs, project) => {
      if (!{ ...DEFAULT_LINEAR_PUSH, ...project.linear.push }.prLinks) return
      for (const pr of prs) await this.client(project).attachLink(ticket.linearId as string, pr.url, `${pr.repo} #${pr.number}: ${pr.title}`)
    },
    specApproved: async (ticket, markdown, project) => {
      if (!{ ...DEFAULT_LINEAR_PUSH, ...project.linear.push }.specDocument) return
      await this.client(project).saveIssueDocument(ticket.linearId as string, SPEC_DOCUMENT, markdown.trim())
    },
    buildLogReady: async (ticket, markdown, project) => {
      if (!{ ...DEFAULT_LINEAR_PUSH, ...project.linear.push }.buildLog) return
      await this.client(project).saveIssueDocument(ticket.linearId as string, BUILD_LOG_DOCUMENT, markdown)
    }
  }

  private async setState(issueId: string, project: Project, key: string): Promise<void> {
    const stateId = project.linear.statusByStage?.[key]
    if (stateId) await this.client(project).updateIssue(issueId, { stateId })
  }
}
