import { useEffect, useState, type ReactElement } from 'react'
import { DEFAULT_IMPORT_STATE_TYPES, type ImportAssignees, type LinearState, type LinearStateType, type LinearStatus, type LinearTeam, type LinearUser } from '@shared/integrations'
import { DEFAULT_LINEAR_PUSH, type GithubProjectConfig, type LinearProjectConfig } from '@shared/model'
import { DEFAULT_SOURCE_PUSH, importRules, sourceOf, SOURCE_NAMES, type ImportRules, type TicketSourceConfig, type TicketSourceKind } from '@shared/sources'
import { Switch } from '../../components/ui'
import { errorMessage, useAction, useQuery } from '../../hooks'
import { href } from '../../router'
import { useLinearStatus } from '../settings/IntegrationsSettings'
import { SetupFooter, type StepProps } from './ProjectSetup'

const IMPORTABLE: { type: LinearStateType; label: string }[] = [
  { type: 'triage', label: 'Triage' },
  { type: 'backlog', label: 'Backlog' },
  { type: 'unstarted', label: 'Todo and other unstarted states' }
]

/**
 * Whose Linear issues come in: you, chosen people, or everyone in the team. Projects that never chose keep the
 * choice Settings used to make for every project.
 */
function LinearWho({ source, saveSource, connectionId, fallback }: { source: TicketSourceConfig; saveSource: (source: TicketSourceConfig) => void; connectionId: string | null; fallback: ImportAssignees }): ReactElement {
  const rules = importRules(source)
  const current: ImportAssignees = source.rules?.who ? (rules.who === 'people' ? { mode: 'people', people: rules.people } : { mode: rules.who }) : connectionId ? { mode: 'me' } : fallback
  const [users, setUsers] = useState<LinearUser[] | null>(null)
  const load = useAction(async () => setUsers(await window.eregion.listLinearUsers(connectionId)))
  const chosen = current.mode === 'people' ? current.people : []
  const save = (who: ImportRules['who'], people = chosen): void => saveSource({ ...source, rules: { ...rules, who, people } })
  const toggle = (user: LinearUser, on: boolean): void => {
    const people = on ? [...chosen, { id: user.id, name: user.name }] : chosen.filter((person) => person.id !== user.id)
    save(people.length ? 'people' : 'me', people)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="label">Whose issues</span>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="radio" name="linear-who" checked={current.mode === 'me' && !users} onChange={() => save('me')} />
        Assigned to me
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="radio" name="linear-who" checked={current.mode === 'people' || Boolean(users)} onChange={() => void load.run()} />
        Assigned to specific people{chosen.length ? `: ${chosen.map((person) => person.name).join(', ')}` : ''}
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="radio" name="linear-who" checked={current.mode === 'everyone' && !users} onChange={() => save('everyone')} />
        Everyone in the team, assigned or not
      </label>
      {(users || current.mode === 'people') && (
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
      {load.error && <span className="error-text">{load.error}</span>}
    </div>
  )
}

/** Which GitHub account a project's pushes, pull requests and agents use: one gh is signed in to, or gh's active one. */
function GitHubAccountPicker({ github, save }: { github: GithubProjectConfig; save: (github: GithubProjectConfig) => void }): ReactElement {
  const accounts = useQuery(() => window.eregion.listGitHubAccounts(), [], (event) => event.type === 'github-changed')
  const active = accounts.data?.find((account) => account.active)
  const missing = github.account && accounts.data && !accounts.data.some((account) => account.login === github.account)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr)', gap: '6px 12px', alignItems: 'center' }}>
      <label className="muted" htmlFor="github-account">
        GitHub account
      </label>
      <select id="github-account" className="select" value={github.account ?? ''} onChange={(event) => save({ ...github, account: event.target.value || null })}>
        <option value="">gh's active account{active ? ` (${active.login})` : ''}</option>
        {accounts.data?.map((account) => (
          <option key={account.login} value={account.login}>
            {account.login}
          </option>
        ))}
        {missing && <option value={github.account ?? ''}>{github.account} (not signed in)</option>}
      </select>
      <span />
      <span className="muted" style={{ fontSize: 13 }}>
        Fetching, pushing, pull requests and the agents' gh commands all act as this account. <a href={href({ name: 'settings', tab: 'integrations' })}>Add accounts in Settings › Accounts</a>.
      </span>
      {missing && (
        <>
          <span />
          <span className="error-text">gh isn't signed in as {github.account} on this machine. Add it in Settings › Accounts, or choose another.</span>
        </>
      )}
    </div>
  )
}

