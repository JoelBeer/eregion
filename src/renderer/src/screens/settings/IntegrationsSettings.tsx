import { useState, type ReactElement } from 'react'
import type { ImportAssignees, LinearStatus, LinearUser } from '@shared/integrations'
import { StatusPill } from '../../components/ui'
import { useAction, useQuery } from '../../hooks'

export function useLinearStatus(): { status: LinearStatus | undefined; reload: () => void } {
  const query = useQuery(() => window.eregion.getLinearStatus(), [], (event) => event.type === 'linear-changed')
  return { status: query.data, reload: query.reload }
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never'
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  return `${Math.round(seconds / 3600)} h ago`
}

function CopyRow({ text }: { text: string }): ReactElement {
  const [copied, setCopied] = useState(false)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <code className="mono" style={{ fontSize: 13, padding: '4px 8px', background: 'var(--surface-25, #F7F8FB)', borderRadius: 6 }}>
        {text}
      </code>
      <button
        type="button"
        className="er-btn er-btn-sm er-btn-ghost"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

function ConnectLinear({ status }: { status: LinearStatus }): ReactElement {
  const [clientId, setClientId] = useState(status.clientId ?? '')
  const [secret, setSecret] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const saveId = useAction(() => window.eregion.setLinearClientId(clientId))
  const signIn = useAction(async () => {
    if (clientId.trim() !== (status.clientId ?? '')) await window.eregion.setLinearClientId(clientId)
    await window.eregion.signInToLinear(secret || undefined)
    setSecret('')
  })
  const useKey = useAction(async () => {
    await window.eregion.useLinearApiKey(apiKey)
    setApiKey('')
  })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <span>Eregion signs in to Linear through your own private Linear app, so nothing about your workspace goes through anyone else's app.</span>
      <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <li>
          In Linear, open <strong>Settings › API › OAuth applications</strong> and create an application. Any name and developer will do. Leave it private.
        </li>
        <li>
          Add these as its callback URLs:
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
            {status.callbackUrls.map((url) => (
              <CopyRow key={url} text={url} />
            ))}
          </div>
        </li>
        <li>
          Paste the app's client ID here, then sign in. Linear opens in your browser; approve it there and come back.
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <input className="input mono" aria-label="Linear client ID" placeholder="Client ID" value={clientId} onChange={(event) => setClientId(event.target.value)} onBlur={() => clientId !== (status.clientId ?? '') && void saveId.run()} style={{ flex: '1 1 280px' }} />
            {signIn.pending ? (
              <button type="button" className="er-btn" onClick={() => void window.eregion.cancelLinearSignIn()}>
                Cancel
              </button>
            ) : (
              <button type="button" className="er-btn er-btn-primary" disabled={!clientId.trim()} onClick={() => void signIn.run()}>
                Sign in with Linear
              </button>
            )}
          </div>
          {signIn.pending && <span className="muted" style={{ display: 'block', marginTop: 6 }}>Waiting for you to approve Eregion in the browser…</span>}
        </li>
      </ol>
      {signIn.error && <span className="error-text">{signIn.error}</span>}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => setShowSecret(!showSecret)}>
          Linear asked for a client secret?
        </button>
        <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => setShowKey(!showKey)}>
          Use a personal API key instead
        </button>
      </div>
      {showSecret && (
        <div className="field">
          <label htmlFor="linear-secret">Client secret</label>
          <input id="linear-secret" className="input mono" type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} />
          <span className="muted" style={{ fontSize: 12 }}>
            Only needed if your app refuses sign-in without one. It's sent with the sign-in and kept encrypted with the token.
          </span>
        </div>
      )}
      {showKey && (
        <div className="field">
          <label htmlFor="linear-key">Personal API key</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input id="linear-key" className="input mono" type="password" autoComplete="off" placeholder="lin_api_…" value={apiKey} onChange={(event) => setApiKey(event.target.value)} style={{ flex: 1 }} />
            <button type="button" className="er-btn" disabled={!apiKey.trim() || useKey.pending} onClick={() => void useKey.run()}>
              Connect
            </button>
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            For workspaces that don't let you create apps. Make one in Linear › Settings › Security &amp; access › Personal API keys.
          </span>
          {useKey.error && <span className="error-text">{useKey.error}</span>}
        </div>
      )}
    </div>
  )
}

