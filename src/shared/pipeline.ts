import { BUILD_PROMPT, CI_FIX_PROMPT, PLAN_PROMPT, PR_PROMPT, REVIEW_PROMPT } from './prompts'
import type { CrewMember } from './runs'

export type StageKind = 'plan' | 'build' | 'review' | 'pr' | 'ci' | 'custom'

export type DoneWhen = 'approval' | 'agent-finishes' | 'command' | 'review-pass' | 'prs-ready' | 'prs-merged' | 'prs-green'

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
  onFailure?: { returnTo: string; maxLoops: number }
  before: StageAction[]
  after: StageAction[]
  /** Linear workflow state to set when a ticket enters the stage. */
  linearState?: string | null
  ci?: CiSettings
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
  onAttemptsExhausted: { flagAndNotify: true, commentOnPr: true }
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

/** Problems that stop a pipeline being saved. */
export function validatePipeline(stages: StageConfig[]): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const stage of stages) {
    if (ids.has(stage.id)) problems.push(`Two stages share the id ${stage.id}`)
    ids.add(stage.id)
    if (!stage.name.trim()) problems.push('Every stage needs a name')
    if (stage.kind !== 'ci' && !stage.goal.trim()) problems.push(`${stage.name} has no goal`)
    if (stage.onFailure && !ids.has(stage.onFailure.returnTo) && !stages.some((other) => other.id === stage.onFailure?.returnTo)) {
      problems.push(`${stage.name} returns to a stage that doesn't exist`)
    }
  }
  const kinds = stages.map((stage) => stage.kind)
  if (kinds.filter((kind) => kind === 'plan').length !== 1 || kinds[0] !== 'plan') problems.push('The pipeline must start with exactly one Plan stage')
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
