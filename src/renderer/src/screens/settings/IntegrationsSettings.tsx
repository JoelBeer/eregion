import { useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import type { GitHubPermission, GitHubSignIn, LinearStatus } from '@shared/integrations'
import { Chip, StatusPill } from '../../components/ui'
import { errorMessage, useAction, useQuery } from '../../hooks'
import { ConnectionList, ConnectionsSection } from './ConnectionsSection'
import { CursorCostsSection } from './CursorCostsSection'

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
  const [showSecret, setShowSecret] = useState(false)
  const saveId = useAction(() => window.eregion.setLinearClientId(clientId))
  const signIn = useAction(async () => {
    if (clientId.trim() !== (status.clientId ?? '')) await window.eregion.setLinearClientId(clientId)
    await window.eregion.signInToLinear(secret || undefined)
    setSecret('')
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
      <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => setShowSecret(!showSecret)} style={{ alignSelf: 'flex-start' }}>
        Linear asked for a client secret?
      </button>
      {showSecret && (
        <div className="field">
          <label htmlFor="linear-secret">Client secret</label>
          <input id="linear-secret" className="input mono" type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} />
          <span className="muted" style={{ fontSize: 12 }}>
            Only needed if your app refuses sign-in without one. It's sent with the sign-in and kept encrypted with the token.
          </span>
        </div>
      )}
    </div>
  )
}

const PERMISSION_LABELS: Record<GitHubPermission, string> = { admin: 'Admin', maintain: 'Maintain', write: 'Write', triage: 'Triage', read: 'Read' }

const openLink = (url: string) => (event: MouseEvent) => {
  event.preventDefault()
  void window.eregion.openExternal(url)
}

/** One account's name, organisations, and the repos it can reach, with a search. */
function GitHubAccountDetails({ login: chosen }: { login: string }): ReactElement {
  const account = useQuery(() => window.eregion.getGitHubAccount(chosen), [chosen])
  const [search, setSearch] = useState('')
  if (account.loading) return <span className="muted">Reading your GitHub account…</span>
  if (account.error) return <span className="error-text">Couldn't read your GitHub account: {account.error}</span>
  if (!account.data) return <></>
  const { login, name, url, runtime, organizations, repos, more } = account.data
  const term = search.trim().toLowerCase()
  const shown = term ? repos.filter((repo) => repo.name.toLowerCase().includes(term) || repo.projects.some((project) => project.toLowerCase().includes(term))) : repos
  return (
    <>
      <span>
        <a href={url} onClick={openLink(url)}>
          <strong>{name ?? login}</strong>
          {name ? ` (@${login})` : ''}
        </a>
        , with gh on {runtime}.
      </span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 13 }}>
          Organisations:
        </span>
        {organizations.length === 0 && (
          <span className="muted" style={{ fontSize: 13 }}>
            none that gh can see
          </span>
        )}
        {organizations.map((org) => (
          <Chip key={org} tone="neutral">
            {org}
          </Chip>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 15 }}>
          Repositories you can reach <span className="muted">· {more ? `${repos.length}+` : repos.length}</span>
        </h3>
        <div style={{ flex: 1 }} />
        <input type="search" className="input" aria-label="Search repositories" placeholder="Search by name or project" value={search} onChange={(event) => setSearch(event.target.value)} style={{ width: 240, padding: '6px 10px' }} />
      </div>
      <ul aria-label="Repositories" style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border-200)', borderRadius: 8 }}>
        {shown.map((repo) => (
          <li key={repo.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border-200)' }}>
            <a href={repo.url} onClick={openLink(repo.url)} className="mono" style={{ fontSize: 13 }}>
              {repo.name}
            </a>
            {repo.projects.map((project) => (
              <Chip key={project} tone="forge">
                In {project}
              </Chip>
            ))}
            <div style={{ flex: 1 }} />
            <span className="muted" style={{ fontSize: 12 }}>
              {repo.private ? 'Private' : 'Public'} · {PERMISSION_LABELS[repo.permission]}
            </span>
          </li>
        ))}
        {shown.length === 0 && (
          <li className="muted" style={{ padding: '8px 12px' }}>
            {term ? 'No repositories match.' : 'No repositories yet.'}
          </li>
        )}
      </ul>
      {more && (
        <span className="muted" style={{ fontSize: 13 }}>
          Showing the {repos.length} you pushed to most recently.
        </span>
      )}
    </>
  )
}

