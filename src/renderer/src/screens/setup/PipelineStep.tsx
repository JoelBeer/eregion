import { Fragment, useEffect, useState, type DragEvent, type ReactElement } from 'react'
import {
  canFail,
  DEFAULT_CI,
  defaultPipeline,
  isGenericStage,
  isPinnedStage,
  moveStage,
  readsVerdict,
  stageAccess,
  stageFromTemplate,
  validatePipeline,
  verdictFile,
  type CiSettings,
  type DoneWhen,
  type StageAction,
  type StageConfig,
  type StageTemplate
} from '@shared/pipeline'
import { missingCapabilities, type AgentConnector } from '@shared/connectors'
import type { CrewMember } from '@shared/runs'
import { useConnectors } from '../../agents'
import { Switch } from '../../components/ui'
import { errorMessage, useAction } from '../../hooks'
import { useCrew } from '../Board'
import { PipelineHistory } from './PipelineHistory'
import { SetupFooter, type StepProps } from './ProjectSetup'

const KIND_LABELS: Record<StageConfig['kind'], string> = {
  plan: 'Plan',
  build: 'Build',
  review: 'Review',
  pr: 'Pull requests',
  ci: 'Watch CI',
  custom: 'Custom'
}

const DONE_LABELS: Record<DoneWhen, string> = {
  approval: 'You approve it',
  'agent-finishes': 'The agent finishes and its files are written',
  command: 'A command passes',
  verdict: 'Its verdict passes',
  'review-pass': 'Its verdict passes, then you check it',
  'prs-ready': 'The pull requests are open',
  'prs-merged': 'The pull requests are merged',
  'prs-green': 'Every required check is green'
}

/** The colour beside each stage in the strip, as in the screens canvas. */
const STAGE_COLOURS: Record<StageConfig['kind'], string> = {
  plan: '#FFB27A',
  build: '#5FC4B8',
  review: '#9DB4F2',
  pr: '#F2D06B',
  ci: '#76E1EF',
  custom: '#C9B8F0'
}

const ROLES: CrewMember['role'][] = ['Planner', 'Builder', 'Reviewer', 'Shipper']

/** How a stage between Plan and Watch CI can be done. */
const GENERIC_DONE: DoneWhen[] = ['agent-finishes', 'approval', 'command', 'verdict', 'review-pass']

function hasAction(stage: StageConfig, type: StageAction['type']): boolean {
  return stage.after.some((action) => action.type === type)
}

function toggleAction(stage: StageConfig, action: StageAction, on: boolean): StageConfig {
  const rest = stage.after.filter((item) => item.type !== action.type)
  return { ...stage, after: on ? [...rest, action] : rest }
}

/**
 * Who runs a stage. Plan and interactive stages need an agent that can carry on a conversation, so crew on
 * agents that can't are greyed out; what the chosen agent can't do is said underneath.
 */
function CrewPicker({ stage, crew, onChange }: { stage: StageConfig; crew: CrewMember[]; onChange: (stage: StageConfig) => void }): ReactElement {
  const connectors = useConnectors()
  const value = stage.crewId !== null ? `id:${stage.crewId}` : `role:${stage.crewRole ?? 'Builder'}`
  const needsConversation = stage.kind === 'plan' || stage.mode === 'interactive'
  const connectorOf = (member: CrewMember | undefined): AgentConnector | undefined => (member ? connectors.find((item) => item.id === member.adapter) : undefined)
  const cannot = (member: CrewMember | undefined): boolean => needsConversation && connectorOf(member)?.capabilities.followUps === false
  const chosen = stage.crewId !== null ? crew.find((member) => member.id === stage.crewId) : crew.find((member) => member.role === (stage.crewRole ?? 'Builder'))
  const chosenConnector = connectorOf(chosen)
  const notes = chosenConnector ? missingCapabilities(chosenConnector, { followUps: needsConversation, tooling: true }) : []
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <select
      className="select"
      aria-label="Who runs it"
      value={value}
      onChange={(event) => {
        const [kind, rest] = event.target.value.split(':')
        onChange(kind === 'id' ? { ...stage, crewId: Number(rest) } : { ...stage, crewId: null, crewRole: rest as CrewMember['role'] })
      }}
    >
      <optgroup label="By role">
        {ROLES.map((role) => {
          const holder = crew.find((member) => member.role === role)
          return (
            <option key={role} value={`role:${role}`} disabled={cannot(holder)}>
              Whoever is the {role}
              {holder ? ` (${holder.name})` : ''}
            </option>
          )
        })}
      </optgroup>
      <optgroup label="Always">
        {crew.map((member) => (
          <option key={member.id} value={`id:${member.id}`} disabled={cannot(member)}>
            {member.name} · {connectorOf(member)?.name ?? member.adapter} · {member.model}
          </option>
        ))}
      </optgroup>
    </select>
      {notes.map((note) => (
        <span key={note} className={needsConversation && note.includes('conversation') ? 'error-text' : 'muted'} style={{ fontSize: 12 }}>
          {note}.
        </span>
      ))}
    </span>
  )
}

