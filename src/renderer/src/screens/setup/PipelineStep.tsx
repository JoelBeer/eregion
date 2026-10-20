import { useEffect, useState, type DragEvent, type ReactElement } from 'react'
import { DEFAULT_CI, defaultPipeline, isPinnedStage, moveStage, validatePipeline, type CiSettings, type DoneWhen, type StageAction, type StageConfig } from '@shared/pipeline'
import type { CrewMember } from '@shared/runs'
import { CrewAvatar } from '../../components/RobotAvatar'
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
  'review-pass': 'The review passes, then you approve it',
  'prs-ready': 'The pull requests are open',
  'prs-merged': 'The pull requests are merged',
  'prs-green': 'Every required check is green'
}

const ROLES: CrewMember['role'][] = ['Planner', 'Builder', 'Reviewer', 'Shipper']

function hasAction(stage: StageConfig, type: StageAction['type']): boolean {
  return stage.after.some((action) => action.type === type)
}

function toggleAction(stage: StageConfig, action: StageAction, on: boolean): StageConfig {
  const rest = stage.after.filter((item) => item.type !== action.type)
  return { ...stage, after: on ? [...rest, action] : rest }
}

function newCustomStage(stages: StageConfig[]): StageConfig {
  let n = 1
  while (stages.some((stage) => stage.id === `custom-${n}`)) n++
  return {
    id: `custom-${n}`,
    name: 'New stage',
    kind: 'custom',
    enabled: true,
    crewRole: 'Builder',
    crewId: null,
    mode: 'autonomous',
    workspace: 'ticket-worktrees',
    goal: '',
    outputs: [],
    doneWhen: 'agent-finishes',
    before: [],
    after: [],
    linearState: null
  }
}

function CrewPicker({ stage, crew, onChange }: { stage: StageConfig; crew: CrewMember[]; onChange: (stage: StageConfig) => void }): ReactElement {
  const value = stage.crewId !== null ? `id:${stage.crewId}` : `role:${stage.crewRole ?? 'Builder'}`
  return (
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
            <option key={role} value={`role:${role}`}>
              Whoever is the {role}
              {holder ? ` (${holder.name})` : ''}
            </option>
          )
        })}
      </optgroup>
      <optgroup label="Always">
        {crew.map((member) => (
          <option key={member.id} value={`id:${member.id}`}>
            {member.name} · {member.model}
          </option>
        ))}
      </optgroup>
    </select>
  )
}

