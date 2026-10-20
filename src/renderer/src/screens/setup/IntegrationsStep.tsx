import { useEffect, useState, type ReactElement } from 'react'
import { DEFAULT_IMPORT_STATE_TYPES, type LinearState, type LinearStateType, type LinearTeam } from '@shared/integrations'
import { DEFAULT_LINEAR_PUSH, type GithubProjectConfig, type LinearProjectConfig } from '@shared/model'
import { importRules, sourceOf, SOURCE_NAMES, type ImportRules, type TicketSourceConfig, type TicketSourceKind } from '@shared/sources'
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

function LinearSection({ project, save }: { project: StepProps['project']; save: (linear: LinearProjectConfig) => void }): ReactElement {
  const { status } = useLinearStatus()
  const linear = project.linear
  const [teams, setTeams] = useState<LinearTeam[]>()
  const [states, setStates] = useState<LinearState[]>()
  const [error, setError] = useState<string | null>(null)
  const pipeline = useQuery(() => window.eregion.getPipeline(project.id), [project.id])
  const connected = Boolean(status?.method)

  useEffect(() => {
    if (!connected) return
    window.eregion.listLinearTeams().then(setTeams, (caught: unknown) => setError(errorMessage(caught)))
  }, [connected])
  useEffect(() => {
    if (!connected || !linear.teamId) return
    window.eregion.listLinearStates(linear.teamId).then(setStates, (caught: unknown) => setError(errorMessage(caught)))
  }, [connected, linear.teamId])

  if (!status) return <span className="muted">Loading…</span>
  if (!connected) {
    return (
      <span>
        Linear isn't connected yet. <a href={href({ name: 'settings', tab: 'integrations' })}>Connect it in Settings › Integrations</a>, then come back. Or carry on without it: tickets can be added by hand.
      </span>
    )
  }

  const types = linear.importStateTypes?.length ? linear.importStateTypes : DEFAULT_IMPORT_STATE_TYPES
  const push = { ...DEFAULT_LINEAR_PUSH, ...linear.push }
  const stages = (pipeline.data?.stages ?? []).filter((stage) => stage.enabled)
  const assignees = status.importAssignees
  const person = assignees.mode === 'me' ? 'assigned to you' : assignees.mode === 'everyone' ? 'in the team, assigned to anyone' : `assigned to ${assignees.people.map((item) => item.name).join(', ')}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
  { kind: 'linear', detail: 'Issues from a Linear team. Connect Linear in Settings › Integrations.' },
  { kind: 'manual', detail: "No tracker: add tickets with New ticket on the Board. Their keys use the project's initials." }
]

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
          <LinearSection project={project} save={(linear) => void saveLinear.run(linear)} />
          {saveLinear.error && <span className="error-text">{saveLinear.error}</span>}
        </section>
      )}

      {source.kind !== 'manual' && (
        <section className="panel" aria-label="Labels">
          <h2 style={{ fontSize: 18 }}>Labels</h2>
          <LabelRules key={project.id} rules={importRules(source)} save={(rules) => void saveSource.run({ ...source, rules })} />
        </section>
      )}

      <section className="panel" aria-label="Code">
        <h2 style={{ fontSize: 18 }}>Code: GitHub</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr)', gap: '8px 12px' }}>
          {project.repos.map((repo) => (
            <div key={repo.id} style={{ display: 'contents' }}>
              <span>{repo.name}</span>
              <span>
                {repo.githubRepo ? <span className="mono">{repo.githubRepo}</span> : <span className="error-text">No GitHub remote found</span>}
                <span className="muted"> · PRs into {repo.defaultBranch}</span>
              </span>
            </div>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 13 }}>
          From each repo's git remote. Change them in <a href={href({ name: 'setup', projectId: project.id, step: 'repos' })}>Repos</a>.
        </span>
        <Switch label="Open pull requests as drafts, and wait for me to mark them ready" checked={github.draft !== false} onChange={(draft) => void saveGithub.run({ ...github, draft })} />
        <Switch label="Link a ticket's pull requests to each other" checked={github.linkPrs !== false} onChange={(linkPrs) => void saveGithub.run({ ...github, linkPrs })} />
        {saveGithub.error && <span className="error-text">{saveGithub.error}</span>}
      </section>

      <SetupFooter project={project} step="integrations" onNext={() => void next()} />
    </>
  )
}
