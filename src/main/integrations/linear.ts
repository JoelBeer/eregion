import type { LinearIssue, LinearState, LinearStateType, LinearTeam, LinearUser, LinearViewer } from '@shared/integrations'

export const LINEAR_API = 'https://api.linear.app/graphql'

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>

/** How a request authenticates: a personal API key goes in as is, an OAuth token as a bearer token. */
export type LinearCredential = { kind: 'api-key'; key: string } | { kind: 'oauth'; token: () => Promise<string> }

export class LinearAuthError extends Error {}

const ISSUE_FIELDS = `
  id identifier title description url priorityLabel estimate updatedAt
  state { id name type }
  assignee { id name }
  labels { nodes { name } }
  comments(first: 50) { nodes { body createdAt user { name } } }
`

interface RawIssue {
  id: string
  identifier: string
  title: string
  description: string | null
  url: string
  priorityLabel: string
  estimate: number | null
  updatedAt: string
  state: { id: string; name: string; type: string }
  assignee: { id: string; name: string } | null
  labels: { nodes: { name: string }[] }
  comments: { nodes: { body: string; createdAt: string; user: { name: string } | null }[] }
}

function toIssue(raw: RawIssue): LinearIssue {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description ?? '',
    url: raw.url,
    priorityLabel: raw.priorityLabel,
    estimate: raw.estimate,
    updatedAt: raw.updatedAt,
    state: { ...raw.state, type: raw.state.type as LinearStateType },
    assignee: raw.assignee,
    labels: raw.labels.nodes.map((label) => label.name),
    comments: raw.comments.nodes
      .map((comment) => ({ author: comment.user?.name ?? 'Linear', body: comment.body, createdAt: comment.createdAt }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
}

/** Linear's GraphQL API, with only what Eregion uses. */
export class LinearClient {
  constructor(
    private readonly credential: LinearCredential,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const authorization = this.credential.kind === 'api-key' ? this.credential.key : `Bearer ${await this.credential.token()}`
    const response = await this.fetchImpl(LINEAR_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({ query, variables })
    })
    if (response.status === 401) throw new LinearAuthError('Linear rejected the sign-in. Connect Linear again in Settings › Accounts.')
    const body = (await response.json().catch(() => null)) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] } | null
    if (body?.errors?.length) {
      if (body.errors.some((error) => error.extensions?.code === 'AUTHENTICATION_ERROR')) throw new LinearAuthError('Linear rejected the sign-in. Connect Linear again in Settings › Accounts.')
      throw new Error(`Linear: ${body.errors.map((error) => error.message).join('; ')}`)
    }
    if (!response.ok || !body?.data) throw new Error(`Linear answered ${response.status}`)
    return body.data
  }

  async viewer(): Promise<LinearViewer> {
    const data = await this.request<{ viewer: { id: string; name: string; email: string; organization: { name: string } } }>('query { viewer { id name email organization { name } } }')
    return { id: data.viewer.id, name: data.viewer.name, email: data.viewer.email, organization: data.viewer.organization.name }
  }

  async teams(): Promise<LinearTeam[]> {
    const data = await this.request<{ teams: { nodes: LinearTeam[] } }>('query { teams(first: 100) { nodes { id key name } } }')
    return data.teams.nodes.sort((a, b) => a.name.localeCompare(b.name))
  }

  async states(teamId: string): Promise<LinearState[]> {
    const data = await this.request<{ team: { states: { nodes: LinearState[] } } }>('query($id: String!) { team(id: $id) { states { nodes { id name type color position } } } }', { id: teamId })
    const order: LinearStateType[] = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate']
    return data.team.states.nodes.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.position - b.position)
  }

  async users(): Promise<LinearUser[]> {
    const data = await this.request<{ users: { nodes: (LinearUser & { active: boolean })[] } }>('query { users(first: 250) { nodes { id name email active } } }')
    return data.users.nodes.filter((user) => user.active).map(({ id, name, email }) => ({ id, name, email }))
  }

  /** Issues in a team assigned to the viewer (or to the given people), in the given state types. */
  /** Issues in the team and states, assigned to you, to these people, or to anyone (and no one) for 'everyone'. */
  async assignedIssues(options: { teamId: string; assigneeIds: string[] | 'me' | 'everyone'; stateTypes: LinearStateType[] }): Promise<LinearIssue[]> {
    const assignee = options.assigneeIds === 'me' ? { isMe: { eq: true } } : options.assigneeIds === 'everyone' ? undefined : { id: { in: options.assigneeIds } }
    const filter = { team: { id: { eq: options.teamId } }, ...(assignee ? { assignee } : {}), state: { type: { in: options.stateTypes } } }
    const issues: LinearIssue[] = []
    let after: string | null = null
    for (let page = 0; page < 10; page++) {
      const data: { issues: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.request(
        `query($filter: IssueFilter, $after: String) { issues(filter: $filter, first: 50, after: $after) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
        { filter, after }
      )
      issues.push(...data.issues.nodes.map(toIssue))
      if (!data.issues.pageInfo.hasNextPage) break
      after = data.issues.pageInfo.endCursor
    }
    return issues
  }

  /** Issues by id, for checking on ones that dropped out of the assigned list. */
  async issuesById(ids: string[]): Promise<LinearIssue[]> {
    if (ids.length === 0) return []
    const data = await this.request<{ issues: { nodes: RawIssue[] } }>(`query($ids: [ID!]) { issues(filter: { id: { in: $ids } }, first: 100) { nodes { ${ISSUE_FIELDS} } } }`, { ids })
    return data.issues.nodes.map(toIssue)
  }

  /** One issue by its id or its key, such as WM-12. */
  async issue(idOrKey: string): Promise<LinearIssue> {
    const data = await this.request<{ issue: RawIssue }>(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id: idOrKey })
    return toIssue(data.issue)
  }

  async createIssue(input: { teamId: string; title: string; description: string; assigneeId?: string }): Promise<LinearIssue> {
    const data = await this.request<{ issueCreate: { success: boolean; issue: RawIssue } }>(
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
      { input }
    )
    if (!data.issueCreate.success) throw new Error("Linear didn't create the issue")
    return toIssue(data.issueCreate.issue)
  }

  async comment(issueId: string, body: string): Promise<void> {
    await this.request('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId, body } })
  }

  async updateIssue(issueId: string, input: { stateId?: string; description?: string }): Promise<void> {
    await this.request('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: issueId, input })
  }

  async attachLink(issueId: string, url: string, title: string): Promise<void> {
    await this.request('mutation($issueId: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }', { issueId, url, title })
  }
}
