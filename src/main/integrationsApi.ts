import type { EregionApi } from '@shared/api'
import { callbackUrl, OAUTH_PORTS, type LinearStatus } from '@shared/integrations'
import { importRules, sourceOf, SOURCE_NAMES } from '@shared/sources'
import type { Ticket } from '@shared/tickets'
import type { LinearAuth } from './integrations/linearAuth'
import type { IssueSync } from './integrations/sources'
import type { CiWatcher } from './pipeline/ciWatch'
import type { PrStage } from './pipeline/prStage'
import type { PrStore } from './pipeline/prs'
import type { TicketStore } from './pipeline/stores'
import type { ProjectStore } from './projects/store'

export type IntegrationsApi = Pick<
  EregionApi,
  | 'getLinearStatus'
  | 'setLinearClientId'
  | 'signInToLinear'
  | 'cancelLinearSignIn'
  | 'useLinearApiKey'
  | 'signOutOfLinear'
  | 'listLinearTeams'
  | 'listLinearStates'
  | 'listLinearUsers'
  | 'setLinearImportAssignees'
  | 'syncLinear'
  | 'getSourceStatus'
  | 'syncTickets'
  | 'importIssue'
  | 'pullTicket'
  | 'getTicketPrs'
  | 'markPrsReady'
  | 'updatePrDescription'
  | 'setAutofix'
  | 'checkCiNow'
  | 'createTicket'
>

export interface IntegrationsApiDeps {
  auth: LinearAuth
  sync: IssueSync
  projects: ProjectStore
  tickets: TicketStore
  prs: PrStore
  prStage: PrStage
  ci: CiWatcher
  openExternal(url: string): Promise<void>
  linearChanged(): void
  ticketChanged(ticket: Ticket): void
  /** Creating a ticket in a project that isn't linked to Linear. */
  createLocalTicket: EregionApi['createTicket']
}

export function createIntegrationsApi(deps: IntegrationsApiDeps): IntegrationsApi {
  const { auth, sync, projects, tickets, prs } = deps
  const status = (): LinearStatus => {
    const last = sync.lastSync('linear')
    return {
      clientId: auth.clientId(),
      method: auth.method(),
      viewer: auth.viewer(),
      importAssignees: auth.importAssignees(),
      error: last.error,
      lastSyncAt: last.at,
      callbackUrls: OAUTH_PORTS.map(callbackUrl)
    }
  }
  const client = () => {
    const linear = auth.client()
    if (!linear) throw new Error('Connect Linear first, in Settings › Integrations')
    return linear
  }
  const connected = <T>(task: () => Promise<T>) => async (): Promise<T> => {
    const result = await task()
    deps.linearChanged()
    void sync.syncAll().catch(() => undefined)
    return result
  }

  return {
    getLinearStatus: async () => status(),
    setLinearClientId: async (clientId) => {
      auth.setClientId(clientId)
      deps.linearChanged()
      return status()
    },
    signInToLinear: (clientSecret) => connected(() => auth.signIn(deps.openExternal, clientSecret?.trim() || undefined))(),
    cancelLinearSignIn: async () => auth.cancelSignIn(),
    useLinearApiKey: (key) => connected(() => auth.useApiKey(key))(),
    signOutOfLinear: async () => {
      auth.signOut()
      deps.linearChanged()
    },
    listLinearTeams: () => client().teams(),
    listLinearStates: (teamId) => client().states(teamId),
    listLinearUsers: () => client().users(),
    setLinearImportAssignees: async (value) => {
      auth.setImportAssignees(value)
      deps.linearChanged()
      void sync.syncAll().catch(() => undefined)
      return status()
    },
    syncLinear: async () => {
      await sync.syncAll()
      return status()
    },
    getSourceStatus: async (projectId) => {
      const project = projects.get(projectId)
      const config = sourceOf(project)
      const source = sync.source(project)
      const last = sync.lastSync(config.kind)
      const rules = importRules(config)
      const assignees = auth.importAssignees()
      const who = config.kind === 'linear' ? (assignees.mode === 'people' ? 'people' : assignees.mode) : rules.who
      const people = config.kind === 'linear' && assignees.mode === 'people' ? assignees.people : rules.people
      const whose = who === 'me' ? 'assigned to you' : who === 'everyone' ? 'open, assigned to anyone' : `assigned to ${people.map((person) => person.name).join(', ') || 'the people you chose'}`
      const location = source?.location(project) ?? null
      return {
        kind: config.kind,
        name: SOURCE_NAMES[config.kind],
        location,
        notReady: source ? source.notReady(project) : null,
        auto: config.kind === 'linear' ? (project.linear.pullFrom ?? 'assigned') !== 'manual' : (config.pullFrom ?? 'auto') !== 'manual',
        whose,
        lastSyncAt: last.at,
        error: last.error,
        keyExample: config.kind === 'github-issues' ? 'GH-12' : config.kind === 'gitlab-issues' ? 'GL-12' : config.kind === 'jira' ? `${config.location?.trim() || 'KEY'}-12` : `${project.linear.teamKey ?? project.initials}-123`
      }
    },
    syncTickets: async () => sync.syncAll(),
    importIssue: async (projectId, key) => sync.importByKey(projects.get(projectId), key),
    pullTicket: async (ticketId) => sync.pullAgain(tickets.get(ticketId)),

    getTicketPrs: async (ticketId) => prs.forTicket(ticketId).map(({ repoId: _repoId, headSha: _headSha, rerunSha: _rerunSha, pushedSha: _pushedSha, ...pr }) => pr),
    markPrsReady: (ticketId) => deps.prStage.markReady(ticketId),
    updatePrDescription: (ticketId, repo, markdown) => deps.prStage.updateDescription(ticketId, repo, markdown),
    setAutofix: async (ticketId, on) => {
      deps.ci.setAutofix(ticketId, on)
      deps.ticketChanged(tickets.get(ticketId))
    },
    checkCiNow: (ticketId) => deps.ci.check(ticketId),

    /** In a project linked to a tracker, a new ticket is a new issue there, assigned to you. */
    createTicket: async (projectId, title, description) => (await sync.create(projects.get(projectId), title, description)) ?? deps.createLocalTicket(projectId, title, description)
  }
}
