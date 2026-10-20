import type { Project } from '@shared/model'
import { DEFAULT_SOURCE_PUSH, importRules, sourceOf, type Connection } from '@shared/sources'
import type { Connections } from './connections'
import { restJson } from './connections'
import type { FetchLike } from './linear'
import type { SourceIssue, TicketSource } from './sources'

type Json = Record<string, unknown>

/** Jira's rich text (Atlassian Document Format) as plain text: paragraphs, line breaks, list items, code. */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : ''
  const value = node as Json
  const children = Array.isArray(value.content) ? (value.content as unknown[]) : []
  const inner = (): string => children.map(adfToText).join('')
  switch (value.type) {
    case 'text':
      return String(value.text ?? '')
    case 'hardBreak':
      return '\n'
    case 'paragraph':
    case 'heading':
    case 'codeBlock':
    case 'blockquote':
      return `${inner().trimEnd()}\n\n`
    case 'bulletList':
    case 'orderedList':
      return `${children.map((item) => `- ${adfToText(item).trim()}`).join('\n')}\n\n`
    case 'listItem':
      return children.map(adfToText).join('').trim()
    case 'mention':
      return String((value.attrs as Json | undefined)?.text ?? '')
    case 'doc':
      return inner().trim()
    default:
      return inner()
  }
}

/** Plain text (markdown, say) as Jira rich text: a paragraph per blank-line block, line breaks kept. */
export function textToAdf(text: string): Json {
  const paragraphs = text
    .trim()
    .split(/\n{2,}/)
    .map((block) => ({
      type: 'paragraph',
      content: block.split('\n').flatMap((line, index) => [...(index > 0 ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])])
    }))
  return { type: 'doc', version: 1, content: paragraphs }
}

/** A JQL string literal. */
const quote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * The JQL for a project's importable issues: its Jira project, still To Do, assigned to whoever the rules say,
 * with every wanted label and none of the excluded ones.
 */
export function importJql(projectKey: string, rules: ReturnType<typeof importRules>): string {
  const parts = [`project = ${quote(projectKey)}`, 'statusCategory = "To Do"']
  if (rules.who === 'me') parts.push('assignee = currentUser()')
  if (rules.who === 'people') parts.push(`assignee in (${rules.people.map((person) => quote(person.id)).join(', ') || '""'})`)
  for (const label of rules.labels) parts.push(`labels = ${quote(label)}`)
  if (rules.excludeLabels.length) parts.push(`(labels is EMPTY OR labels not in (${rules.excludeLabels.map(quote).join(', ')}))`)
  return `${parts.join(' AND ')} ORDER BY updated DESC`
}

const FIELDS = ['summary', 'description', 'status', 'labels', 'assignee', 'comment', 'priority']

