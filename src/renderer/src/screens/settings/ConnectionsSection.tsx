import { useState, type FormEvent, type ReactElement, type ReactNode } from 'react'
import { connectionProblems, type Connection, type ConnectionInput } from '@shared/sources'
import { StatusPill } from '../../components/ui'
import { useAction, useQuery } from '../../hooks'
import { timeAgo } from './IntegrationsSettings'

const KIND_NAMES: Record<Connection['kind'], string> = { jira: 'Jira', gitlab: 'GitLab', linear: 'API key' }

const TOKEN_HELP: Record<Connection['kind'], string> = {
  jira: 'An API token from id.atlassian.com › Security › API tokens. Jira signs in with it and your email.',
  gitlab: 'A personal access token from GitLab › Preferences › Access tokens, with the api scope (issues, merge requests and pipelines).',
  linear: "A personal API key from Linear › Settings › Security & access › Personal API keys, made by the person whose issues you want, in that person's workspace. Add one for each account."
}

function ConnectionForm({ editing, kinds, onDone }: { editing: Connection | null; kinds: Connection['kind'][]; onDone: () => void }): ReactElement {
  const [kind, setKind] = useState<Connection['kind']>(editing?.kind ?? kinds[0])
  const [name, setName] = useState(editing?.name ?? '')
  const [url, setUrl] = useState(editing?.url ?? '')
  const [email, setEmail] = useState(editing?.email ?? '')
  const [token, setToken] = useState('')
  const input: ConnectionInput = { id: editing?.id, kind, name, url, email, token }
  const problems = name || url || token ? connectionProblems(input, Boolean(editing)) : []
  const save = useAction(async () => {
    await window.eregion.saveConnection(input)
    onDone()
  })
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void save.run()
  }
  return (
    <form className="panel" aria-label={editing ? `Edit ${editing.name}` : kind === 'linear' ? 'Add an API key' : 'Add a connection'} onSubmit={submit} style={{ boxShadow: 'none' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: '10px 12px', alignItems: 'center' }}>
        {kinds.length > 1 && (
          <>
            <label htmlFor="connection-kind">Service</label>
            <select id="connection-kind" className="select" value={kind} disabled={Boolean(editing)} onChange={(event) => setKind(event.target.value as Connection['kind'])}>
              {kinds.includes('jira') && <option value="jira">Jira Cloud</option>}
              {kinds.includes('gitlab') && <option value="gitlab">GitLab</option>}
              {kinds.includes('linear') && <option value="linear">Linear</option>}
            </select>
          </>
        )}
        <label htmlFor="connection-name">Name</label>
        <input id="connection-name" className="input" placeholder={kind === 'jira' ? 'Work Jira' : kind === 'linear' ? 'Work' : 'GitLab'} value={name} onChange={(event) => setName(event.target.value)} />
        {kind !== 'linear' && (
          <>
            <label htmlFor="connection-url">Address</label>
            <input id="connection-url" className="input mono" placeholder={kind === 'jira' ? 'https://your-site.atlassian.net' : 'https://gitlab.com'} value={url} onChange={(event) => setUrl(event.target.value)} />
          </>
        )}
        {kind === 'jira' && (
          <>
            <label htmlFor="connection-email">Email</label>
            <input id="connection-email" className="input" type="email" placeholder="The email you sign in to Jira with" value={email} onChange={(event) => setEmail(event.target.value)} />
          </>
        )}
        <label htmlFor="connection-token">{kind === 'linear' ? 'API key' : 'Token'}</label>
        <input id="connection-token" className="input mono" type="password" autoComplete="off" placeholder={editing ? 'Leave empty to keep the saved one' : ''} value={token} onChange={(event) => setToken(event.target.value)} />
        <span />
        <span className="muted" style={{ fontSize: 13 }}>
          {TOKEN_HELP[kind]} It's stored encrypted on this computer and never shown again.
        </span>
      </div>
      {problems.length > 0 && <span className="error-text">{problems.join('. ')}.</span>}
      {save.error && <span className="error-text">{save.error}</span>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="er-btn er-btn-primary" disabled={problems.length > 0 || !name || (kind !== 'linear' && !url) || save.pending}>
          {save.pending ? 'Checking…' : editing ? 'Save and test' : 'Add and test'}
        </button>
        <button type="button" className="er-btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** Saved accounts of the given kinds, with Test, Edit and Remove, and a button (beside any `actions`) to add one. */
export function ConnectionList({ kinds, addLabel, actions }: { kinds: Connection['kind'][]; addLabel: string; actions?: ReactNode }): ReactElement {
  const all = useQuery(() => window.eregion.listConnections(), [], (event) => event.type === 'linear-changed')
  const connections = { ...all, data: all.data?.filter((connection) => kinds.includes(connection.kind)) }
  const [editing, setEditing] = useState<Connection | 'new' | null>(null)
  const test = useAction(async (id: string) => {
    await window.eregion.testConnection(id)
    await connections.reload()
  })
  const remove = useAction(async (connection: Connection) => {
    if (!window.confirm(`Remove ${connection.name}? Projects using it stop syncing until you pick another.`)) return
    await window.eregion.removeConnection(connection.id)
    await connections.reload()
  })
  const done = (): void => {
    setEditing(null)
    void connections.reload()
  }
  return (
    <>
      {connections.data?.map((connection) => (
        <div key={connection.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', borderTop: '1px solid var(--divider-100)', paddingTop: 10 }}>
          <strong>{connection.name}</strong>
          <span className="muted">{KIND_NAMES[connection.kind]}</span>
          <span className="mono muted" style={{ fontSize: 13 }}>
            {connection.url}
          </span>
          {connection.error ? <StatusPill status="failed">Can't sign in</StatusPill> : connection.account ? <StatusPill status="passed">{connection.account}</StatusPill> : <StatusPill status="neutral">Not tested</StatusPill>}
          {connection.testedAt && <span className="muted" style={{ fontSize: 12 }}>tested {timeAgo(connection.testedAt)}</span>}
          <div style={{ flex: 1 }} />
          <button type="button" className="er-btn er-btn-sm er-btn-ghost" disabled={test.pending} onClick={() => void test.run(connection.id)}>
            Test
          </button>
          <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => setEditing(connection)} disabled={editing !== null}>
            Edit
          </button>
          <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => void remove.run(connection)}>
            Remove
          </button>
          {connection.error && (
            <span className="error-text" style={{ flexBasis: '100%' }}>
              {connection.error}
            </span>
          )}
        </div>
      ))}
      {(test.error || remove.error || connections.error) && <span className="error-text">{test.error ?? remove.error ?? connections.error}</span>}
      {editing && <ConnectionForm editing={editing === 'new' ? null : editing} kinds={kinds} onDone={done} />}
      {!editing && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {actions}
          <button type="button" className="er-btn er-btn-sm" onClick={() => setEditing('new')}>
            {addLabel}
          </button>
        </div>
      )}
    </>
  )
}

/** Jira and GitLab accounts that projects can take tickets from (and, for GitLab, open merge requests in). */
export function ConnectionsSection(): ReactElement {
  return (
    <section className="panel" aria-label="Jira and GitLab">
      <h2 style={{ fontSize: 18 }}>Jira and GitLab</h2>
      <span className="muted" style={{ fontSize: 13 }}>
        Accounts projects can take tickets from. A GitLab connection also opens merge requests and watches pipelines for repos whose remote is on it. Several of each are fine.
      </span>
      <ConnectionList kinds={['jira', 'gitlab']} addLabel="+ Add a connection" />
    </section>
  )
}
