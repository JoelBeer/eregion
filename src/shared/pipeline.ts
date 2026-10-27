import { BUILD_PROMPT, CI_FIX_PROMPT, PLAN_PROMPT, PR_PROMPT, REVIEW_PROMPT } from './prompts'
import type { CrewMember } from './runs'

/**
 * Plan, PR and Watch CI have their own behaviour. Every other stage runs the same way, set up by its
 * fields; 'build', 'review' and 'custom' only say which template it started from.
 */
export type StageKind = 'plan' | 'build' | 'review' | 'pr' | 'ci' | 'custom'

/**
 * How a stage finishes. 'verdict' and 'review-pass' read pass or fail from the stage's verdict file
 * (its first .json output); 'review-pass' then waits for you to check it too.
 */
export type DoneWhen = 'approval' | 'agent-finishes' | 'command' | 'verdict' | 'review-pass' | 'prs-ready' | 'prs-merged' | 'prs-green'

export type StageAction =
  | { type: 'commit' }
  | { type: 'push' }
  | { type: 'start-services' }
  | { type: 'stop-services' }
  | { type: 'notify' }
  | { type: 'run'; command: string }

export interface CiSettings {
  includeOptionalChecks: boolean
  notifyOnReviewComments: boolean
  intervalSec: number
  autofixForNewTickets: boolean
  maxAttempts: number
  concurrentFixes: number
  pauseOnForeignPush: boolean
  rerunFirst: boolean
  onAttemptsExhausted: { flagAndNotify: boolean; commentOnPr: boolean }
  /** Checks every ticket's Watch CI treats as passing, by name (any case): a coverage gate, say. */
  ignoreChecks: string[]
}

export interface StageConfig {
  id: string
  name: string
  kind: StageKind
  /** Only Watch CI can be switched off; other stages are removed instead. */
  enabled: boolean
  /** Who runs the stage: a crew role (the first member with it) unless crewId picks someone. */
  crewRole: CrewMember['role'] | null
  crewId: number | null
  mode: 'interactive' | 'autonomous'
  workspace: 'plan-checkout' | 'ticket-worktrees'
  /** The stage prompt (see Stage prompts in the design doc). */
  goal: string
  /** Files the stage must write in the outputs folder. */
  outputs: string[]
  doneWhen: DoneWhen
  doneCommand?: string
  /** When the work fails (a fail verdict, or the done command failing): go back to returnTo, at most maxLoops times, then stop and ask. */
  onFailure?: { returnTo: string; maxLoops: number }
  /** Whether the agent may change the ticket's files. Read-only stages have any changes thrown away. Defaults by template. */
  access?: 'changes' | 'read-only'
  before: StageAction[]
  after: StageAction[]
  /** Linear workflow state to set when a ticket enters the stage. */
  linearState?: string | null
  ci?: CiSettings
  /** Plan only: also write spec.md, the behaviour Build, Review and PR are held to. On unless switched off. */
  spec?: boolean
}

export const DEFAULT_CI: CiSettings = {
  includeOptionalChecks: false,
  notifyOnReviewComments: false,
  intervalSec: 60,
  autofixForNewTickets: true,
  maxAttempts: 3,
  concurrentFixes: 2,
  pauseOnForeignPush: true,
  rerunFirst: true,
  onAttemptsExhausted: { flagAndNotify: true, commentOnPr: true },
  ignoreChecks: []
}

/** Whether Watch CI ignores a check: the stage ignores it for every ticket, or this ticket does. */
export function checkIgnored(name: string, ticketIgnores: string[], stageIgnores: string[] = []): boolean {
  const wanted = name.trim().toLowerCase()
  return [...ticketIgnores, ...stageIgnores].some((item) => item.trim().toLowerCase() === wanted)
}

