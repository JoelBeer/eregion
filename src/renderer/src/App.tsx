import { useEffect, useState, type ReactElement } from 'react'
import { Sidebar, type NavId } from './components/Sidebar'
import { useQuery } from './hooks'
import { navigate, useRoute, type Route } from './router'
import { NewProject } from './screens/NewProject'
import { Projects } from './screens/Projects'
import { Board } from './screens/Board'
import { ProjectSetup } from './screens/setup/ProjectSetup'
import { TicketScreen } from './screens/ticket/TicketScreen'
import { Welcome } from './screens/Welcome'

const CURRENT_PROJECT_KEY = 'eregion.currentProject'

function readCurrentProject(): number | null {
  try {
    const value = Number(localStorage.getItem(CURRENT_PROJECT_KEY))
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function projectIdOf(route: Route): number | null {
  return route.name === 'setup' || route.name === 'board' || route.name === 'ticket' ? route.projectId : null
}

function activeNav(route: Route): NavId | null {
  switch (route.name) {
    case 'board':
    case 'ticket':
      return 'board'
    case 'setup':
      return route.step === 'pipeline' ? 'pipeline' : 'projects'
    case 'projects':
    case 'new-project':
      return 'projects'
    case 'settings':
      return 'settings'
    default:
      return null
  }
}

export function App(): ReactElement {
  const route = useRoute()
  const projects = useQuery(() => window.eregion.listProjects(), [], (event) => event.type === 'projects-changed')
  const [currentProjectId, setCurrentProjectId] = useState<number | null>(readCurrentProject)

  useEffect(() => {
    const id = projectIdOf(route)
    if (id && id !== currentProjectId) {
      setCurrentProjectId(id)
      try {
        localStorage.setItem(CURRENT_PROJECT_KEY, String(id))
      } catch {
        /* Not remembering the current project is fine. */
      }
    }
  }, [route, currentProjectId])

  if (!projects.data) {
    return projects.error ? <main className="error-text" style={{ padding: 28 }}>{projects.error}</main> : <main />
  }

  const list = projects.data
  if (list.length === 0 && route.name !== 'new-project') {
    return <Welcome onSetUpProject={() => navigate({ name: 'new-project' })} />
  }

  const current = list.some((project) => project.id === currentProjectId) ? currentProjectId : (list[0]?.id ?? null)

  let screen: ReactElement
  switch (route.name) {
    case 'setup':
      screen = <ProjectSetup projectId={route.projectId} step={route.step} />
      break
    case 'board': {
      const project = list.find((item) => item.id === route.projectId)
      screen =
        project && project.setupStep < 8 ? (
          <ProjectSetup projectId={route.projectId} step="repos" />
        ) : (
          <Board projectId={route.projectId} />
        )
      break
    }
    case 'ticket':
      screen = <TicketScreen key={route.ticketId} projectId={route.projectId} ticketId={route.ticketId} tab={route.tab} />
      break
    case 'new-project':
      screen = <NewProject />
      break
    case 'welcome':
      return <Welcome onSetUpProject={() => navigate({ name: 'new-project' })} />
    default:
      screen = <Projects projects={list} currentProjectId={current} />
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar projects={list} currentProjectId={current} active={activeNav(route)} />
      {screen}
    </div>
  )
}
