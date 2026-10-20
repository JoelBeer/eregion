import { useState, type ReactElement } from 'react'
import type { StageConfig } from '@shared/pipeline'
import { diffPipelines, type StageChange } from '@shared/pipelineDiff'
import type { CrewMember } from '@shared/runs'
import { StatusPill } from '../../components/ui'
import { useAction, useQuery } from '../../hooks'

const CHANGE_LABELS: Record<StageChange['change'], string> = {
  added: 'Brings this stage back',
  removed: 'Removes this stage',
  changed: 'Changes this stage',
  same: 'No change'
}

function StageDiff({ change, onUseStage }: { change: StageChange; onUseStage: (() => void) | null }): ReactElement {
  const [showPrompt, setShowPrompt] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--divider-100)', paddingTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong>{change.name}</strong>
        <StatusPill status={change.change === 'removed' ? 'failed' : change.change === 'added' ? 'passed' : 'info'}>{CHANGE_LABELS[change.change]}</StatusPill>
        {change.moved && <span className="muted" style={{ fontSize: 13 }}>and moves it</span>}
        <div style={{ flex: 1 }} />
        {onUseStage && (
          <button type="button" className="er-btn er-btn-sm" onClick={onUseStage}>
            Use this stage's settings
          </button>
        )}
      </div>
      {change.fields.map((field) => (
        <div key={field.label} style={{ display: 'grid', gridTemplateColumns: '140px minmax(0, 1fr)', gap: 8, fontSize: 13 }}>
          <span className="muted">{field.label}</span>
          <span>
            <span style={{ textDecoration: 'line-through', color: 'var(--red-700, #B42318)' }}>{field.now}</span> → <span style={{ color: 'var(--primary-700)' }}>{field.then}</span>
          </span>
        </div>
      ))}
      {change.prompt && (
        <>
          <button type="button" className="er-btn er-btn-sm er-btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setShowPrompt(!showPrompt)}>
            {showPrompt ? 'Hide' : 'Show'} the prompt changes ({change.prompt.filter((line) => line.kind !== 'same').length} lines)
          </button>
          {showPrompt && (
            <pre className="mono" style={{ margin: 0, padding: '10px 12px', background: 'var(--forge-900)', borderRadius: 8, fontSize: 12, overflowX: 'auto', maxHeight: 320 }}>
              {change.prompt.map((line, index) => (
                <div key={index} style={{ color: line.kind === 'added' ? 'var(--term-add, #9FE8D8)' : line.kind === 'removed' ? 'var(--term-del, #FFB4A8)' : 'var(--term-text, #D6ECEF)', opacity: line.kind === 'same' ? 0.6 : 1 }}>
                  {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
                  {line.text || ' '}
                </div>
              ))}
            </pre>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Every saved pipeline version, and what bringing one back would change. Restoring saves it as a
 * new version: history stays in order and tickets already running keep the version they started on.
 */
export function PipelineHistory({ projectId, current, crew, dirty, onRestored }: { projectId: number; current: StageConfig[]; crew: CrewMember[]; dirty: boolean; onRestored: () => void }): ReactElement {
  const versions = useQuery(() => window.eregion.listPipelineVersions(projectId), [projectId])
  const latest = versions.data?.[0]?.version
  const [selected, setSelected] = useState<number | null>(null)
  const older = useQuery(() => (selected ? window.eregion.getPipelineVersion(projectId, selected) : Promise.resolve(null)), [projectId, selected])
  const crewName = (stage: StageConfig): string => crew.find((member) => member.id === stage.crewId)?.name ?? `whoever is the ${stage.crewRole ?? 'Builder'}`
  const changes = older.data ? diffPipelines(current, older.data.stages, crewName) : []
  const confirmed = (): boolean => !dirty || window.confirm('Your unsaved changes to the pipeline will be lost. Carry on?')
  const restore = useAction(async () => {
    if (!selected || !confirmed()) return
    await window.eregion.restorePipelineVersion(projectId, selected)
    onRestored()
  })
  const useStage = useAction(async (stageId: string) => {
    if (!selected || !confirmed()) return
    await window.eregion.restorePipelineStage(projectId, selected, stageId)
    onRestored()
  })
  return (
    <section className="panel" aria-label="Pipeline history">
      <h2 style={{ fontSize: 17 }}>History</h2>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {versions.data?.map((item) => (
          <button
            key={item.version}
            type="button"
            className={`er-btn er-btn-sm${item.version === selected ? ' er-btn-primary' : ''}`}
            disabled={item.version === latest}
            onClick={() => setSelected(item.version)}
            title={item.stageNames.join(' → ')}
          >
            Version {item.version}
            {item.version === latest ? ' · current' : ''} · {new Date(`${item.createdAt.replace(' ', 'T')}Z`).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
            {item.tickets > 0 ? ` · ${item.tickets} ${item.tickets === 1 ? 'ticket' : 'tickets'}` : ''}
          </button>
        ))}
      </div>
      {versions.data?.length === 1 && <span className="muted">There's only one version so far. Each Save keeps the one before.</span>}
      {selected && older.data && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span>
              Restoring version {selected} would {changes.every((change) => change.change === 'same' && !change.moved) ? 'change nothing.' : 'make these changes:'}
            </span>
            <div style={{ flex: 1 }} />
            <button type="button" className="er-btn er-btn-primary er-btn-sm" disabled={restore.pending} onClick={() => void restore.run()}>
              Restore version {selected}
            </button>
          </div>
          {changes
            .filter((change) => change.change !== 'same' || change.moved)
            .map((change) => (
              <StageDiff key={change.stageId} change={change} onUseStage={change.change === 'changed' || change.change === 'added' ? () => void useStage.run(change.stageId) : null} />
            ))}
          <span className="muted" style={{ fontSize: 13 }}>
            Either way it's saved as a new version, so nothing is lost, and tickets already under way keep the version they started on.
          </span>
        </>
      )}
      {(restore.error || useStage.error) && <span className="error-text">{restore.error ?? useStage.error}</span>}
    </section>
  )
}