function ImportPeople({ status }: { status: LinearStatus }): ReactElement {
  const [users, setUsers] = useState<LinearUser[] | null>(null)
  const save = useAction((value: ImportAssignees) => window.eregion.setLinearImportAssignees(value))
  const load = useAction(async () => setUsers(await window.eregion.listLinearUsers()))
  const chosen = status.importAssignees.mode === 'people' ? status.importAssignees.people : []
  const toggle = (user: LinearUser, on: boolean): void => {
    const people = on ? [...chosen, { id: user.id, name: user.name }] : chosen.filter((person) => person.id !== user.id)
    void save.run(people.length ? { mode: 'people', people } : { mode: 'me' })
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="label">Import issues assigned to</span>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="radio" name="assignees" checked={status.importAssignees.mode === 'me'} onChange={() => void save.run({ mode: 'me' })} />
        Me{status.viewer ? ` (${status.viewer.name})` : ''}
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="radio" name="assignees" checked={status.importAssignees.mode === 'people'} onChange={() => void load.run()} />
        Specific people{chosen.length ? `: ${chosen.map((person) => person.name).join(', ')}` : ''}
      </label>
      {(users || status.importAssignees.mode === 'people') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 24, maxHeight: 220, overflowY: 'auto' }}>
          {!users && (
            <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => void load.run()} style={{ alignSelf: 'flex-start' }}>
              Choose people
            </button>
          )}
          {users?.map((user) => (
            <label key={user.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
              <input type="checkbox" checked={chosen.some((person) => person.id === user.id)} onChange={(event) => toggle(user, event.target.checked)} />
              {user.name} <span className="muted">{user.email}</span>
            </label>
          ))}
        </div>
      )}
      {(save.error || load.error) && <span className="error-text">{save.error ?? load.error}</span>}
    </div>
  )
}

export function IntegrationsSettings(): ReactElement {
  const { status } = useLinearStatus()
  const tools = useQuery(() => window.eregion.checkTools(), [])
  const sync = useAction(() => window.eregion.syncLinear())
  const signOut = useAction(async () => {
    if (window.confirm('Disconnect Linear? Tickets already imported stay; nothing new comes in until you connect again.')) await window.eregion.signOutOfLinear()
  })
  const gh = tools.data?.find((check) => check.tool === 'gh')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 820 }}>
      <section className="panel" aria-label="Linear">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ fontSize: 18 }}>Linear</h2>
          {status?.method && <StatusPill status="passed">Connected</StatusPill>}
        </div>
        {!status && <span className="muted">Loading…</span>}
        {status && !status.method && <ConnectLinear status={status} />}
        {status?.method && status.viewer && (
          <>
            <span>
              Signed in as <strong>{status.viewer.name}</strong> ({status.viewer.email}) in {status.viewer.organization}, {status.method === 'oauth' ? 'through your Linear app' : 'with a personal API key'}.
            </span>
            <ImportPeople status={status} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span className="muted" style={{ fontSize: 13 }}>
                Last synced {timeAgo(status.lastSyncAt)}. Eregion checks every minute while it's open, and when you come back to it.
              </span>
              <div style={{ flex: 1 }} />
              <button type="button" className="er-btn er-btn-sm" onClick={() => void sync.run()} disabled={sync.pending}>
                {sync.pending ? 'Syncing…' : 'Sync now'}
              </button>
              <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => void signOut.run()}>
                Disconnect
              </button>
            </div>
            {status.error && <span className="error-text">Last sync failed: {status.error}</span>}
          </>
        )}
      </section>

      <section className="panel" aria-label="GitHub">
        <h2 style={{ fontSize: 18 }}>GitHub</h2>
        <span>Eregion pushes branches and opens pull requests with the GitHub CLI, signed in as you, inside each repo's runtime. It stores no GitHub token.</span>
        {!gh && <span className="muted">Checking gh…</span>}
        {gh && !gh.found && <span className="error-text">gh isn't installed. Install the GitHub CLI, then run gh auth login.</span>}
        {gh?.found && (
          <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <StatusPill status={gh.detail?.startsWith('signed in') ? 'passed' : 'needsYou'}>{gh.detail?.startsWith('signed in') ? 'Signed in' : 'Not signed in'}</StatusPill>
            <span className="muted">
              gh {gh.version} {gh.detail ? `· ${gh.detail}` : ''}
            </span>
          </span>
        )}
        {gh?.found && !gh.detail?.startsWith('signed in') && (
          <span>
            Run <code className="mono">gh auth login</code> in a terminal{gh.runtime !== 'Windows' ? ` (${gh.runtime})` : ''}, then come back.
          </span>
        )}
      </section>
    </div>
  )
}