/**
 * Adds an account to gh with its browser sign-in: copy the code, enter it on GitHub signed in as the account
 * you want. The account your Terminal's gh uses stays the active one.
 */
function AddGitHubAccount({ onAdded }: { onAdded: () => void }): ReactElement {
  const [signIn, setSignIn] = useState<GitHubSignIn | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelled = useRef(false)
  const start = async (): Promise<void> => {
    cancelled.current = false
    setError(null)
    setStarting(true)
    try {
      setSignIn(await window.eregion.startGitHubSignIn())
      setStarting(false)
      await window.eregion.finishGitHubSignIn()
      onAdded()
    } catch (caught) {
      if (!cancelled.current) setError(errorMessage(caught))
    } finally {
      setStarting(false)
      setSignIn(null)
    }
  }
  const cancel = (): void => {
    cancelled.current = true
    void window.eregion.cancelGitHubSignIn()
  }
  if (!signIn) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button type="button" className="er-btn er-btn-sm" onClick={() => void start()} disabled={starting} style={{ alignSelf: 'flex-start' }}>
          {starting ? 'Starting…' : 'Add an account'}
        </button>
        {error && <span className="error-text">{error}</span>}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: '1px solid var(--border-200)', borderRadius: 8 }}>
      <span>
        Copy this code, then open GitHub and enter it. Approve it as the account you want to add: if your browser is signed in to GitHub as someone else, sign out there first or use a private window.
      </span>
      <CopyRow text={signIn.code} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" className="er-btn er-btn-sm er-btn-primary" onClick={() => void window.eregion.openExternal(signIn.url)}>
          Open GitHub
        </button>
        <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={cancel}>
          Cancel
        </button>
        <span className="muted" style={{ fontSize: 13 }}>
          Waiting for GitHub…
        </span>
      </div>
    </div>
  )
}

