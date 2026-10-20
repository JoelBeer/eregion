import { DEFAULT_IMPORT_STATE_TYPES, type LinearIssue } from '@shared/integrations'
import { DEFAULT_LINEAR_PUSH, type Project } from '@shared/model'
import { importRules, labelsMatch, sourceOf } from '@shared/sources'
import { descriptionWithPlan } from './hooks'
import type { LinearAuth } from './linearAuth'
import type { SourceIssue, TicketSource } from './sources'

const CLOSED = new Set(['completed', 'canceled', 'duplicate'])

/**
 * Linear as a ticket source: issues in the project's team, assigned to whoever Settings › Integrations says
 * (you, chosen people, or everyone), in the importable states, with the project's labels.
 */
export class LinearSource implements TicketSource {
  readonly kind = 'linear' as const

  constructor(private readonly auth: LinearAuth) {}

  private client() {
    const client = this.auth.client()
    if (!client) throw new Error('Connect Linear first, in Settings › Integrations')
    return client
  }

  notReady(project: Project): string | null {
    if (!this.auth.client()) return 'Connect Linear first, in Settings › Integrations'
    if (!project.linear.teamId) return `Choose ${project.name}'s Linear team in its Tickets and code step`
    return null
  }

  toIssue(issue: LinearIssue): SourceIssue {
    return {
      id: issue.id,
      key: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      data: { state: issue.state.name, priority: issue.priorityLabel, estimate: issue.estimate, labels: issue.labels, comments: issue.comments, assignee: issue.assignee?.name ?? null, assigneeId: issue.assignee?.id ?? null },
      closed: CLOSED.has(issue.state.type),
      mine: Boolean(issue.assignee && issue.assignee.id === this.auth.viewer()?.id)
    }
  }

  async candidates(project: Project): Promise<SourceIssue[]> {
    const assignees = this.auth.importAssignees()
    const assigneeIds = assignees.mode === 'people' ? assignees.people.map((person) => person.id) : assignees.mode
    const stateTypes = project.linear.importStateTypes?.length ? project.linear.importStateTypes : DEFAULT_IMPORT_STATE_TYPES
    const issues = await this.client().assignedIssues({ teamId: project.linear.teamId as string, assigneeIds, stateTypes })
    const rules = importRules(sourceOf(project))
    return issues.filter((issue) => labelsMatch(issue.labels, rules)).map((issue) => this.toIssue(issue))
  }

  async byIds(_project: Project, ids: string[]): Promise<SourceIssue[]> {
    return (await this.client().issuesById(ids)).map((issue) => this.toIssue(issue))
  }

  async byKey(_project: Project, key: string): Promise<SourceIssue> {
    return this.toIssue(await this.client().issue(key.toUpperCase()))
  }

  wanted(_project: Project, issue: SourceIssue): boolean {
    const assignees = this.auth.importAssignees()
    if (assignees.mode === 'everyone') return true
    if (assignees.mode === 'me') return issue.mine
    return assignees.people.some((person) => person.id === issue.data.assigneeId)
  }

  async create(project: Project, input: { title: string; description: string }): Promise<SourceIssue> {
    const issue = await this.client().createIssue({ teamId: project.linear.teamId as string, title: input.title, description: input.description, assigneeId: this.auth.viewer()?.id })
    return this.toIssue(issue)
  }

  readonly hooks: TicketSource['hooks'] = {
    stageEntered: (ticket, stage, project) => this.setState(ticket.linearId as string, project, stage.id),
    ticketDone: (ticket, project) => this.setState(ticket.linearId as string, project, 'done'),
    planApproved: async (ticket, markdown, project) => {
      const push = { ...DEFAULT_LINEAR_PUSH, ...project.linear.push }
      if (push.planComment) await this.client().comment(ticket.linearId as string, `**Plan approved in Eregion**\n\n${markdown.trim()}`)
      if (push.planDescription) await this.client().updateIssue(ticket.linearId as string, { description: descriptionWithPlan(ticket.description, markdown) })
    },
    prsOpened: async (ticket, prs, project) => {
      if (!{ ...DEFAULT_LINEAR_PUSH, ...project.linear.push }.prLinks) return
      for (const pr of prs) await this.client().attachLink(ticket.linearId as string, pr.url, `${pr.repo} #${pr.number}: ${pr.title}`)
    }
  }

  private async setState(issueId: string, project: Project, key: string): Promise<void> {
    const stateId = project.linear.statusByStage?.[key]
    if (stateId) await this.client().updateIssue(issueId, { stateId })
  }
}