function CiEditor({ ci, onChange }: { ci: CiSettings; onChange: (ci: CiSettings) => void }): ReactElement {
  const [ignores, setIgnores] = useState((ci.ignoreChecks ?? []).join(', '))
  const number = (key: 'intervalSec' | 'maxAttempts' | 'concurrentFixes', min: number, label: string): ReactElement => (
    <input className="input" type="number" min={min} aria-label={label} style={{ width: 90 }} value={ci[key]} onChange={(event) => onChange({ ...ci, [key]: Math.max(min, Number(event.target.value) || min) })} />
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '220px auto', gap: '8px 12px', alignItems: 'center', justifyContent: 'start' }}>
        <span className="muted">Check every</span>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>{number('intervalSec', 15, 'Check interval')} seconds</span>
        <span className="muted">Fix attempts per ticket</span>
        {number('maxAttempts', 1, 'Fix attempts')}
        <span className="muted">Fixes running at once</span>
        {number('concurrentFixes', 1, 'Concurrent fixes')}
        <label className="muted" htmlFor="ci-ignore">
          Checks to ignore
        </label>
        <input
          id="ci-ignore"
          className="input"
          placeholder="None, e.g. codecov/patch"
          style={{ width: 320 }}
          value={ignores}
          onChange={(event) => setIgnores(event.target.value)}
          onBlur={() =>
            onChange({
              ...ci,
              ignoreChecks: ignores
                .split(',')
                .map((name) => name.trim())
                .filter(Boolean)
            })
          }
        />
      </div>
      <span className="muted" style={{ fontSize: 13 }}>
        Ignored checks, by name and comma-separated, count as passing on every ticket: Watch CI neither fixes them nor waits for them. A single ticket can ignore a check from its Watch CI panel too.
      </span>
      <Switch label="Fix failing checks automatically on new tickets" checked={ci.autofixForNewTickets} onChange={(autofixForNewTickets) => onChange({ ...ci, autofixForNewTickets })} />
      <Switch label="Re-run a failed check once before fixing it (catches flaky tests)" checked={ci.rerunFirst} onChange={(rerunFirst) => onChange({ ...ci, rerunFirst })} />
      <Switch label="Pause fixing when someone else pushes to the branch" checked={ci.pauseOnForeignPush} onChange={(pauseOnForeignPush) => onChange({ ...ci, pauseOnForeignPush })} />
      <Switch label="Count optional checks too" checked={ci.includeOptionalChecks} onChange={(includeOptionalChecks) => onChange({ ...ci, includeOptionalChecks })} />
      <span className="muted" style={{ fontSize: 13 }}>
        When the attempts run out:
      </span>
      <Switch label="Flag the ticket and notify me" checked={ci.onAttemptsExhausted.flagAndNotify} onChange={(flagAndNotify) => onChange({ ...ci, onAttemptsExhausted: { ...ci.onAttemptsExhausted, flagAndNotify } })} />
      <Switch label="Comment on the PR with what was tried" checked={ci.onAttemptsExhausted.commentOnPr} onChange={(commentOnPr) => onChange({ ...ci, onAttemptsExhausted: { ...ci.onAttemptsExhausted, commentOnPr } })} />
    </div>
  )
}

