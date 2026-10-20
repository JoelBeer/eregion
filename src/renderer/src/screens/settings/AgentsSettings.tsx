import { useState, type ReactElement } from 'react'
import type { AgentInfo } from '@shared/agents'
import { StatusPill } from '../../components/ui'
import { useAction, useQuery } from '../../hooks'
import { timeAgo } from './IntegrationsSettings'

function AgentCard({ agent, reload }: { agent: AgentInfo; reload: () => void }): ReactElement {
  const [model, setModel] = useState('')
  const test = useAction(async () => {
    await window.eregion.testAgent(agent.id)
    reload()
  })
  const add = useAction(async () => {
    await window.eregion.addModel(agent.id, model)
    setModel('')
    reload()
  })
  const remove = useAction(async (id: string) => {
    await window.eregion.removeModel(agent.id, id)
    reload()
  })
  const installed = agent.checks.filter((check) => check.found)
  return (
    <section className="panel" aria-label={agent.name}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 18 }}>{agent.name}</h2>
        <code className="mono muted">{agent.command}</code>
        <StatusPill status={installed.length > 0 ? 'passed' : 'neutral'}>{installed.length > 0 ? 'Installed' : 'Not installed'}</StatusPill>
        <div style={{ flex: 1 }} />
        <button type="button" className="er-btn er-btn-sm" disabled={test.pending || installed.length === 0} onClick={() => void test.run()}>
          {test.pending ? 'Waiting for a reply…' : 'Run a test prompt'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr)', gap: '8px 12px', fontSize: 14 }}>
        <span className="muted">Found</span>
        <span>{agent.checks.map((check) => `${check.runtime}: ${check.found ? (check.version ?? 'installed') : 'not installed'}`).join(' · ') || 'Checking…'}</span>
        <span className="muted">Projects run it in</span>
        <span>{agent.projects.map((project) => `${project.name}: ${project.runtime}`).join(' · ') || 'No projects yet'}</span>
        <span className="muted">Last test</span>
        <span>
          {agent.tests.length === 0
            ? 'Not tested yet. The test sends one tiny prompt with the cheapest model.'
            : agent.tests.map((result) => (
                <span key={result.runtime} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <StatusPill status={result.ok ? 'passed' : 'failed'}>{result.ok ? 'Replied' : 'Failed'}</StatusPill>
                  <span>
                    {result.runtime} · {(result.ms / 1000).toFixed(1)} s · {result.signedIn ? 'signed in' : 'not signed in'} · {result.usageReported ? 'usage reported' : 'no usage reported'}
                    {result.costUsd !== null ? ` · $${result.costUsd.toFixed(4)}` : ''} · {timeAgo(result.at)}
                  </span>
                  {!result.ok && <span className="error-text">{result.detail}</span>}
                </span>
              ))}
        </span>
        <span className="muted">Models</span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {agent.models.map((item) => (
              <span key={item.id} className="er-chip er-chip-mono" title={item.id}>
                {item.label}
                {item.custom && (
                  <button type="button" aria-label={`Remove ${item.id}`} onClick={() => void remove.run(item.id)} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, marginLeft: 2 }}>
                    ×
                  </button>
                )}
              </span>
            ))}
          </span>
          <form
            style={{ display: 'flex', gap: 6 }}
            onSubmit={(event) => {
              event.preventDefault()
              if (model.trim()) void add.run()
            }}
          >
            <input className="input mono" aria-label={`Add a ${agent.name} model`} placeholder="Add a model by name" value={model} onChange={(event) => setModel(event.target.value)} style={{ width: 240, padding: '4px 8px' }} />
            <button type="submit" className="er-btn er-btn-sm" disabled={!model.trim() || add.pending}>
              Add
            </button>
          </form>
        </span>
      </div>
      <span className="muted" style={{ fontSize: 13 }}>
        {agent.note}
      </span>
      {(test.error || add.error || remove.error) && <span className="error-text">{test.error ?? add.error ?? remove.error}</span>}
    </section>
  )
}

/** The agent CLIs Eregion runs. It never installs, updates or signs in to them. */
export function AgentsSettings(): ReactElement {
  const agents = useQuery(() => window.eregion.listAgents(), [])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 900 }}>
      <span className="muted">Eregion runs these command-line agents. It never installs, updates or signs in to them: do that in a terminal in the runtime shown.</span>
      {agents.error && <span className="error-text">{agents.error}</span>}
      {!agents.data && !agents.error && <span className="muted">Checking the agents on this machine…</span>}
      {agents.data?.map((agent) => (
        <AgentCard key={agent.id} agent={agent} reload={() => void agents.reload()} />
      ))}
    </div>
  )
}
