import { stageAccess, type StageAction, type StageConfig } from './pipeline'

export interface PipelineVersionSummary {
  version: number
  createdAt: string
  /** Unfinished tickets that started on this version. */
  tickets: number
  stageNames: string[]
}

export interface LineChange {
  kind: 'same' | 'added' | 'removed'
  text: string
}

export interface FieldChange {
  label: string
  /** The value now. */
  now: string
  /** The value restoring would bring back. */
  then: string
}

export interface StageChange {
  stageId: string
  name: string
  /** What restoring the older version would do to this stage. */
  change: 'added' | 'removed' | 'changed' | 'same'
  moved: boolean
  fields: FieldChange[]
  /** A line diff of the prompt, when it differs. */
  prompt: LineChange[] | null
}

/** A line diff (longest common subsequence), for prompts of a few dozen lines. */
export function diffLines(now: string, then: string): LineChange[] {
  const a = now.split('\n')
  const b = then.split('\n')
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  }
  const lines: LineChange[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) lines.push({ kind: 'removed', text: a[i++] })
    else lines.push({ kind: 'added', text: b[j++] })
  }
  while (i < a.length) lines.push({ kind: 'removed', text: a[i++] })
  while (j < b.length) lines.push({ kind: 'added', text: b[j++] })
  return lines
}

const ACTION_LABELS: Record<StageAction['type'], string> = { commit: 'commit', push: 'push', 'start-services': 'start services', 'stop-services': 'stop services', notify: 'notify', run: 'run' }

function describe(stage: StageConfig, crewName: (stage: StageConfig) => string): Record<string, string> {
  return {
    Name: stage.name,
    'Who runs it': crewName(stage),
    'Works in': stage.workspace === 'plan-checkout' ? 'read-only checkout' : "ticket's worktrees",
    Changes: stageAccess(stage) === 'changes' ? 'can change files' : 'read-only',
    'Done when': stage.doneWhen + (stage.doneCommand ? `: ${stage.doneCommand}` : ''),
    'Files it writes': stage.outputs.join(', ') || 'none',
    'If it fails': stage.onFailure ? `back to ${stage.onFailure.returnTo}, at most ${stage.onFailure.maxLoops} times` : '—',
    Afterwards: stage.after.map((action) => (action.type === 'run' ? `run ${action.command}` : ACTION_LABELS[action.type])).join(', ') || 'nothing',
    On: stage.enabled ? 'yes' : 'no',
    'CI settings': stage.ci ? JSON.stringify(stage.ci) : '—',
    ...(stage.kind === 'plan' ? { 'Writes a spec': stage.spec === false ? 'no' : 'yes' } : {})
  }
}

/**
 * What restoring `then` (an older version) would change in `now` (the latest), stage by stage:
 * stages it brings back or drops, settings it changes, prompt lines, and stages that move.
 */
export function diffPipelines(now: StageConfig[], then: StageConfig[], crewName: (stage: StageConfig) => string = (stage) => stage.crewRole ?? 'anyone'): StageChange[] {
  const changes: StageChange[] = []
  const nowIds = now.map((stage) => stage.id)
  const thenIds = then.map((stage) => stage.id)
  const common = nowIds.filter((id) => thenIds.includes(id))
  const commonThen = thenIds.filter((id) => nowIds.includes(id))
  for (const stage of then) {
    const current = now.find((item) => item.id === stage.id)
    if (!current) {
      changes.push({ stageId: stage.id, name: stage.name, change: 'added', moved: false, fields: [], prompt: null })
      continue
    }
    const before = describe(current, crewName)
    const after = describe(stage, crewName)
    const fields = Object.keys(before)
      .filter((label) => before[label] !== after[label])
      .map((label) => ({ label, now: before[label], then: after[label] }))
    const prompt = current.goal === stage.goal ? null : diffLines(current.goal, stage.goal)
    changes.push({
      stageId: stage.id,
      name: stage.name,
      change: fields.length > 0 || prompt ? 'changed' : 'same',
      moved: common.indexOf(stage.id) !== commonThen.indexOf(stage.id),
      fields,
      prompt
    })
  }
  for (const stage of now) {
    if (!thenIds.includes(stage.id)) changes.push({ stageId: stage.id, name: stage.name, change: 'removed', moved: false, fields: [], prompt: null })
  }
  return changes
}