export function defaultPipeline(): StageConfig[] {
  return [
    {
      id: 'plan',
      name: 'Plan',
      kind: 'plan',
      enabled: true,
      crewRole: 'Planner',
      crewId: null,
      mode: 'interactive',
      workspace: 'plan-checkout',
      goal: PLAN_PROMPT,
      outputs: ['plan.md'],
      spec: true,
      doneWhen: 'approval',
      before: [],
      after: [],
      linearState: null
    },
    {
      id: 'build',
      name: 'Build',
      kind: 'build',
      enabled: true,
      crewRole: 'Builder',
      crewId: null,
      mode: 'autonomous',
      workspace: 'ticket-worktrees',
      goal: BUILD_PROMPT,
      outputs: ['build-notes.md'],
      doneWhen: 'agent-finishes',
      before: [],
      after: [{ type: 'commit' }, { type: 'push' }],
      linearState: null
    },
    {
      id: 'review',
      name: 'Review',
      kind: 'review',
      enabled: true,
      crewRole: 'Reviewer',
      crewId: null,
      mode: 'autonomous',
      workspace: 'ticket-worktrees',
      goal: REVIEW_PROMPT,
      outputs: ['review.json'],
      doneWhen: 'review-pass',
      onFailure: { returnTo: 'build', maxLoops: 2 },
      access: 'read-only',
      before: [],
      after: [{ type: 'notify' }],
      linearState: null
    },
    {
      id: 'pr',
      name: 'PR',
      kind: 'pr',
      enabled: true,
      crewRole: 'Shipper',
      crewId: null,
      mode: 'autonomous',
      workspace: 'ticket-worktrees',
      goal: PR_PROMPT,
      outputs: [],
      doneWhen: 'prs-ready',
      before: [],
      after: [],
      linearState: null
    },
    {
      id: 'ci',
      name: 'Watch CI',
      kind: 'ci',
      enabled: true,
      crewRole: 'Builder',
      crewId: null,
      mode: 'autonomous',
      workspace: 'ticket-worktrees',
      goal: CI_FIX_PROMPT,
      outputs: ['ci-fix.json'],
      doneWhen: 'prs-merged',
      before: [],
      after: [],
      linearState: null,
      ci: DEFAULT_CI
    }
  ]
}

/** Whether the pipeline's Plan stage writes a spec beside the plan. Pipelines from before the setting do. */
export function writesSpec(stages: StageConfig[]): boolean {
  const plan = stages.find((stage) => stage.kind === 'plan')
  return Boolean(plan) && plan?.spec !== false
}

export function activeStages(stages: StageConfig[]): StageConfig[] {
  return stages.filter((stage) => stage.enabled)
}

/** The stage after `stageId`, skipping switched-off stages; null after the last one. */
export function nextStage(stages: StageConfig[], stageId: string): StageConfig | null {
  const active = activeStages(stages)
  const index = active.findIndex((stage) => stage.id === stageId)
  return index >= 0 ? (active[index + 1] ?? null) : (active[0] ?? null)
}

export function stageById(stages: StageConfig[], stageId: string): StageConfig | undefined {
  return stages.find((stage) => stage.id === stageId)
}

/** Stages set up entirely by their fields: everything but Plan, PR and Watch CI. */
export function isGenericStage(stage: StageConfig): boolean {
  return stage.kind !== 'plan' && stage.kind !== 'pr' && stage.kind !== 'ci'
}

/** Whether the stage may change the ticket's files. A stage on the plan checkout never does. */
export function stageAccess(stage: StageConfig): 'changes' | 'read-only' {
  if (stage.workspace === 'plan-checkout') return 'read-only'
  return stage.access ?? (stage.kind === 'review' ? 'read-only' : 'changes')
}

/** Done-whens that read a verdict, and the file it's read from: the stage's first .json output. */
export function readsVerdict(stage: StageConfig): boolean {
  return stage.doneWhen === 'verdict' || stage.doneWhen === 'review-pass'
}

export function verdictFile(stage: StageConfig): string | null {
  return readsVerdict(stage) ? (stage.outputs.find((output) => output.endsWith('.json')) ?? null) : null
}

/** Done-whens where the work can fail, so an on-fail loop applies. */
export function canFail(stage: StageConfig): boolean {
  return readsVerdict(stage) || stage.doneWhen === 'command'
}

/**
 * Where "send it back" goes from a stage you're checking: where its failed work would go, or else the
 * nearest earlier stage that changes files.
 */
