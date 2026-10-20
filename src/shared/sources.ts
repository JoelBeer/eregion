/**
 * Where a project's tickets come from: Linear, GitHub Issues, Jira, GitLab issues, or nowhere (tickets made
 * in Eregion). Each project picks one; Settings › Integrations holds the connections.
 */

export type TicketSourceKind = 'linear' | 'github-issues' | 'jira' | 'gitlab-issues' | 'manual'

export const SOURCE_NAMES: Record<TicketSourceKind, string> = {
  linear: 'Linear',
  'github-issues': 'GitHub Issues',
  jira: 'Jira',
  'gitlab-issues': 'GitLab issues',
  manual: 'Eregion only'
}

/** Whose issues come in by themselves, and which labels they need. */
export interface ImportRules {
  who: 'me' | 'people' | 'everyone'
  /** The source's own ids (Jira account ids, GitHub or GitLab usernames). Linear keeps its people in Settings › Integrations. */
  people: { id: string; name: string }[]
  /** Only issues with every one of these labels (any case). */
  labels: string[]
  /** Never issues with any of these. */
  excludeLabels: string[]
}

export const DEFAULT_IMPORT_RULES: ImportRules = { who: 'me', people: [], labels: [], excludeLabels: [] }

export interface TicketSourceConfig {
  kind: TicketSourceKind
  /** The Jira or GitLab connection (Settings › Integrations) it reads from. */
  connectionId?: string | null
  /** GitHub Issues: owner/name (the first repo's, if empty). GitLab: group/project. Jira: the project key. */
  location?: string
  /** 'auto' brings issues in by themselves; 'manual' only imports the ones you ask for by key. */
  pullFrom?: 'auto' | 'manual'
  rules?: ImportRules
  /** Jira: the status to move an issue to as it enters each stage (by stage id), and 'done'. */
  statusByStage?: Record<string, string>
  /** What goes back: the approved plan as a comment, and links to the pull requests. */
  push?: { planComment: boolean; prLinks: boolean }
  pollSec?: number
}

export const DEFAULT_SOURCE_PUSH = { planComment: true, prLinks: true }

/** The project's ticket source. Projects from before sources had Linear when a team was linked, and nothing otherwise. */
export function sourceOf(project: { source?: TicketSourceConfig | null; linear: { teamId?: string } }): TicketSourceConfig {
  if (project.source?.kind) return project.source
  return { kind: project.linear.teamId ? 'linear' : 'manual' }
}

export function importRules(source: TicketSourceConfig): ImportRules {
  return { ...DEFAULT_IMPORT_RULES, ...source.rules }
}

/** Whether an issue's labels pass the rules: every wanted label there, no excluded one (any case). */
export function labelsMatch(labels: string[], rules: Pick<ImportRules, 'labels' | 'excludeLabels'>): boolean {
  const have = new Set(labels.map((label) => label.toLowerCase()))
  return rules.labels.every((label) => have.has(label.toLowerCase())) && !rules.excludeLabels.some((label) => have.has(label.toLowerCase()))
}

/** A project's ticket source as the Board shows it. */
export interface SourceStatus {
  kind: TicketSourceKind
  name: string
  /** The team, repo or project it reads from. */
  location: string | null
  /** Why it can't sync now, or null when it can. */
  notReady: string | null
  /** Issues come in by themselves (otherwise only by key). */
  auto: boolean
  /** Whose issues: "assigned to you", "in the team", ... */
  whose: string
  lastSyncAt: string | null
  error: string | null
  /** What an issue key looks like here, for the import box. */
  keyExample: string
}

/** The label GitHub Issues and GitLab carry while a ticket is in a stage. */
export const STAGE_LABEL_PREFIX = 'eregion:'
export const stageLabel = (stageId: string): string => `${STAGE_LABEL_PREFIX}${stageId}`

/** A Jira or GitLab account Eregion reads issues from (and, for GitLab, opens merge requests in). */
export interface Connection {
  id: string
  kind: 'jira' | 'gitlab'
  name: string
  /** Jira: https://your-site.atlassian.net. GitLab: https://gitlab.com, or your own. */
  url: string
  /** Jira signs in with your email and an API token. */
  email?: string
  /** Who it's signed in as, from the last test. */
  account?: string | null
  testedAt?: string | null
  error?: string | null
}

/** A connection as you add it: the token is encrypted once saved and never sent back to the screens. */
export interface ConnectionInput extends Pick<Connection, 'kind' | 'name' | 'url' | 'email'> {
  id?: string
  /** Leave empty when editing to keep the saved one. */
  token: string
}

/** Checks a connection before it's saved. */
export function connectionProblems(input: ConnectionInput, editing: boolean): string[] {
  const problems: string[] = []
  if (!input.name.trim()) problems.push('Give it a name')
  if (!/^https:\/\/[^\s/]+/.test(input.url.trim())) problems.push('The address starts with https://')
  if (input.kind === 'jira' && !/^\S+@\S+$/.test(input.email?.trim() ?? '')) problems.push('Jira needs the email you sign in with')
  if (!editing && !input.token.trim()) problems.push(input.kind === 'jira' ? 'Paste a Jira API token' : 'Paste a GitLab personal access token')
  return problems
}
