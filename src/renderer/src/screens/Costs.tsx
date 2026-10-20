import { Fragment, useEffect, useRef, useState, type ReactElement } from 'react'
import { COST_PAGE, COST_PERIODS, formatTokens, formatUsd, type CostPeriod, type TicketCost } from '@shared/costs'
import { CrewAvatar } from '../components/RobotAvatar'
import { useQuery } from '../hooks'
import { href } from '../router'
import { useCrew } from './Board'


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
                  {run.tokens > 0 ? formatTokens(run.tokens) : '—'}
                </td>
                <td className="mono" style={{ textAlign: 'right' }}>
                  {run.costUsd !== null ? formatUsd(run.costUsd) : run.adapter === 'cursor' ? 'Cursor plan' : 'not reported'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

/** Asks for the next page when it scrolls into view. */
function LoadMore({ onVisible, pending }: { onVisible: () => void; pending: boolean }): ReactElement {
  const marker = useRef<HTMLDivElement>(null)
  const latest = useRef(onVisible)
  latest.current = onVisible
  useEffect(() => {
    if (pending || !marker.current) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) latest.current()
    })
    observer.observe(marker.current)
    return () => observer.disconnect()
  }, [pending])
  return (
    <div ref={marker} className="muted" style={{ fontSize: 13, textAlign: 'center', padding: 8 }}>
      {pending ? 'Loading more tickets…' : ' '}
    </div>
  )
}

/** What tickets cost in tokens and money, from what each run reported. */
export function Costs({ projectId }: { projectId: number }): ReactElement {
  const [period, setPeriodOnly] = useState<CostPeriod>('30d')
  const [selected, setSelected] = useState<number | null>(null)
  const [search, setSearchOnly] = useState('')
  const [limit, setLimit] = useState(COST_PAGE)
  const setPeriod = (next: CostPeriod): void => {
    setPeriodOnly(next)
    setLimit(COST_PAGE)
  }
  const setSearch = (next: string): void => {
    setSearchOnly(next)
    setLimit(COST_PAGE)
  }
  const report = useQuery(
    () => window.eregion.getCosts(projectId, period, { search, limit }),
    [projectId, period, search, limit],
    (event) => event.type === 'run-state' || (event.type === 'ticket-changed' && event.projectId === projectId)
  )
  const data = report.data
  const top = Math.max(...(data?.tickets.map((ticket) => ticket.costUsd) ?? [0]), 0.000001)

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
            <Total label="Spend" value={formatUsd(data.totals.costUsd)} note="As Claude Code reports it" />
            <Total label="Tokens" value={formatTokens(data.totals.tokens)} note={`${data.totals.runs} ${data.totals.runs === 1 ? 'run' : 'runs'}`} />
            <Total label="Tickets" value={String(data.totals.tickets)} />
            <Total label="Forge chats" value={String(data.forge.chats)} note={data.forge.chats > 0 ? formatUsd(data.forge.costUsd) : undefined} />
          </div>
          {data.totals.tickets === 0 ? (
            <span className="muted">No runs in this period.</span>
          ) : (
            <section className="panel" aria-label="Tickets">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span className="muted" style={{ fontSize: 13 }}>
                  {search.trim() ? `${data.matching} of ${data.totals.tickets} tickets match` : `${data.totals.tickets} ${data.totals.tickets === 1 ? 'ticket' : 'tickets'}, most expensive first`}
                </span>
                <div style={{ flex: 1 }} />
                <input type="search" className="input" aria-label="Search tickets" placeholder="Search by key or title" value={search} onChange={(event) => setSearch(event.target.value)} style={{ width: 240, padding: '6px 10px' }} />
              </div>
              {data.tickets.length === 0 && <span className="muted">No tickets match “{search.trim()}”.</span>}
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
                    <Fragment key={item.ticketId}>
                      <tr
                        onClick={() => setSelected(item.ticketId === selected ? null : item.ticketId)}
                        aria-expanded={item.ticketId === selected}
                        title={item.ticketId === selected ? 'Hide its runs' : 'Show its runs'}
                        style={{ borderTop: '1px solid var(--divider-100)', cursor: 'pointer', background: item.ticketId === selected ? 'var(--aqua-50)' : undefined }}
                      >
                        <td style={{ padding: '8px 4px' }}>
                          <span className="mono muted">{item.key}</span> {item.title}
                        </td>
                        <td>{item.runs.length}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>
                          {formatTokens(item.tokens)}
                        </td>
                        <td className="mono" style={{ textAlign: 'right' }}>
                          {formatUsd(item.costUsd)}
                        </td>
                        <td style={{ paddingLeft: 12 }}>
                          <div style={{ height: 8, borderRadius: 4, background: 'var(--divider-100)' }}>
                            <div style={{ width: `${(item.costUsd / top) * 100}%`, height: 8, borderRadius: 4, background: 'var(--primary-600)' }} />
                          </div>
                        </td>
                      </tr>
                      {item.ticketId === selected && (
                        <tr>
                          <td colSpan={5} style={{ padding: '4px 0 12px' }}>
                            <Runs projectId={projectId} ticket={item} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              {data.tickets.length < data.matching && <LoadMore pending={report.loading} onVisible={() => setLimit(data.tickets.length + COST_PAGE)} />}
            </section>
          )}
        </>
      )}
    </main>
  )
}