function CiEditor({ ci, onChange }: { ci: CiSettings; onChange: (ci: CiSettings) => void }): ReactElement {
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
      </div>
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
  const doneOptions: DoneWhen[] = stage.kind === 'custom' ? ['agent-finishes', 'approval', 'command'] : stage.kind === 'ci' ? ['prs-merged', 'prs-green'] : [stage.doneWhen]
  const earlier = stages.slice(0, stages.indexOf(stage)).filter((item) => item.kind !== 'plan')
  return (
    <section className="panel" aria-label={`${stage.name} settings`}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input className="input" aria-label="Stage name" style={{ width: 220, fontWeight: 600 }} value={stage.name} onChange={(event) => onChange({ ...stage, name: event.target.value })} />
        <span className="muted" style={{ fontSize: 13 }}>
          {KIND_LABELS[stage.kind]} stage
        </span>
        <div style={{ flex: 1 }} />
        {!isPinnedStage(stage) && (
          <>
            <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => onMove(-1)} disabled={stages.indexOf(stage) <= 1}>
              ← Move earlier
            </button>
            <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => onMove(1)} disabled={stages.indexOf(stage) >= stages.length - (stages.at(-1)?.kind === 'ci' ? 2 : 1)}>
              Move later →
            </button>
          </>
        )}
        {stage.kind === 'ci' && <Switch label="On" checked={stage.enabled} onChange={(enabled) => onChange({ ...stage, enabled })} />}
        {stage.kind === 'custom' && (
          <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={onRemove}>
            Remove stage
          </button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '160px minmax(0, 1fr)', gap: '10px 12px', alignItems: 'center' }}>
        <span className="muted">Who runs it</span>
        <CrewPicker stage={stage} crew={crew} onChange={onChange} />

        {stage.kind === 'custom' && (
          <>
            <span className="muted">Works in</span>
            <select className="select" aria-label="Works in" value={stage.workspace} onChange={(event) => onChange({ ...stage, workspace: event.target.value as StageConfig['workspace'] })}>
              <option value="ticket-worktrees">The ticket's worktrees (can change code)</option>
              <option value="plan-checkout">The shared read-only checkout</option>
            </select>
            <span className="muted">Files it writes</span>
            <input
              className="input mono"
              aria-label="Files it writes"
              placeholder="notes.md, report.json"
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

        {stage.kind === 'review' && (
          <>
            <span className="muted">If it fails</span>
            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              back to
              <select
                className="select"
                aria-label="Return to"
                value={stage.onFailure?.returnTo ?? 'build'}
                onChange={(event) => onChange({ ...stage, onFailure: { maxLoops: stage.onFailure?.maxLoops ?? 2, returnTo: event.target.value } })}
              >
                {earlier.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              at most
              <input
                className="input"
                type="number"
                min={1}
                max={10}
                aria-label="Loops"
                style={{ width: 70 }}
                value={stage.onFailure?.maxLoops ?? 2}
                onChange={(event) => onChange({ ...stage, onFailure: { returnTo: stage.onFailure?.returnTo ?? 'build', maxLoops: Math.min(10, Math.max(1, Number(event.target.value) || 2)) } })}
              />
              times, then stop and ask me
            </span>
          </>
        )}

      </div>

      {stage.kind !== 'pr' && stage.kind !== 'ci' && stage.kind !== 'plan' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="muted" style={{ fontSize: 13 }}>
            Afterwards
          </span>
          {stage.kind === 'build' && (
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
          Eregion adds the ticket, the workspace and the output format around this. Variables like <span className="mono">{'{{ticket.key}}'}</span> work here.
        </span>
      </div>
    </section>
  )
}

export function PipelineStep({ project, next }: StepProps): ReactElement {
  const crew = useCrew()
  const [loaded, setLoaded] = useState<{ version: number; stages: StageConfig[]; olderVersions: { version: number; tickets: number }[] }>()
  const [stages, setStages] = useState<StageConfig[]>([])
  const [selected, setSelected] = useState('plan')
  const [dragging, setDragging] = useState<number | null>(null)
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
  }
  const crewFor = (item: StageConfig): CrewMember | undefined => crew.find((member) => member.id === item.crewId) ?? crew.find((member) => member.role === item.crewRole)
  const older = loaded.olderVersions.reduce((sum, item) => sum + item.tickets, 0)

  return (
    <>
      <section className="panel" aria-label="Stages">
        <div role="list" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {stages.map((item, index) => {
            const member = crewFor(item)
            return (
              <div
                key={item.id}
                role="listitem"
                draggable={!isPinnedStage(item)}
                onDragStart={() => setDragging(index)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => drop(event, index)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: dragging === index ? 0.4 : item.enabled ? 1 : 0.55 }}
              >
                {index > 0 && (
                  <span aria-hidden className="muted" style={{ marginRight: 4 }}>
                    →
                  </span>
                )}
                <button type="button" aria-pressed={item.id === stage?.id} onClick={() => setSelected(item.id)} className={`er-btn${item.id === stage?.id ? ' er-btn-primary' : ''}`} style={{ cursor: isPinnedStage(item) ? 'pointer' : 'grab', gap: 8 }}>
                  {member && <CrewAvatar member={member} size={20} />}
                  {item.name}
                  {!item.enabled && <span style={{ fontSize: 11 }}>off</span>}
                </button>
              </div>
            )
          })}
          <button
            type="button"
            className="er-btn er-btn-ghost er-btn-sm"
            onClick={() => {
              const added = newCustomStage(stages)
              const at = stages.findIndex((item) => item.kind === 'pr' || item.kind === 'ci')
              const copy = [...stages]
              copy.splice(at >= 0 ? at : copy.length, 0, added)
              setStages(copy)
              setSelected(added.id)
            }}
          >
            + Add a stage
          </button>
        </div>
        <span className="muted" style={{ fontSize: 13 }}>
          Drag stages to reorder them. Plan always comes first and Watch CI last. The Board has a column for each stage.
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
