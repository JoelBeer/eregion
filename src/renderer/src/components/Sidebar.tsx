import { useEffect, useState, type ReactElement } from 'react'
import { formatTokens, formatUsd, type UsageTotals } from '@shared/costs'
import type { ProjectSummary } from '@shared/model'
import { useQuery } from '../hooks'
import { href, type Route } from '../router'
import { Logo, NavIcon, type IconName } from './icons'
import { hasTitleBar } from './TitleBar'
import { ProjectBadge } from './ui'

export type NavId = 'board' | 'crew' | 'forge' | 'pipeline' | 'costs' | 'projects' | 'settings'

interface NavItem {
  id: NavId
  label: string
  icon: IconName
  route: (projectId: number | null) => Route | null
}

const NAV: NavItem[] = [
  { id: 'board', label: 'Board', icon: 'board', route: (id) => (id ? { name: 'board', projectId: id } : null) },
  { id: 'crew', label: 'Crew', icon: 'crew', route: () => ({ name: 'crew', view: 'list', id: null }) },
  { id: 'forge', label: 'Forge', icon: 'forge', route: (id) => (id ? { name: 'forge', projectId: id, chatId: null } : null) },
  { id: 'pipeline', label: 'Pipeline', icon: 'pipeline', route: (id) => (id ? { name: 'setup', projectId: id, step: 'pipeline' } : null) },
  { id: 'costs', label: 'Costs', icon: 'costs', route: (id) => (id ? { name: 'costs', projectId: id } : null) },
  { id: 'projects', label: 'Projects', icon: 'projects', route: () => ({ name: 'projects' }) }
]

const SETTINGS: NavItem = { id: 'settings', label: 'Settings', icon: 'settings', route: () => ({ name: 'settings', tab: 'integrations' }) }

/** Today's and this month's spend and tokens for the project; opens Costs. */
function Usage({ projectId }: { projectId: number }): ReactElement | null {
  const usage = useQuery(() => window.eregion.getUsage(projectId), [projectId], (event) => event.type === 'run-state')
  if (!usage.data) return null
  const line = (label: string, totals: UsageTotals): ReactElement => (
    <span className="er-usage-line">
      <span>{label}</span>
      <span>
        {formatUsd(totals.costUsd)} · {formatTokens(totals.tokens)}
      </span>
    </span>
  )
  return (
    <a className="er-live er-usage" href={href({ name: 'costs', projectId })} title="Spend and tokens. Open Costs for the detail.">
      <span className="er-usage-line er-usage-head">
        <strong>Usage</strong>
        <span>spend · tokens</span>
      </span>
      {line('Today', usage.data.today)}
      {line('This month', usage.data.month)}
    </a>
  )
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem('eregion.sidebarCollapsed') === '1'
  } catch {
    return false
  }
}

export function Sidebar({ projects, currentProjectId, active }: { projects: ProjectSummary[]; currentProjectId: number | null; active: NavId | null }): ReactElement {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const current = projects.find((project) => project.id === currentProjectId) ?? null

  useEffect(() => {
    try {
      localStorage.setItem('eregion.sidebarCollapsed', collapsed ? '1' : '0')
    } catch {
      /* Storage can be unavailable; the sidebar just won't remember. */
    }
  }, [collapsed])

  const label = (text: string): ReactElement | null => (collapsed ? null : <span>{text}</span>)

  const link = (item: NavItem, style?: React.CSSProperties): ReactElement | null => {
    const route = item.route(currentProjectId)
    if (!route) return null
    return (
      <a
        key={item.id}
        href={href(route)}
        style={style}
        aria-current={active === item.id ? 'page' : undefined}
        title={collapsed ? item.label : undefined}
        aria-label={collapsed ? item.label : undefined}
      >
        <NavIcon name={item.icon} />
        {label(item.label)}
      </a>
    )
  }

  return (
    <nav aria-label="Main" className="er-sidebar" style={{ flex: collapsed ? '0 0 72px' : '0 0 240px', width: collapsed ? 72 : 240, height: '100%', overflowY: 'auto' }}>
      {/* With the app's own title bar, the name sits there instead. */}
      {!hasTitleBar() && (
        <div className="er-brand">
          <Logo />
          {label('Eregion')}
        </div>
      )}

      {current && (
        <button
          type="button"
          className="er-switcher"
          aria-expanded={switcherOpen}
          aria-label={`Switch project. Current project: ${current.name}`}
          onClick={() => setSwitcherOpen(!switcherOpen)}
        >
          <ProjectBadge initials={current.initials} color={current.color} />
          {!collapsed && <span style={{ flex: 1 }}>{current.name}</span>}
          {!collapsed && <NavIcon name="updown" size={16} />}
        </button>
      )}

      {switcherOpen && (
        <div role="menu" aria-label="Projects" className="er-menu">
          {projects.map((project) => (
            <a key={project.id} role="menuitem" href={href({ name: 'board', projectId: project.id })} onClick={() => setSwitcherOpen(false)}>
              <ProjectBadge initials={project.initials} color={project.color} />
              {!collapsed && (
                <span style={{ flex: 1, color: project.id === currentProjectId ? '#FFFFFF' : undefined, fontWeight: project.id === currentProjectId ? 600 : 400 }}>{project.name}</span>
              )}
              {!collapsed && project.id === currentProjectId && <span style={{ color: 'var(--aqua-400)' }}>✓</span>}
            </a>
          ))}
          <hr />
          <a role="menuitem" href={href({ name: 'projects' })} onClick={() => setSwitcherOpen(false)}>
            <NavIcon name="projects" />
            {label('All projects')}
          </a>
          <a role="menuitem" href={href({ name: 'new-project' })} onClick={() => setSwitcherOpen(false)}>
            <NavIcon name="plus" />
            {label('New project')}
          </a>
        </div>
      )}

      {NAV.map((item) => link(item))}

      {current && !collapsed && current.setupStep >= 8 && (
        <div className="er-live">
          <strong>Live environments</strong>
          <div className="er-live-bar">
            <span style={{ width: `${Math.round((current.slotsInUse / current.liveSlots) * 100)}%` }} />
          </div>
          <span>
            {current.slotsInUse} of {current.liveSlots} slots in use
          </span>
        </div>
      )}
      {current && !collapsed && current.setupStep >= 8 && <Usage projectId={current.id} />}

      {link(SETTINGS, { marginTop: current && !collapsed && current.setupStep >= 8 ? 8 : 'auto' })}
      <button
        type="button"
        className="er-navbtn er-collapse"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        style={{ marginTop: 4 }}
        onClick={() => setCollapsed(!collapsed)}
      >
        <NavIcon name={collapsed ? 'expand' : 'collapse'} />
        {label('Collapse')}
      </button>
    </nav>
  )
}
