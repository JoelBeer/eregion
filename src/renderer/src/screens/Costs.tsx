import { useState, type ReactElement } from 'react'
import { COST_PERIODS, type CostPeriod, type TicketCost } from '@shared/costs'
import { CrewAvatar } from '../components/RobotAvatar'
import { useQuery } from '../hooks'
import { href } from '../router'
import { useCrew } from './Board'

const money = (usd: number): string => (usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`)
const tokens = (count: number): string => (count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1000 ? `${Math.round(count / 1000)}k` : String(count))

function Total({ label, value, note }: { label: string; value: string; note?: string }): ReactElement {
  return (
    <div className="panel" style={{ flex: '1 1 160px', gap: 4 }}>
      <span className="muted" style={{ fontSize: 13 }}>
        {label}
      </span>
      <span style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 600 }}>{value}</span>
      {note && (
        <span className="muted" style={{ fontSize: 12 }}>
          {note}
        </span>
      )}
    </div>
  )
}

function Runs({ projectId, ticket }: { projectId: number; ticket: TicketCost }): ReactElement {
  const crew = useCrew()
  return (
    <section className="panel" aria-label={`${ticket.key} runs`}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h2 style={{ fontSize: 17 }}>
          {ticket.key} · {ticket.title}
        </h2>
        <div style={{ flex: 1 }} />
        <a href={href({ name: 'ticket', projectId, ticketId: ticket.ticketId, tab: 'log' })} style={{ fontSize: 13, fontWeight: 600 }}>
          Open ticket
        </a>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--ink-600)' }}>
            <th>Stage</th>
            <th>Crew</th>
            <th>Model</th>
            <th>Started</th>
            <th>Result</th>
            <th style={{ textAlign: 'right' }}>Tokens</th>
            <th style={{ textAlign: 'right' }}>Cost</th>
          </tr>
        </thead>
        <tbody>
          {ticket.runs.map((run) => {
            const member = crew.find((item) => item.id === run.crewId)
            return (
              <tr key={run.id} style={{ borderTop: '1px solid var(--divider-100)' }}>
                <td style={{ padding: '6px 4px' }}>
                  {run.stage}
                  {run.loop > 1 ? ` · pass ${run.loop}` : ''}
                </td>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {member && <CrewAvatar member={member} size={18} />}
                    {member?.name ?? 'Visitor'}
                  </span>
                </td>
                <td className="mono">{run.model}</td>
                <td>{new Date(`${run.startedAt.replace(' ', 'T')}Z`).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</td>
                <td>{run.result}</td>
                <td className="mono" style={{ textAlign: 'right' }}>
                  {run.tokens > 0 ? tokens(run.tokens) : '—'}
                </td>
                <td className="mono" style={{ textAlign: 'right' }}>
                  {run.costUsd !== null ? money(run.costUsd) : run.adapter === 'cursor' ? 'Cursor plan' : 'not reported'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

/** What tickets cost in tokens and money, from what each run reported. */
export function Costs({ projectId }: { projectId: number }): ReactElement {
  const [period, setPeriod] = useState<CostPeriod>('30d')
  const [selected, setSelected] = useState<number | null>(null)
  const report = useQuery(() => window.eregion.getCosts(projectId, period), [projectId, period], (event) => event.type === 'run-state' || (event.type === 'ticket-changed' && event.projectId === projectId))
  const data = report.data
  const top = Math.max(...(data?.tickets.map((ticket) => ticket.costUsd) ?? [0]), 0.000001)
  const ticket = data?.tickets.find((item) => item.ticketId === selected) ?? data?.tickets[0]

  return (
    <main style={{ flex: 1, minWidth: 0, padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 26 }}>Costs</h1>
        <div style={{ flex: 1 }} />
        <div role="group" aria-label="Period" style={{ display: 'flex', gap: 6 }}>
          {COST_PERIODS.map((item) => (
            <button key={item.id} type="button" className={`er-btn er-btn-sm${item.id === period ? ' er-btn-primary' : ''}`} aria-pressed={item.id === period} onClick={() => setPeriod(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
      </header>
      {report.error && <span className="error-text">{report.error}</span>}
      {!data && !report.error && <span className="muted">Loading…</span>}
      {data && (
        <>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Total label="Spend" value={money(data.totals.costUsd)} note="As Claude Code reports it" />
            <Total label="Tokens" value={tokens(data.totals.tokens)} note={`${data.totals.runs} ${data.totals.runs === 1 ? 'run' : 'runs'}`} />
            <Total label="Tickets" value={String(data.totals.tickets)} />
            <Total label="Forge chats" value={String(data.forge.chats)} note={data.forge.chats > 0 ? money(data.forge.costUsd) : undefined} />
          </div>
          {data.tickets.length === 0 ? (
            <span className="muted">No runs in this period.</span>
          ) : (
            <section className="panel" aria-label="Tickets">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--ink-600)', fontSize: 13 }}>
                    <th>Ticket</th>
                    <th>Runs</th>
                    <th style={{ textAlign: 'right' }}>Tokens</th>
                    <th style={{ textAlign: 'right' }}>Cost</th>
                    <th style={{ width: '30%' }}>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tickets.map((item) => (
                    <tr
                      key={item.ticketId}
                      onClick={() => setSelected(item.ticketId)}
                      aria-selected={item.ticketId === ticket?.ticketId}
                      style={{ borderTop: '1px solid var(--divider-100)', cursor: 'pointer', background: item.ticketId === ticket?.ticketId ? 'var(--aqua-50)' : undefined }}
                    >
                      <td style={{ padding: '8px 4px' }}>
                        <span className="mono muted">{item.key}</span> {item.title}
                      </td>
                      <td>{item.runs.length}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {tokens(item.tokens)}
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {money(item.costUsd)}
                      </td>
                      <td style={{ paddingLeft: 12 }}>
                        <div style={{ height: 8, borderRadius: 4, background: 'var(--divider-100)' }}>
                          <div style={{ width: `${(item.costUsd / top) * 100}%`, height: 8, borderRadius: 4, background: 'var(--primary-600)' }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {ticket && <Runs projectId={projectId} ticket={ticket} />}
        </>
      )}
    </main>
  )
}
