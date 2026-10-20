import type { ReactElement } from 'react'
import { href } from '../../router'
import { AgentsSettings } from './AgentsSettings'
import { IntegrationsSettings } from './IntegrationsSettings'

const TABS = [
  { id: 'integrations', label: 'Integrations' },
  { id: 'agents', label: 'Agents' }
] as const

/** Settings shared across projects. Skills, MCP servers, AI rules and Voice join these in phase 7. */
export function Settings({ tab }: { tab: string }): ReactElement {
  const current = TABS.find((item) => item.id === tab) ?? TABS[0]
  return (
    <main style={{ flex: 1, minWidth: 0, padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <h1 style={{ fontSize: 26 }}>Settings</h1>
      <div role="tablist" className="er-tabs" aria-label="Settings sections">
        {TABS.map((item) => (
          <a key={item.id} role="tab" aria-selected={item.id === current.id} className={`er-tab${item.id === current.id ? ' er-tab-selected' : ''}`} href={href({ name: 'settings', tab: item.id })}>
            {item.label}
          </a>
        ))}
      </div>
      {current.id === 'agents' && <AgentsSettings />}
      {current.id === 'integrations' && <IntegrationsSettings />}
    </main>
  )
}
