import { useEffect, useState } from 'react'

export const SETUP_STEPS = ['repos', 'variables', 'setup', 'services', 'pipeline', 'integrations', 'test'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

export const SETUP_STEP_LABELS: Record<SetupStep, string> = {
  repos: 'Repos',
  variables: 'Variables',
  setup: 'Setup',
  services: 'Services and teardown',
  pipeline: 'Pipeline',
  integrations: 'Linear and GitHub',
  test: 'Test run'
}

export type Route =
  | { name: 'welcome' }
  | { name: 'projects' }
  | { name: 'new-project' }
  | { name: 'setup'; projectId: number; step: SetupStep }
  | { name: 'board'; projectId: number }
  | { name: 'settings'; tab: string }

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
      return { name: 'projects' }
    case 'settings':
      return { name: 'settings', tab: parts[1] ?? 'agents' }
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
    case 'settings':
      return `#/settings/${route.tab}`
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
