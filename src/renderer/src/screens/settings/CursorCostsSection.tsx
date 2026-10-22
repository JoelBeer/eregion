import { useState, type FormEvent, type ReactElement } from 'react'
import { StatusPill } from '../../components/ui'
import { useAction, useQuery } from '../../hooks'
import { timeAgo } from './IntegrationsSettings'

/**
 * Cursor's CLI reports tokens but no cost. With a team Admin API key, Eregion fills in what Cursor charged for
 * each Cursor run, checking hourly; a run's cost is final two hours after it ends.
 */
export function CursorCostsSection(): ReactElement {
  const status = useQuery(() => window.eregion.getCursorCosts(), [])
  const [key, setKey] = useState('')
  const save = useAction(async (value: string) => {
    await window.eregion.saveCursorAdminKey(value)
    setKey('')
    await status.reload()
  })
  const remove = useAction(async () => {
    await window.eregion.removeCursorAdminKey()
    await status.reload()
  })
  const sync = useAction(async () => {
    await window.eregion.syncCursorCosts()
    await status.reload()
  })
  const current = status.data
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void save.run(key)
  }

  return (
    <section className="panel" aria-label="Cursor costs">
      <h2 style={{ fontSize: 18 }}>Cursor costs</h2>
      <span>
        The Cursor CLI reports tokens but not what a run cost. With an Admin API key for your Cursor team (Team and Enterprise plans), Eregion fills in what Cursor charged for each Cursor run. It checks once an hour, and a run's cost is
        final two hours after it ends.
      </span>
      {current?.configured ? (
        <>
          <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <StatusPill status={current.lastError ? 'failed' : 'passed'}>{current.lastError ? 'Not working' : 'Connected'}</StatusPill>
            <span className="muted">
              {current.email ? `Counting ${current.email}'s CLI usage` : "Counting the team's CLI usage: sign the Cursor CLI in to count only yours"}
              {` · last checked ${current.lastSyncAt ? timeAgo(current.lastSyncAt) : 'not yet'}`}
              {current.pending > 0 ? ` · ${current.pending} ${current.pending === 1 ? 'run' : 'runs'} pending` : ''}
            </span>
          </span>
          {current.lastError && <span className="error-text">{current.lastError}</span>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="er-btn er-btn-sm" disabled={sync.pending} onClick={() => void sync.run()}>
              {sync.pending ? 'Checking…' : 'Check now'}
            </button>
            <button type="button" className="er-btn er-btn-sm" disabled={remove.pending} onClick={() => void remove.run()}>
              Remove the key
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: '10px 12px', alignItems: 'center' }}>
            <label htmlFor="cursor-admin-key">Admin API key</label>
            <input id="cursor-admin-key" className="input mono" type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} />
            <span />
            <span className="muted" style={{ fontSize: 13 }}>
              A team admin creates one in Cursor's team dashboard. It's stored encrypted on this computer and never shown again.
            </span>
          </div>
          {save.error && <span className="error-text">{save.error}</span>}
          <div>
            <button type="submit" className="er-btn er-btn-primary" disabled={!key.trim() || save.pending}>
              {save.pending ? 'Checking…' : 'Save and test'}
            </button>
          </div>
        </form>
      )}
      {(sync.error || remove.error || status.error) && <span className="error-text">{sync.error ?? remove.error ?? status.error}</span>}
    </section>
  )
}
