/** Linear and GitHub as the screens see them. */

export interface LinearViewer {
  id: string
  name: string
  email: string
  organization: string
}

export interface LinearStatus {
  /** The client id of the user's own private Linear app, when they've entered one. */
  clientId: string | null
  /** How Eregion is connected, or null when it isn't. */
  method: 'oauth' | 'api-key' | null
  viewer: LinearViewer | null
  /** Whose issues are imported: the connected account, or chosen people. */
  importAssignees: ImportAssignees
  /** The last sync's problem, if it failed. */
  error: string | null
  lastSyncAt: string | null
  /** The loopback addresses to register as callback URLs in the Linear app. */
  callbackUrls: string[]
}

/** Whose Linear issues come in by themselves: yours, chosen people's, or everyone's in the team. */
export type ImportAssignees = { mode: 'me' } | { mode: 'people'; people: { id: string; name: string }[] } | { mode: 'everyone' }

export interface LinearTeam {
  id: string
  key: string
  name: string
}

export type LinearStateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'duplicate'

export interface LinearState {
  id: string
  name: string
  type: LinearStateType
  color: string
  position: number
}

export interface LinearUser {
  id: string
  name: string
  email: string
}

export interface LinearIssue {
  id: string
  identifier: string
  title: string
  description: string
  url: string
  priorityLabel: string
  estimate: number | null
  updatedAt: string
  state: { id: string; name: string; type: LinearStateType }
  assignee: { id: string; name: string } | null
  labels: string[]
  comments: { author: string; body: string; createdAt: string }[]
}

export const OAUTH_PORTS = [47321, 47322, 47323] as const
export const callbackUrl = (port: number): string => `http://127.0.0.1:${port}/oauth/callback`

/** State types imported by default: Backlog, Todo and other unstarted states. */
export const DEFAULT_IMPORT_STATE_TYPES: LinearStateType[] = ['backlog', 'unstarted']

export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'

export type GitHubPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read'

export interface GitHubRepo {
  /** owner/name */
  name: string
  url: string
  private: boolean
  permission: GitHubPermission
  pushedAt: string | null
  /** The Eregion projects that use it. */
  projects: string[]
}

/** The account gh is signed in to, its organisations and the repos it can reach (most recently pushed first). */
export interface GitHubAccount {
  runtime: string
  login: string
  name: string | null
  url: string
  organizations: string[]
  repos: GitHubRepo[]
  /** There are more repos than were read. */
  more: boolean
}

export interface PrCheck {
  name: string
  workflow: string
  bucket: CheckBucket
  link: string
}

export interface PullRequest {
  id: number
  ticketId: number
  repo: string
  number: number
  url: string
  title: string
  draft: boolean
  state: 'open' | 'merged' | 'closed'
  base: string
  branch: string
  additions: number
  deletions: number
  changedFiles: number
  autofix: boolean
  autofixPausedReason: string | null
  /** The last checks Eregion saw, for the Watch CI screen. */
  checks: PrCheck[]
  /** Which checks those are: the required ones, or all of them when the repo requires none. */
  checksScope: 'required' | 'all' | null
  checkedAt: string | null
  mergedAt: string | null
  attempts: number
}