/** Which of the Linear accounts in Settings › Accounts a project takes its issues from. */
function LinearAccount({ source, saveSource, status }: { source: TicketSourceConfig; saveSource: (source: TicketSourceConfig) => void; status: LinearStatus }): ReactElement | null {
  const connections = useQuery(() => window.eregion.listConnections(), [], (event) => event.type === 'linear-changed').data?.filter((connection) => connection.kind === 'linear')
  if (!connections) return null
  const main = status.method ? status.viewer : null
  if (!main && connections.length === 0) return null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr)', gap: '10px 12px', alignItems: 'center' }}>
      <label className="muted" htmlFor="linear-account">
        Account
      </label>
      <select id="linear-account" className="select" value={source.connectionId ?? ''} onChange={(event) => saveSource({ ...source, connectionId: event.target.value || null })}>
        {main ? (
          <option value="">
            {main.name} · {main.organization} ({status.method === 'oauth' ? 'Linear app' : 'API key'})
          </option>
        ) : (
          <option value="" disabled>
            Choose an account
          </option>
        )}
        {connections.map((connection) => (
          <option key={connection.id} value={connection.id}>
            {connection.account ?? connection.name} ({connection.name})
          </option>
        ))}
      </select>
    </div>
  )
}

function LinearSection({ project, save, source, saveSource }: { project: StepProps['project']; save: (linear: LinearProjectConfig) => void; source: TicketSourceConfig; saveSource: (source: TicketSourceConfig) => void }): ReactElement {
  const { status } = useLinearStatus()
  const linear = project.linear
  const [teams, setTeams] = useState<LinearTeam[]>()
  const [states, setStates] = useState<LinearState[]>()
  const [error, setError] = useState<string | null>(null)
  const pipeline = useQuery(() => window.eregion.getPipeline(project.id), [project.id])
  const connectionId = source.connectionId ?? null
  const connected = Boolean(connectionId || status?.method)

  useEffect(() => {
    if (!connected) return
    setTeams(undefined)
    window.eregion.listLinearTeams(connectionId).then(setTeams, (caught: unknown) => setError(errorMessage(caught)))
  }, [connected, connectionId])
  useEffect(() => {
    if (!connected || !linear.teamId) return
    window.eregion.listLinearStates(linear.teamId, connectionId).then(setStates, (caught: unknown) => setError(errorMessage(caught)))
  }, [connected, linear.teamId, connectionId])

  if (!status) return <span className="muted">Loading…</span>
  if (!connected) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <LinearAccount source={source} saveSource={saveSource} status={status} />
        <span>
          Choose the Linear account this project takes its issues from, or <a href={href({ name: 'settings', tab: 'integrations' })}>add one in Settings › Accounts</a>: sign in through your Linear app, or paste an API key. Or carry on without it: tickets can be added by hand.
        </span>
      </div>
    )
  }

  const types = linear.importStateTypes?.length ? linear.importStateTypes : DEFAULT_IMPORT_STATE_TYPES
  const push = { ...DEFAULT_LINEAR_PUSH, ...linear.push }
  const stages = (pipeline.data?.stages ?? []).filter((stage) => stage.enabled)
  const rules = importRules(source)
  const assignees: ImportAssignees = source.rules?.who ? (rules.who === 'people' ? { mode: 'people', people: rules.people } : { mode: rules.who }) : connectionId ? { mode: 'me' } : status.importAssignees
  const person = assignees.mode === 'me' ? 'assigned to you' : assignees.mode === 'everyone' ? 'in the team, assigned to anyone' : `assigned to ${assignees.people.map((item) => item.name).join(', ') || 'the people you choose'}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <LinearAccount source={source} saveSource={saveSource} status={status} />
      <LinearWho key={connectionId ?? 'main'} source={source} saveSource={saveSource} connectionId={connectionId} fallback={status.importAssignees} />
      <div style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr)', gap: '10px 12px', alignItems: 'center' }}>
        <label className="muted" htmlFor="linear-team">
          Team
        </label>
        <select
          id="linear-team"
          className="select"
          value={linear.teamId ?? ''}
          onChange={(event) => {
            const team = teams?.find((item) => item.id === event.target.value)
            save(team ? { ...linear, teamId: team.id, teamKey: team.key, teamName: team.name, statusByStage: {} } : { ...linear, teamId: undefined, teamKey: undefined, teamName: undefined, statusByStage: {} })
          }}
        >
          <option value="">No team: don't use Linear for this project</option>
          {teams?.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name} ({team.key})
            </option>
          ))}
        </select>
        {linear.teamId && (
          <>
            <span className="muted">Pull tickets</span>
            <select className="select" aria-label="Pull tickets" value={linear.pullFrom ?? 'assigned'} onChange={(event) => save({ ...linear, pullFrom: event.target.value as LinearProjectConfig['pullFrom'] })}>
              <option value="assigned">Issues {person}, automatically</option>
              <option value="manual">Only issues I import by key</option>
            </select>
          </>
        )}
      </div>

      {linear.teamId && (linear.pullFrom ?? 'assigned') === 'assigned' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="label">From these states</span>
          {IMPORTABLE.map((item) => (
            <label key={item.type} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={types.includes(item.type)}
                onChange={(event) => {
                  const next = event.target.checked ? [...types, item.type] : types.filter((type) => type !== item.type)
                  if (next.length > 0) save({ ...linear, importStateTypes: next })
                }}
              />
              {item.label}
            </label>
          ))}
          <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
            Check every
            <input className="input" type="number" min={30} style={{ width: 90 }} value={linear.pollSec ?? 60} onChange={(event) => save({ ...linear, pollSec: Math.max(30, Number(event.target.value) || 60) })} />
            seconds
          </label>
          <span className="muted" style={{ fontSize: 13 }}>
            Done and canceled issues never come in. An issue assigned to someone else leaves the Backlog, or gets flagged if work has started.
          </span>
        </div>
      )}

      {linear.teamId && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="label">Send back to Linear</span>
          <Switch label="The approved plan, as a comment" checked={push.planComment} onChange={(planComment) => save({ ...linear, push: { ...push, planComment } })} />
          <Switch label="The approved plan, added to the issue description" checked={push.planDescription} onChange={(planDescription) => save({ ...linear, push: { ...push, planDescription } })} />
          <Switch label="Links to the pull requests" checked={push.prLinks} onChange={(prLinks) => save({ ...linear, push: { ...push, prLinks } })} />
        </div>
      )}

      {linear.teamId && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="label">Linear status when a ticket enters each stage</span>
          <div style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 320px)', gap: '8px 12px', alignItems: 'center' }}>
            {[...stages.map((stage) => ({ id: stage.id, name: stage.name })), { id: 'done', name: 'Done (merged)' }].map((stage) => (
              <div key={stage.id} style={{ display: 'contents' }}>
                <span>{stage.name}</span>
                <select
                  className="select"
                  aria-label={`Linear status for ${stage.name}`}
                  value={linear.statusByStage?.[stage.id] ?? ''}
                  onChange={(event) => {
                    const statusByStage = { ...linear.statusByStage }
                    if (event.target.value) statusByStage[stage.id] = event.target.value
                    else delete statusByStage[stage.id]
                    save({ ...linear, statusByStage })
                  }}
                >
                  <option value="">Don't change it</option>
                  {states?.map((state) => (
                    <option key={state.id} value={state.id}>
                      {state.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}
      {error && <span className="error-text">{error}</span>}
    </div>
  )
}

/** The ticket sources this version of Eregion can read, in the order they're offered. */
const SOURCE_CHOICES: { kind: TicketSourceKind; detail: string }[] = [
  { kind: 'linear', detail: 'Issues from a Linear team. Connect Linear in Settings › Accounts.' },
  { kind: 'github-issues', detail: "Issues from a GitHub repo, through gh signed in as you. While a ticket is in a stage, its issue carries that stage's eregion: label." },
  { kind: 'jira', detail: 'Issues from a Jira Cloud project. Add the Jira connection in Settings › Accounts.' },
  { kind: 'gitlab-issues', detail: 'Issues from a GitLab project, labelled with the stage as for GitHub. Add the GitLab connection in Settings › Accounts.' },
  { kind: 'manual', detail: "No tracker: add tickets with New ticket on the Board. Their keys use the project's initials." }
]

/** Which Jira or GitLab connection a project reads from. */
function ConnectionPicker({ kind, source, save }: { kind: 'jira' | 'gitlab'; source: TicketSourceConfig; save: (source: TicketSourceConfig) => void }): ReactElement {
  const connections = useQuery(() => window.eregion.listConnections(), []).data?.filter((connection) => connection.kind === kind)
  if (connections && connections.length === 0) {
    return (
      <span>
        No {kind === 'jira' ? 'Jira' : 'GitLab'} connection yet. <a href={href({ name: 'settings', tab: 'integrations' })}>Add one in Settings › Accounts</a>, then come back.
      </span>
    )
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr)', gap: '10px 12px', alignItems: 'center' }}>
      <label className="muted" htmlFor="source-connection">
        Connection
      </label>
      <select id="source-connection" className="select" value={source.connectionId ?? ''} onChange={(event) => save({ ...source, connectionId: event.target.value || null })}>
        <option value="">Choose one</option>
        {connections?.map((connection) => (
          <option key={connection.id} value={connection.id}>
            {connection.name} ({connection.url}){connection.account ? ` · ${connection.account}` : ''}
          </option>
        ))}
      </select>
    </div>
  )
}

/** The Jira status each stage moves its issue to, from the project's own statuses. */
function JiraStatuses({ project, source, save }: { project: StepProps['project']; source: TicketSourceConfig; save: (source: TicketSourceConfig) => void }): ReactElement | null {
  const pipeline = useQuery(() => window.eregion.getPipeline(project.id), [project.id])
  const statuses = useQuery(
    () => (source.connectionId && source.location ? window.eregion.listJiraStatuses(source.connectionId, source.location) : Promise.resolve([] as string[])),
    [source.connectionId, source.location]
  )
  if (!source.connectionId || !source.location) return null
  const stages = (pipeline.data?.stages ?? []).filter((stage) => stage.enabled)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="label">Jira status when a ticket enters each stage</span>
      <div style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 320px)', gap: '8px 12px', alignItems: 'center' }}>
        {[...stages.map((stage) => ({ id: stage.id, name: stage.name })), { id: 'done', name: 'Done (merged)' }].map((stage) => (
          <div key={stage.id} style={{ display: 'contents' }}>
            <span>{stage.name}</span>
            <select
              className="select"
              aria-label={`Jira status for ${stage.name}`}
              value={source.statusByStage?.[stage.id] ?? ''}
              onChange={(event) => {
                const statusByStage = { ...source.statusByStage }
                if (event.target.value) statusByStage[stage.id] = event.target.value
                else delete statusByStage[stage.id]
                save({ ...source, statusByStage })
              }}
            >
              <option value="">Don't change it</option>
              {statuses.data?.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      {statuses.error && <span className="error-text">{statuses.error}</span>}
      <span className="muted" style={{ fontSize: 13 }}>
        Eregion moves the issue with whichever transition leads to that status; if none does from where it is, the ticket says so.
      </span>
    </div>
  )
}

/**
 * A tracker other than Linear: where its issues are, whose come in (yours, chosen people's, or everyone's),
 * by themselves or by key, and what goes back to it.
 */
function TrackerSection({
  source,
  save,
  location
}: {
  source: TicketSourceConfig
  save: (source: TicketSourceConfig) => void
  location: { label: string; placeholder: string; hint: string; peopleHint: string }
}): ReactElement {
  const rules = importRules(source)
  const push = { ...DEFAULT_SOURCE_PUSH, ...source.push }
  const [where, setWhere] = useState(source.location ?? '')
  const [people, setPeople] = useState(rules.people.map((person) => person.id).join(', '))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr)', gap: '10px 12px', alignItems: 'center' }}>
        <label className="muted" htmlFor="source-location">
          {location.label}
        </label>
        <input id="source-location" className="input mono" placeholder={location.placeholder} value={where} onChange={(event) => setWhere(event.target.value)} onBlur={() => save({ ...source, location: where.trim() })} />
        <span />
        <span className="muted" style={{ fontSize: 13 }}>
          {location.hint}
        </span>
        <span className="muted">Pull tickets</span>
        <select className="select" aria-label="Pull tickets" value={source.pullFrom ?? 'auto'} onChange={(event) => save({ ...source, pullFrom: event.target.value as 'auto' | 'manual' })}>
          <option value="auto">Automatically</option>
          <option value="manual">Only issues I import by key</option>
        </select>
      </div>
      {(source.pullFrom ?? 'auto') === 'auto' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="label">Open issues assigned to</span>
          {(['me', 'people', 'everyone'] as const).map((who) => (
            <label key={who} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="radio" name="source-who" checked={rules.who === who} onChange={() => save({ ...source, rules: { ...rules, who } })} />
              {who === 'me' ? 'Me' : who === 'people' ? 'Specific people' : 'Anyone, or no one (everything open)'}
            </label>
          ))}
          {rules.who === 'people' && (
            <input
              className="input mono"
              aria-label="People"
              style={{ marginLeft: 24, maxWidth: 420 }}
              placeholder={location.peopleHint}
              value={people}
              onChange={(event) => setPeople(event.target.value)}
              onBlur={() => save({ ...source, rules: { ...rules, people: labelList(people).map((id) => ({ id, name: id })) } })}
            />
          )}
          <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
            Check every
            <input className="input" type="number" min={30} style={{ width: 90 }} value={source.pollSec ?? 60} onChange={(event) => save({ ...source, pollSec: Math.max(30, Number(event.target.value) || 60) })} />
            seconds
          </label>
          <span className="muted" style={{ fontSize: 13 }}>
            Closed issues never come in. An issue assigned to someone else leaves the Backlog, or gets flagged if work has started.
          </span>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="label">Send back</span>
        <Switch label="The approved plan, as a comment" checked={push.planComment} onChange={(planComment) => save({ ...source, push: { ...push, planComment } })} />
        <Switch label="Links to the pull requests, as a comment" checked={push.prLinks} onChange={(prLinks) => save({ ...source, push: { ...push, prLinks } })} />
      </div>
    </div>
  )
}

/** Comma-separated labels, as typed. */
const labelList = (text: string): string[] =>
  text
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)

/** Which labels an issue needs to come in, and which keep it out. */
function LabelRules({ rules, save }: { rules: ImportRules; save: (rules: ImportRules) => void }): ReactElement {
  const [labels, setLabels] = useState(rules.labels.join(', '))
  const [excluded, setExcluded] = useState(rules.excludeLabels.join(', '))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr)', gap: '10px 12px', alignItems: 'center' }}>
      <label className="muted" htmlFor="labels-in">
        Only with labels
      </label>
      <input id="labels-in" className="input" placeholder="Any labels" value={labels} onChange={(event) => setLabels(event.target.value)} onBlur={() => save({ ...rules, labels: labelList(labels) })} />
      <label className="muted" htmlFor="labels-out">
        Never with labels
      </label>
      <input id="labels-out" className="input" placeholder="None" value={excluded} onChange={(event) => setExcluded(event.target.value)} onBlur={() => save({ ...rules, excludeLabels: labelList(excluded) })} />
      <span />
      <span className="muted" style={{ fontSize: 13 }}>
        Comma-separated, any case. An issue needs every label in the first list and none in the second.
      </span>
    </div>
  )
}

export function IntegrationsStep({ project, next }: StepProps): ReactElement {
  const saveLinear = useAction((linear: LinearProjectConfig) => window.eregion.updateProject(project.id, { linear }))
  const saveGithub = useAction((github: GithubProjectConfig) => window.eregion.updateProject(project.id, { github }))
  const saveSource = useAction((source: TicketSourceConfig) => window.eregion.updateProject(project.id, { source }))
  const github = project.github
  const source = sourceOf(project)
  return (
    <>
      <section className="panel" aria-label="Where tickets come from">
        <h2 style={{ fontSize: 18 }}>Tickets come from</h2>
        <div role="radiogroup" aria-label="Ticket source" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {SOURCE_CHOICES.map((choice) => (
            <label key={choice.kind} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <input type="radio" name="ticket-source" checked={source.kind === choice.kind} onChange={() => void saveSource.run({ ...source, kind: choice.kind })} style={{ marginTop: 4 }} />
              <span>
                <strong>{SOURCE_NAMES[choice.kind]}</strong>
                <span className="muted" style={{ display: 'block', fontSize: 13 }}>
                  {choice.detail}
                </span>
              </span>
            </label>
          ))}
        </div>
        {saveSource.error && <span className="error-text">{saveSource.error}</span>}
      </section>

      {source.kind === 'linear' && (
        <section className="panel" aria-label="Linear">
          <h2 style={{ fontSize: 18 }}>Linear</h2>
          <LinearSection project={project} save={(linear) => void saveLinear.run(linear)} source={source} saveSource={(next) => void saveSource.run(next)} />
          {saveLinear.error && <span className="error-text">{saveLinear.error}</span>}
        </section>
      )}

      {source.kind === 'github-issues' && (
        <section className="panel" aria-label="GitHub Issues">
          <h2 style={{ fontSize: 18 }}>GitHub Issues</h2>
          <TrackerSection
            key={project.id}
            source={source}
            save={(next) => void saveSource.run(next)}
            location={{
              label: 'Repo',
              placeholder: project.repos.find((repo) => repo.githubRepo)?.githubRepo ?? 'owner/name',
              hint: 'Leave it empty to use the first repo. Tickets are GH- and the issue number, like GH-12.',
              peopleHint: 'GitHub usernames, comma-separated'
            }}
          />
        </section>
      )}

      {source.kind === 'jira' && (
        <section className="panel" aria-label="Jira">
          <h2 style={{ fontSize: 18 }}>Jira</h2>
          <ConnectionPicker kind="jira" source={source} save={(next) => void saveSource.run(next)} />
          <TrackerSection
            key={`jira-${project.id}`}
            source={source}
            save={(next) => void saveSource.run(next)}
            location={{ label: 'Project key', placeholder: 'SHOP', hint: 'The letters before the issue numbers, like SHOP in SHOP-12. Issues still To Do come in.', peopleHint: 'Jira account ids, comma-separated' }}
          />
          <JiraStatuses project={project} source={source} save={(next) => void saveSource.run(next)} />
        </section>
      )}

      {source.kind === 'gitlab-issues' && (
        <section className="panel" aria-label="GitLab issues">
          <h2 style={{ fontSize: 18 }}>GitLab issues</h2>
          <ConnectionPicker kind="gitlab" source={source} save={(next) => void saveSource.run(next)} />
          <TrackerSection
            key={`gitlab-${project.id}`}
            source={source}
            save={(next) => void saveSource.run(next)}
            location={{ label: 'Project', placeholder: 'group/app', hint: 'Its path on GitLab. Tickets are GL- and the issue number, like GL-12.', peopleHint: 'GitLab usernames, comma-separated' }}
          />
        </section>
      )}

      {source.kind !== 'manual' && (
        <section className="panel" aria-label="Labels">
          <h2 style={{ fontSize: 18 }}>Labels</h2>
          <LabelRules key={project.id} rules={importRules(source)} save={(rules) => void saveSource.run({ ...source, rules })} />
        </section>
      )}

      <section className="panel" aria-label="Code">
        <h2 style={{ fontSize: 18 }}>Code</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr)', gap: '8px 12px' }}>
          {project.repos.map((repo) => (
            <div key={repo.id} style={{ display: 'contents' }}>
              <span>{repo.name}</span>
              <span>
                {repo.githubRepo ? <span className="mono">{repo.githubRepo}</span> : <span className="muted">Not on GitHub: pull requests go to GitLab when its remote is on one of your GitLab connections</span>}
                <span className="muted"> · PRs into {repo.defaultBranch}</span>
              </span>
            </div>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 13 }}>
          From each repo's git remote. Change them in <a href={href({ name: 'setup', projectId: project.id, step: 'repos' })}>Repos</a>.
        </span>
        <GitHubAccountPicker github={github} save={(next) => void saveGithub.run(next)} />
        <Switch label="Open pull requests as drafts, and wait for me to mark them ready" checked={github.draft !== false} onChange={(draft) => void saveGithub.run({ ...github, draft })} />
        <Switch label="Link a ticket's pull requests to each other" checked={github.linkPrs !== false} onChange={(linkPrs) => void saveGithub.run({ ...github, linkPrs })} />
        {saveGithub.error && <span className="error-text">{saveGithub.error}</span>}
      </section>

      <SetupFooter project={project} step="integrations" onNext={() => void next()} />
    </>
  )
}
