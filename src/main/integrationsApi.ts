import type { EregionApi } from '@shared/api'
import { callbackUrl, OAUTH_PORTS, type LinearStatus } from '@shared/integrations'
import type { Ticket } from '@shared/tickets'
import type { LinearAuth } from './integrations/linearAuth'
import type { LinearSync } from './integrations/linearSync'
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
  | 'importLinearIssue'
  | 'pullTicketFromLinear'
  | 'getTicketPrs'
  | 'markPrsReady'
  | 'updatePrDescription'
  | 'setAutofix'
  | 'checkCiNow'
  | 'createTicket'
>

export interface IntegrationsApiDeps {
  auth: LinearAuth
  sync: LinearSync
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
    const last = sync.lastSync()
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
    importLinearIssue: async (projectId, key) => sync.importByKey(projects.get(projectId), key),
    pullTicketFromLinear: async (ticketId) => sync.pullAgain(tickets.get(ticketId)),

    getTicketPrs: async (ticketId) => prs.forTicket(ticketId).map(({ repoId: _repoId, headSha: _headSha, rerunSha: _rerunSha, pushedSha: _pushedSha, ...pr }) => pr),
    markPrsReady: (ticketId) => deps.prStage.markReady(ticketId),
    updatePrDescription: (ticketId, repo, markdown) => deps.prStage.updateDescription(ticketId, repo, markdown),
    setAutofix: async (ticketId, on) => {
      deps.ci.setAutofix(ticketId, on)
      deps.ticketChanged(tickets.get(ticketId))
    },
    checkCiNow: (ticketId) => deps.ci.check(ticketId),

    /** In a project linked to a Linear team, a new ticket is a new Linear issue assigned to you. */
    createTicket: async (projectId, title, description) => {
      const project = projects.get(projectId)
      const linear = auth.client()
      if (!project.linear.teamId || !linear) return deps.createLocalTicket(projectId, title, description)
      if (!title.trim()) throw new Error('Give the ticket a title')
      const issue = await linear.createIssue({ teamId: project.linear.teamId, title: title.trim(), description, assigneeId: auth.viewer()?.id })
      return sync.importByKey(project, issue.identifier)
    }
  }
}