/** The GitHub accounts gh is signed in to: add one, sign out of one, or look at the repos one can reach. */
function GitHubAccounts(): ReactElement {
  const accounts = useQuery(() => window.eregion.listGitHubAccounts(), [], (event) => event.type === 'github-changed')
  const [open, setOpen] = useState<string | null>(null)
  const signOut = useAction(async (login: string) => {
    if (!window.confirm(`Sign gh out of ${login} on this machine? That signs your Terminal's gh out of it too, and projects that use it stop being able to push until you add it again.`)) return
    await window.eregion.signOutOfGitHub(login)
    accounts.reload()
  })
  const row = (children: ReactNode, key: string): ReactElement => (
    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border-200)' }}>
      {children}
    </div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {accounts.loading && !accounts.data && <span className="muted">Reading gh's accounts…</span>}
      {accounts.data?.length === 0 && <span>gh isn't signed in to GitHub yet.</span>}
      {accounts.data && accounts.data.length > 0 && (
        <div>
          {accounts.data.map((account) => (
            <div key={account.login}>
              {row(
                <>
                  <strong>{account.login}</strong>
                  {account.active && (
                    <Chip tone="info">
                      <span title="The account gh uses in your Terminal, and in projects that don't choose one">Active in gh</span>
                    </Chip>
                  )}
                  <div style={{ flex: 1 }} />
                  <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => setOpen(open === account.login ? null : account.login)}>
                    {open === account.login ? 'Hide repositories' : 'Repositories'}
                  </button>
                  <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => void signOut.run(account.login)} disabled={signOut.pending}>
                    Sign out
                  </button>
                </>,
                account.login
              )}
              {open === account.login && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 0 14px' }}>
                  <GitHubAccountDetails login={account.login} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {(accounts.error || signOut.error) && <span className="error-text">{accounts.error ?? signOut.error}</span>}
      <AddGitHubAccount onAdded={accounts.reload} />
      <span className="muted" style={{ fontSize: 13 }}>
        gh keeps these sign-ins (in the Keychain on a Mac), not Eregion. Each project chooses which one it works as in its Tickets and code step; projects that don't use the account active in gh.
      </span>
    </div>
  )
}

/**
 * The Linear accounts projects can take issues from: one signed in through your own Linear app, and any number
 * added with personal API keys (other workspaces, or other people).
 */
function LinearAccounts(): ReactElement {
  const { status } = useLinearStatus()
  const [connecting, setConnecting] = useState(false)
  const sync = useAction(() => window.eregion.syncLinear())
  const signOut = useAction(async () => {
    if (window.confirm('Disconnect this Linear account? Tickets already imported stay; projects using it get nothing new until they pick another account.')) await window.eregion.signOutOfLinear()
  })
  if (!status) return <span className="muted">Loading…</span>
  const main = status.method ? status.viewer : null
  return (
    <>
      <span className="muted" style={{ fontSize: 13 }}>
        Accounts projects can take Linear issues from. Each project picks one in its Tickets and code step, and chooses whose issues it imports.
      </span>
      {main && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', borderTop: '1px solid var(--divider-100)', paddingTop: 10 }}>
          <strong>{main.name}</strong>
          <span className="muted">{status.method === 'oauth' ? 'Linear app' : 'API key'}</span>
          <StatusPill status="passed">{main.organization}</StatusPill>
          <span className="muted" style={{ fontSize: 12 }}>
            {main.email}
          </span>
          <div style={{ flex: 1 }} />
          <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => void signOut.run()}>
            Disconnect
          </button>
        </div>
      )}
      <ConnectionList
        kinds={['linear']}
        addLabel="+ Add an API key"
        actions={
          !status.method && !connecting ? (
            <button type="button" className="er-btn er-btn-sm" onClick={() => setConnecting(true)}>
              Sign in with your Linear app
            </button>
          ) : undefined
        }
      />
      {!status.method && connecting && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: '1px solid var(--border-200)', borderRadius: 8 }}>
          <ConnectLinear status={status} />
          <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => setConnecting(false)} style={{ alignSelf: 'flex-start' }}>
            Close
          </button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 13 }}>
          Last synced {timeAgo(status.lastSyncAt)}. Eregion checks every minute while it's open, and when you come back to it.
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="er-btn er-btn-sm" onClick={() => void sync.run()} disabled={sync.pending}>
          {sync.pending ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
      {status.error && <span className="error-text">Last sync failed: {status.error}</span>}
      {(sync.error || signOut.error) && <span className="error-text">{sync.error ?? signOut.error}</span>}
    </>
  )
}

export function IntegrationsSettings(): ReactElement {
  const tools = useQuery(() => window.eregion.checkTools(), [])
  const gh = tools.data?.find((check) => check.tool === 'gh')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 820 }}>
      <section className="panel" aria-label="Linear">
        <h2 style={{ fontSize: 18 }}>Linear</h2>
        <LinearAccounts />
      </section>

      <section className="panel" aria-label="GitHub">
        <h2 style={{ fontSize: 18 }}>GitHub</h2>
        <span>Eregion fetches, pushes and opens pull requests with the GitHub CLI, as the account each project chooses. It stores no GitHub token.</span>
        {!gh && <span className="muted">Checking gh…</span>}
        {gh && !gh.found && <span className="error-text">gh isn't installed. Install the GitHub CLI, then run gh auth login.</span>}
        {gh?.found && (
          <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <StatusPill status={gh.detail?.startsWith('signed in') ? 'passed' : 'needsYou'}>{gh.detail?.startsWith('signed in') ? 'Signed in' : 'Not signed in'}</StatusPill>
            <span className="muted">
              gh {gh.version}
            </span>
          </span>
        )}
        {gh?.found && <GitHubAccounts />}
      </section>

      <CursorCostsSection />

      <ConnectionsSection />
    </div>
  )
}