export function sendBackTarget(stages: StageConfig[], stageId: string): StageConfig | undefined {
  const index = stages.findIndex((stage) => stage.id === stageId)
  const current = stages[index]
  const onFailure = current?.onFailure ? stageById(stages, current.onFailure.returnTo) : undefined
  return (
    onFailure ??
    stages
      .slice(0, Math.max(index, 0))
      .reverse()
      .find((stage) => isGenericStage(stage) && stageAccess(stage) === 'changes')
  )
}

export type StageTemplate = 'build' | 'review' | 'pr' | 'custom'

/**
 * A new stage from a template (Build, Review, Pull requests, or a blank one) to go in at `at`, with an id no
 * other stage has. A Review goes back to the nearest earlier stage that changes files.
 */
export function stageFromTemplate(template: StageTemplate, stages: StageConfig[], at: number): StageConfig {
  const taken = (id: string): boolean => stages.some((stage) => stage.id === id)
  let id = template === 'custom' ? 'custom-1' : template
  for (let n = 2; taken(id); n++) id = `${template}-${n}`
  const base = template === 'custom' ? null : defaultPipeline().find((stage) => stage.kind === template)
  if (base) {
    const returnTo = stages
      .slice(0, at)
      .reverse()
      .find((stage) => isGenericStage(stage) && stageAccess(stage) === 'changes')
    return { ...structuredClone(base), id, onFailure: base.onFailure && returnTo ? { ...base.onFailure, returnTo: returnTo.id } : undefined }
  }
  return {
    id,
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

/** Problems that stop a pipeline being saved. */
export function validatePipeline(stages: StageConfig[]): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  stages.forEach((stage, index) => {
    if (ids.has(stage.id)) problems.push(`Two stages share the id ${stage.id}`)
    ids.add(stage.id)
    if (!stage.name.trim()) problems.push('Every stage needs a name')
    if (stage.kind !== 'ci' && !stage.goal.trim()) problems.push(`${stage.name} has no goal`)
    if (readsVerdict(stage) && !verdictFile(stage)) problems.push(`${stage.name} reads a verdict, so it needs a .json output to write it in`)
    if (stage.doneWhen === 'command' && !stage.doneCommand?.trim()) problems.push(`${stage.name} is done when a command passes, but has no command`)
    if (stage.onFailure) {
      const target = stages.findIndex((other) => other.id === stage.onFailure?.returnTo)
      if (target < 0) problems.push(`${stage.name} goes back to a stage that doesn't exist`)
      else if (target > index) problems.push(`${stage.name} can only go back to an earlier stage`)
      else if (!isGenericStage(stages[target])) problems.push(`${stage.name} can't go back to ${stages[target].name}`)
    }
  })
  const kinds = stages.map((stage) => stage.kind)
  if (kinds.filter((kind) => kind === 'plan').length !== 1 || kinds[0] !== 'plan') problems.push('The pipeline must start with exactly one Plan stage')
  if (kinds.filter((kind) => kind === 'pr').length > 1) problems.push('There can only be one Pull requests stage')
  if (kinds.filter((kind) => kind === 'ci').length > 1) problems.push('There can only be one Watch CI stage')
  if (kinds.includes('ci') && kinds.at(-1) !== 'ci') problems.push('Watch CI must be the last stage')
  return problems
}

/** Stages that can't be moved: Plan stays first, Watch CI stays last. */
export function isPinnedStage(stage: StageConfig): boolean {
  return stage.kind === 'plan' || stage.kind === 'ci'
}

/** Moves the stage at `from` to position `to`, keeping Plan first and Watch CI last. */
export function moveStage(stages: StageConfig[], from: number, to: number): StageConfig[] {
  if (from === to || !stages[from] || isPinnedStage(stages[from])) return stages
  const first = stages[0]?.kind === 'plan' ? 1 : 0
  const last = stages.at(-1)?.kind === 'ci' ? stages.length - 2 : stages.length - 1
  const target = Math.min(Math.max(to, first), last)
  const next = [...stages]
  const [moved] = next.splice(from, 1)
  next.splice(target, 0, moved)
  return next
}