function StageEditor({ stage, stages, crew, onChange, onMove, onRemove }: { stage: StageConfig; stages: StageConfig[]; crew: CrewMember[]; onChange: (stage: StageConfig) => void; onMove: (by: -1 | 1) => void; onRemove: () => void }): ReactElement {
  const defaults = defaultPipeline().find((item) => item.kind === stage.kind)
  const generic = isGenericStage(stage)
  const doneOptions: DoneWhen[] = generic ? GENERIC_DONE : stage.kind === 'ci' ? ['prs-merged', 'prs-green'] : [stage.doneWhen]
  const index = stages.indexOf(stage)
  const earlier = stages.slice(0, index).filter(isGenericStage)
  const access = stageAccess(stage)
  const verdict = verdictFile(stage)
  const fallbackReturn = [...earlier].reverse().find((item) => stageAccess(item) === 'changes') ?? earlier.at(-1)
  return (
    <section className="panel" aria-label={`${stage.name} settings`}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input className="input" aria-label="Stage name" style={{ width: 220, fontWeight: 600 }} value={stage.name} onChange={(event) => onChange({ ...stage, name: event.target.value })} />
        <span className="muted" style={{ fontSize: 13 }}>
          {generic ? (stage.kind === 'custom' ? 'Your own stage' : `From the ${KIND_LABELS[stage.kind]} template`) : `${KIND_LABELS[stage.kind]} stage`}
        </span>
        <div style={{ flex: 1 }} />
        {!isPinnedStage(stage) && (
          <>
            <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => onMove(-1)} disabled={index <= 1}>
              ← Move earlier
            </button>
            <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => onMove(1)} disabled={index >= stages.length - (stages.at(-1)?.kind === 'ci' ? 2 : 1)}>
              Move later →
            </button>
            <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={onRemove}>
              Remove stage
            </button>
          </>
        )}
        {stage.kind === 'ci' && <Switch label="On" checked={stage.enabled} onChange={(enabled) => onChange({ ...stage, enabled })} />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '160px minmax(0, 1fr)', gap: '10px 12px', alignItems: 'center' }}>
        <span className="muted">Who runs it</span>
        <CrewPicker stage={stage} crew={crew} onChange={onChange} />

        {stage.kind === 'plan' && (
          <>
            <span className="muted">Spec</span>
            <Switch label="Also write spec.md: what must be true when the ticket is done. Build is held to it and Review checks it item by item." checked={stage.spec !== false} onChange={(spec) => onChange({ ...stage, spec })} />
          </>
        )}

        {generic && (
          <>
            <span className="muted">Works in</span>
            <select className="select" aria-label="Works in" value={stage.workspace} onChange={(event) => onChange({ ...stage, workspace: event.target.value as StageConfig['workspace'] })}>
              <option value="ticket-worktrees">The ticket's worktrees, with its app running</option>
              <option value="plan-checkout">The shared read-only checkout</option>
            </select>
            {stage.workspace === 'ticket-worktrees' && (
              <>
                <span className="muted">Changes</span>
                <select className="select" aria-label="Changes" value={access} onChange={(event) => onChange({ ...stage, access: event.target.value as 'changes' | 'read-only' })}>
                  <option value="changes">It can change the ticket's files</option>
                  <option value="read-only">Read-only: anything it changes is thrown away</option>
                </select>
              </>
            )}
            <span className="muted">Files it writes</span>
            <input
              className="input mono"
              aria-label="Files it writes"
              placeholder="notes.md, check.json"
              value={stage.outputs.join(', ')}
              onChange={(event) => onChange({ ...stage, outputs: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })}
            />
          </>
        )}

        <span className="muted">Done when</span>
        {doneOptions.length > 1 ? (
          <select className="select" aria-label="Done when" value={stage.doneWhen} onChange={(event) => onChange({ ...stage, doneWhen: event.target.value as DoneWhen })}>
            {doneOptions.map((option) => (
              <option key={option} value={option}>
                {DONE_LABELS[option]}
              </option>
            ))}
          </select>
        ) : (
          <span>{DONE_LABELS[stage.doneWhen]}</span>
        )}
        {stage.doneWhen === 'command' && (
          <>
            <span className="muted">Command</span>
            <input className="input mono" aria-label="Done command" placeholder="php artisan test" value={stage.doneCommand ?? ''} onChange={(event) => onChange({ ...stage, doneCommand: event.target.value })} />
          </>
        )}
        {generic && readsVerdict(stage) && (
          <>
            <span className="muted">Verdict</span>
            <span className={verdict ? 'muted' : 'error-text'} style={{ fontSize: 13 }}>
              {verdict ? (
                <>
                  Read from <span className="mono">{verdict}</span>: {'{"verdict": "pass" | "fail", "summary", "issues": [...]}'}, like Review's.
                </>
              ) : (
                'Add a .json file to the files it writes; the verdict goes in it.'
              )}
            </span>
          </>
        )}

        {generic && canFail(stage) && (
          <>
            <span className="muted">If it fails</span>
            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                className="select"
                aria-label="Go back to"
                value={stage.onFailure?.returnTo ?? ''}
                onChange={(event) => onChange({ ...stage, onFailure: event.target.value ? { maxLoops: stage.onFailure?.maxLoops ?? 2, returnTo: event.target.value } : undefined })}
              >
                <option value="">Stop and ask me</option>
                {earlier.map((item) => (
                  <option key={item.id} value={item.id}>
                    Go back to {item.name}
                  </option>
                ))}
              </select>
              {stage.onFailure && (
                <>
                  at most
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={10}
                    aria-label="Loops"
                    style={{ width: 70 }}
                    value={stage.onFailure.maxLoops}
                    onChange={(event) => onChange({ ...stage, onFailure: { returnTo: stage.onFailure?.returnTo ?? fallbackReturn?.id ?? '', maxLoops: Math.min(10, Math.max(1, Number(event.target.value) || 2)) } })}
                  />
                  times, then stop and ask me
                </>
              )}
            </span>
            {stage.onFailure && (
              <>
                <span />
                <span className="muted" style={{ fontSize: 12 }}>
                  The cap stops a runaway loop from spending all the tokens. Agent errors and usage limits don't count: they stop and ask you without using up a loop.
                </span>
              </>
            )}
          </>
        )}
      </div>

      {generic && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="muted" style={{ fontSize: 13 }}>
            Afterwards
          </span>
          {stage.workspace === 'ticket-worktrees' && access === 'changes' && (
            <>
              <Switch label="Commit the changes" checked={hasAction(stage, 'commit')} onChange={(on) => onChange(toggleAction(stage, { type: 'commit' }, on))} />
              <Switch label="Push the branch" checked={hasAction(stage, 'push')} onChange={(on) => onChange(toggleAction(stage, { type: 'push' }, on))} />
            </>
          )}
          <Switch label="Notify me" checked={hasAction(stage, 'notify')} onChange={(on) => onChange(toggleAction(stage, { type: 'notify' }, on))} />
        </div>
      )}

      {stage.kind === 'ci' && <CiEditor ci={stage.ci ?? DEFAULT_CI} onChange={(ci) => onChange({ ...stage, ci })} />}

      <div className="field">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <label htmlFor={`goal-${stage.id}`}>{stage.kind === 'ci' ? 'Prompt for fixing a failed check' : 'Prompt'}</label>
          {defaults && stage.kind !== 'custom' && stage.goal !== defaults.goal && (
            <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => onChange({ ...stage, goal: defaults.goal })}>
              Reset to the default
            </button>
          )}
        </div>
        <textarea id={`goal-${stage.id}`} className="textarea mono" rows={12} style={{ fontSize: 12.5 }} value={stage.goal} onChange={(event) => onChange({ ...stage, goal: event.target.value })} />
        <span className="muted" style={{ fontSize: 12 }}>
          Eregion adds the ticket, the workspace and the output format around this. Variables like <span className="mono">{'{{ticket.key}}'}</span> work here, and{' '}
          <span className="mono">{'{{review.previous}}'}</span> holds the failed verdict when work comes back to this stage.
        </span>
      </div>
    </section>
  )
}

