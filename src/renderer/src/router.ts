import { useEffect, useState } from 'react'

export const SETUP_STEPS = ['repos', 'variables', 'setup', 'services', 'pipeline', 'integrations', 'test'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

export const SETUP_STEP_LABELS: Record<SetupStep, string> = {
  repos: 'Repos',
  variables: 'Variables',
  setup: 'Setup',
  services: 'Services and teardown',
  pipeline: 'Pipeline',
  integrations: 'Tickets and code',
  test: 'Test run'
}

export const TICKET_TABS = ['conversation', 'outputs', 'diff', 'log'] as const
export type TicketTab = (typeof TICKET_TABS)[number]

export type Route =
  | { name: 'welcome' }
  | { name: 'projects' }
  | { name: 'new-project' }
  | { name: 'setup'; projectId: number; step: SetupStep }
  | { name: 'board'; projectId: number }
  | { name: 'ticket'; projectId: number; ticketId: number; tab: TicketTab }
  | { name: 'settings'; tab: string }
  | { name: 'costs'; projectId: number }
  | { name: 'forge'; projectId: number; chatId: number | null }
  | { name: 'crew'; view: 'list' | 'new' | 'catalogue' | 'edit'; id: number | null }

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const id = Number(parts[1])
  switch (parts[0]) {
    case 'projects':
      if (parts[1] === 'new') return { name: 'new-project' }
      if (Number.isInteger(id) && parts[2] === 'setup') {
        const step = SETUP_STEPS.includes(parts[3] as SetupStep) ? (parts[3] as SetupStep) : 'repos'
        return { name: 'setup', projectId: id, step }
      }
      if (Number.isInteger(id) && parts[2] === 'board') return { name: 'board', projectId: id }
      if (Number.isInteger(id) && parts[2] === 'costs') return { name: 'costs', projectId: id }
      if (Number.isInteger(id) && parts[2] === 'forge') return { name: 'forge', projectId: id, chatId: Number.isInteger(Number(parts[3])) && parts[3] ? Number(parts[3]) : null }
      if (Number.isInteger(id) && parts[2] === 'tickets' && Number.isInteger(Number(parts[3]))) {
        const tab = TICKET_TABS.includes(parts[4] as TicketTab) ? (parts[4] as TicketTab) : 'conversation'
        return { name: 'ticket', projectId: id, ticketId: Number(parts[3]), tab }
      }
      return { name: 'projects' }
    case 'settings':
      return { name: 'settings', tab: parts[1] ?? 'integrations' }
    case 'crew':
      if (parts[1] === 'new') return { name: 'crew', view: 'new', id: null }
      if (parts[1] === 'catalogue') return { name: 'crew', view: 'catalogue', id: null }
      if (Number.isInteger(id) && parts[1]) return { name: 'crew', view: 'edit', id }
      return { name: 'crew', view: 'list', id: null }
    case 'welcome':
      return { name: 'welcome' }
    default:
      return { name: 'projects' }
  }
}

export function href(route: Route): string {
  switch (route.name) {
    case 'welcome':
      return '#/welcome'
    case 'projects':
      return '#/projects'
    case 'new-project':
      return '#/projects/new'
    case 'setup':
      return `#/projects/${route.projectId}/setup/${route.step}`
    case 'board':
      return `#/projects/${route.projectId}/board`
    case 'ticket':
      return `#/projects/${route.projectId}/tickets/${route.ticketId}/${route.tab}`
    case 'settings':
      return `#/settings/${route.tab}`
    case 'costs':
      return `#/projects/${route.projectId}/costs`
    case 'forge':
      return `#/projects/${route.projectId}/forge${route.chatId ? `/${route.chatId}` : ''}`
    case 'crew':
      return route.view === 'edit' ? `#/crew/${route.id}` : route.view === 'list' ? '#/crew' : `#/crew/${route.view}`
  }
}

export function navigate(route: Route): void {
  window.location.hash = href(route)
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