/** Jira Cloud's REST API (v3), signed in with your email and an API token. */
export class JiraClient {
  constructor(
    private readonly connection: Connection,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.connection.email ?? ''}:${this.token}`).toString('base64')
    return restJson<T>(this.fetchImpl, 'Jira', `${this.connection.url}${path}`, { method, headers: { authorization: `Basic ${auth}` }, body })
  }

  myself(): Promise<{ accountId: string; displayName: string }> {
    return this.request('GET', '/rest/api/3/myself')
  }

  async search(jql: string): Promise<Json[]> {
    const result = await this.request<{ issues?: Json[] }>('POST', '/rest/api/3/search/jql', { jql, fields: FIELDS, maxResults: 100 })
    return result.issues ?? []
  }

  issue(key: string): Promise<Json> {
    return this.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(',')}`)
  }

  createIssue(projectKey: string, summary: string, description: string, assigneeId: string): Promise<{ id: string; key: string }> {
    return this.request('POST', '/rest/api/3/issue', { fields: { project: { key: projectKey }, summary, description: textToAdf(description || summary), issuetype: { name: 'Task' }, assignee: { accountId: assigneeId } } })
  }

  comment(key: string, text: string): Promise<void> {
    return this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: textToAdf(text) })
  }

  async transitionTo(key: string, status: string): Promise<void> {
    const { transitions } = await this.request<{ transitions: { id: string; name: string; to?: { name?: string } }[] }>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)
    const wanted = status.trim().toLowerCase()
    const transition = transitions.find((item) => item.to?.name?.toLowerCase() === wanted) ?? transitions.find((item) => item.name.toLowerCase() === wanted)
    if (!transition) throw new Error(`${key} can't move to "${status}" from where it is. It can go to: ${transitions.map((item) => item.to?.name ?? item.name).join(', ') || 'nowhere'}`)
    await this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: transition.id } })
  }

  remoteLink(key: string, url: string, title: string): Promise<void> {
    return this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`, { object: { url, title } })
  }

  /** Every status the project's issues can be in, for choosing one per stage. */
  async statuses(projectKey: string): Promise<string[]> {
    const types = await this.request<{ statuses: { name: string }[] }[]>('GET', `/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`)
    return [...new Set(types.flatMap((type) => type.statuses.map((status) => status.name)))]
  }
}

/**
 * Jira as a ticket source: To Do issues in a Jira project, assigned to whoever the rules say. A ticket moves
 * its issue to the status set for each stage, and the plan and PR links go back as a comment and remote links.
 */
export class JiraSource implements TicketSource {
  readonly kind = 'jira' as const
  private readonly accounts = new Map<string, Promise<string>>()

  constructor(
    private readonly connections: Connections,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  private client(project: Project): JiraClient {
    const id = sourceOf(project).connectionId as string
    return new JiraClient(this.connections.get(id), this.connections.token(id), this.fetchImpl)
  }

  private site(project: Project): string {
    return this.connections.get(sourceOf(project).connectionId as string).url
  }

  /** Your Jira account id on this connection. */
  private me(project: Project): Promise<string> {
    const id = sourceOf(project).connectionId as string
    if (!this.accounts.has(id)) {
      const account = this.client(project)
        .myself()
        .then((me) => me.accountId)
      account.catch(() => this.accounts.delete(id))
      this.accounts.set(id, account)
    }
    return this.accounts.get(id) as Promise<string>
  }

  location(project: Project): string | null {
    return sourceOf(project).location?.trim() || null
  }

  notReady(project: Project): string | null {
    const source = sourceOf(project)
    if (!source.connectionId || !this.connections.list().some((connection) => connection.id === source.connectionId)) return `Choose ${project.name}'s Jira connection in its Tickets and code step`
    if (!source.location?.trim()) return `Enter ${project.name}'s Jira project key in its Tickets and code step`
    return null
  }

  private toIssue(project: Project, raw: Json, me: string): SourceIssue {
    const fields = (raw.fields as Json | undefined) ?? {}
    const status = (fields.status as Json | undefined) ?? {}
    const assignee = fields.assignee as Json | null | undefined
    const comments = (((fields.comment as Json | undefined)?.comments as Json[] | undefined) ?? []).map((comment) => ({
      author: String(((comment.author as Json | undefined) ?? {}).displayName ?? 'someone'),
      body: adfToText(comment.body),
      createdAt: String(comment.created ?? '')
    }))
    return {
      id: String(raw.id),
      key: String(raw.key),
      title: String(fields.summary ?? ''),
      description: adfToText(fields.description),
      url: `${this.site(project)}/browse/${String(raw.key)}`,
      data: {
        state: String(status.name ?? ''),
        priority: String(((fields.priority as Json | undefined) ?? {}).name ?? ''),
        labels: (fields.labels as string[] | undefined) ?? [],
        comments,
        assignee: assignee ? String(assignee.displayName ?? '') : null,
        assigneeId: assignee ? String(assignee.accountId ?? '') : null
      },
      closed: ((status.statusCategory as Json | undefined) ?? {}).key === 'done',
      mine: Boolean(assignee && assignee.accountId === me)
    }
  }

  async candidates(project: Project): Promise<SourceIssue[]> {
    const me = await this.me(project)
    const raw = await this.client(project).search(importJql(this.location(project) as string, importRules(sourceOf(project))))
    return raw.map((issue) => this.toIssue(project, issue, me))
  }

  async byIds(project: Project, ids: string[]): Promise<SourceIssue[]> {
    const me = await this.me(project)
    const raw = await this.client(project).search(`id in (${ids.map((id) => Number(id)).filter(Number.isFinite).join(', ') || '0'})`)
    return raw.map((issue) => this.toIssue(project, issue, me))
  }

  async byKey(project: Project, key: string): Promise<SourceIssue> {
    return this.toIssue(project, await this.client(project).issue(key.trim().toUpperCase()), await this.me(project))
  }

  wanted(project: Project, issue: SourceIssue): boolean {
    const rules = importRules(sourceOf(project))
    if (rules.who === 'everyone') return true
    if (rules.who === 'me') return issue.mine
    return rules.people.some((person) => person.id === issue.data.assigneeId)
  }

  async create(project: Project, input: { title: string; description: string }): Promise<SourceIssue> {
    const created = await this.client(project).createIssue(this.location(project) as string, input.title, input.description, await this.me(project))
    return this.byKey(project, created.key)
  }

  readonly hooks: TicketSource['hooks'] = {
    stageEntered: (ticket, stage, project) => this.moveTo(ticket.key, project, stage.id),
    ticketDone: (ticket, project) => this.moveTo(ticket.key, project, 'done'),
    planApproved: async (ticket, markdown, project) => {
      if ({ ...DEFAULT_SOURCE_PUSH, ...sourceOf(project).push }.planComment) await this.client(project).comment(ticket.key, `Plan approved in Eregion\n\n${markdown.trim()}`)
    },
    prsOpened: async (ticket, prs, project) => {
      if (!{ ...DEFAULT_SOURCE_PUSH, ...sourceOf(project).push }.prLinks) return
      for (const pr of prs) await this.client(project).remoteLink(ticket.key, pr.url, `${pr.repo} #${pr.number}: ${pr.title}`)
    }
  }

  private async moveTo(key: string, project: Project, stageId: string): Promise<void> {
    const status = sourceOf(project).statusByStage?.[stageId]
    if (status) await this.client(project).transitionTo(key, status)
  }
}