/** The templates + offers between two stages. */
function AddStageMenu({ stages, onPick, onCancel }: { stages: StageConfig[]; onPick: (template: StageTemplate) => void; onCancel: () => void }): ReactElement {
  const hasPr = stages.some((stage) => stage.kind === 'pr')
  return (
    <div role="group" aria-label="Add a stage" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className="muted" style={{ fontSize: 13 }}>
        Add a stage here:
      </span>
      <button type="button" className="er-btn er-btn-sm" onClick={() => onPick('build')}>
        Build
      </button>
      <button type="button" className="er-btn er-btn-sm" onClick={() => onPick('review')}>
        Review
      </button>
      <button type="button" className="er-btn er-btn-sm" disabled={hasPr} title={hasPr ? 'There can only be one Pull requests stage' : undefined} onClick={() => onPick('pr')}>
        Pull requests
      </button>
      <button type="button" className="er-btn er-btn-sm" onClick={() => onPick('custom')}>
        Blank
      </button>
      <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
}

export function PipelineStep({ project, next }: StepProps): ReactElement {
  const crew = useCrew()
  const [loaded, setLoaded] = useState<{ version: number; stages: StageConfig[]; olderVersions: { version: number; tickets: number }[] }>()
  const [stages, setStages] = useState<StageConfig[]>([])
  const [selected, setSelected] = useState('plan')
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [adding, setAdding] = useState<number | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [history, setHistory] = useState(false)

  const reload = (): void => {
    window.eregion.getPipeline(project.id).then(
      (result) => {
        setLoaded(result)
        setStages(result.stages)
      },
      (caught: unknown) => setLoadError(errorMessage(caught))
    )
  }
  useEffect(reload, [project.id])

  const dirty = loaded !== undefined && JSON.stringify(loaded.stages) !== JSON.stringify(stages)
  const problems = validatePipeline(stages)
  const persist = async (): Promise<void> => {
    if (!dirty) return
    await window.eregion.savePipeline(project.id, stages)
    const result = await window.eregion.getPipeline(project.id)
    setLoaded(result)
    setStages(result.stages)
  }
  const save = useAction(persist)
  const saveAndNext = useAction(async () => {
    await persist()
    await next()
  })

  if (loadError) return <span className="error-text">{loadError}</span>
  if (!loaded) return <span className="muted">Loading…</span>

  const stage = stages.find((item) => item.id === selected) ?? stages[0]
  const update = (changed: StageConfig): void => setStages(stages.map((item) => (item.id === changed.id ? changed : item)))
  const drop = (event: DragEvent, index: number): void => {
    event.preventDefault()
    if (dragging !== null) setStages(moveStage(stages, dragging, index))
    setDragging(null)
    setOver(null)
  }
  const dragOver = (event: DragEvent, index: number): void => {
    event.preventDefault()
    if (over !== index) setOver(index)
  }
  /** Adds a stage from a template at `index`; past the end means just before Watch CI, which stays last. */
  const insertAt = (index: number, template: StageTemplate): void => {
    const ci = stages.findIndex((item) => item.kind === 'ci')
    const at = ci >= 0 ? Math.min(index, ci) : index
    const added = stageFromTemplate(template, stages, at)
    const copy = [...stages]
    copy.splice(at, 0, added)
    setStages(copy)
    setSelected(added.id)
    setAdding(null)
  }
  const crewFor = (item: StageConfig): CrewMember | undefined => crew.find((member) => member.id === item.crewId) ?? crew.find((member) => member.role === item.crewRole)
  const subtitle = (item: StageConfig): string => {
    const name = crewFor(item)?.name ?? item.crewRole ?? 'Builder'
    if (item.kind === 'ci') return item.enabled ? `built in · ${name} fixes` : 'built in · off'
    return `${name} · ${item.mode}`
  }
  const older = loaded.olderVersions.reduce((sum, item) => sum + item.tickets, 0)

  return (
    <>
      <section className="panel" aria-label="Stages">
        <ol className="er-stage-strip" aria-label="Stages, drag to reorder">
          {stages.map((item, index) => {
            const pinned = isPinnedStage(item)
            const classes = ['er-stage-card', item.id === stage?.id && 'is-selected', over === index && dragging !== null && dragging !== index && !pinned && 'is-drop-target', dragging === index && 'is-dragging', !item.enabled && 'is-off']
            return (
              <Fragment key={item.id}>
                {index > 0 && (
                  <li>
                    <button type="button" className="er-stage-insert" aria-label={`Add a stage before ${item.name}`} title="Add a stage here" aria-expanded={adding === index} onClick={() => setAdding(adding === index ? null : index)}>
                      +
                    </button>
                  </li>
                )}
                <li
                  className={classes.filter(Boolean).join(' ')}
                  draggable={!pinned}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move'
                    setDragging(index)
                  }}
                  onDragEnd={() => {
                    setDragging(null)
                    setOver(null)
                  }}
                  onDragOver={(event) => dragOver(event, index)}
                  onDrop={(event) => drop(event, index)}
                  onClick={() => setSelected(item.id)}
                  title={pinned ? `${item.name} stays ${item.kind === 'plan' ? 'first' : 'last'}` : 'Drag to move'}
                >
                  {pinned ? (
                    <span className="er-stage-grip" aria-hidden />
                  ) : (
                    <svg className="er-stage-grip" width="12" height="20" viewBox="0 0 12 20" aria-hidden>
                      {[4, 10, 16].map((y) => (
                        <Fragment key={y}>
                          <circle cx="3" cy={y} r="1.5" fill="#8FB3C4" />
                          <circle cx="9" cy={y} r="1.5" fill="#8FB3C4" />
                        </Fragment>
                      ))}
                    </svg>
                  )}
                  <span className="er-stage-swatch" style={{ background: STAGE_COLOURS[item.kind] }} aria-hidden />
                  <button type="button" className="er-stage-name" aria-pressed={item.id === stage?.id}>
                    <strong>{item.name}</strong>
                    <span>{subtitle(item)}</span>
                  </button>
                  {item.kind === 'ci' && (
                    <span onClick={(event) => event.stopPropagation()} style={{ marginLeft: 4 }}>
                      <Switch label={item.enabled ? 'On' : 'Off'} checked={item.enabled} onChange={(enabled) => update({ ...item, enabled })} />
                    </span>
                  )}
                </li>
              </Fragment>
            )
          })}
          <li onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, stages.length - 1)}>
            <button type="button" className="er-btn er-btn-dashed er-btn-sm" aria-expanded={adding === stages.length} onClick={() => setAdding(adding === stages.length ? null : stages.length)}>
              + Add stage
            </button>
          </li>
        </ol>
        {adding !== null && <AddStageMenu stages={stages} onPick={(template) => insertAt(adding, template)} onCancel={() => setAdding(null)} />}
        <span className="muted" style={{ fontSize: 13 }}>
          Drag stages by the handle to reorder them. Use + between two stages to insert one. Plan always comes first and Watch CI last. The Board has a column for each stage.
        </span>
      </section>

      {stage && (
        <StageEditor
          key={stage.id}
          stage={stage}
          stages={stages}
          crew={crew}
          onChange={update}
          onMove={(by) => {
            const index = stages.indexOf(stage)
            setStages(moveStage(stages, index, index + by))
          }}
          onRemove={() => {
            setStages(stages.filter((item) => item.id !== stage.id))
            setSelected('plan')
          }}
        />
      )}

      {history && <PipelineHistory key={loaded.version} projectId={project.id} current={loaded.stages} crew={crew} dirty={dirty} onRestored={reload} />}

      {problems.length > 0 && <span className="error-text">{problems.join('. ')}</span>}
      {(save.error || saveAndNext.error) && <span className="error-text">{save.error ?? saveAndNext.error}</span>}

      <SetupFooter
        project={project}
        step="pipeline"
        disabled={problems.length > 0 || save.pending || saveAndNext.pending}
        onNext={() => void saveAndNext.run()}
        extra={
          <>
            <span className="muted" style={{ fontSize: 13 }}>
              Version {loaded.version}
              {dirty ? ' · saving makes a new version' : ''}
              {older > 0 ? ` · ${older} ticket${older === 1 ? '' : 's'} still on older versions` : ''}
            </span>
            <button type="button" className="er-btn er-btn-ghost" aria-expanded={history} onClick={() => setHistory(!history)}>
              {history ? 'Hide history' : 'History'}
            </button>
            {dirty && (
              <button type="button" className="er-btn" disabled={problems.length > 0 || save.pending} onClick={() => void save.run()}>
                Save
              </button>
            )}
          </>
        }
      />
    </>
  )
}
