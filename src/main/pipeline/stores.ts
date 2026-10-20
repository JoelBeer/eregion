import { defaultPipeline, validatePipeline, type StageConfig } from '@shared/pipeline'
import type { PipelineVersionSummary } from '@shared/pipelineDiff'
import type { LinearData, StopReason, Ticket, TicketStatus, WaitingFor } from '@shared/tickets'
import type { Db } from '../db'

export interface PipelineVersion {
  version: number
  stages: StageConfig[]
  createdAt: string
}


/** Pipelines are versioned: tickets keep the version they started with; edits apply to new tickets. */
export class PipelineStore {
  constructor(private readonly db: Db) {}

  latest(projectId: number): PipelineVersion {
    const row = this.db.prepare('SELECT version, stages, created_at FROM pipelines WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId) as
      | { version: number; stages: string; created_at: string }
      | undefined
    if (!row) return this.save(projectId, defaultPipeline())
    return { version: row.version, stages: JSON.parse(row.stages), createdAt: row.created_at }
  }

  get(projectId: number, version: number): PipelineVersion {
    const row = this.db.prepare('SELECT version, stages, created_at FROM pipelines WHERE project_id = ? AND version = ?').get(projectId, version) as
      | { version: number; stages: string; created_at: string }
      | undefined
    if (!row) return this.latest(projectId)
    return { version: row.version, stages: JSON.parse(row.stages), createdAt: row.created_at }
  }

  save(projectId: number, stages: StageConfig[]): PipelineVersion {
    const problems = validatePipeline(stages)
    if (problems.length > 0) throw new Error(problems.join('. '))
    const next = (this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM pipelines WHERE project_id = ?').get(projectId) as { next: number }).next
    this.db.prepare('INSERT INTO pipelines (project_id, version, stages) VALUES (?, ?, ?)').run(projectId, next, JSON.stringify(stages))
    return this.get(projectId, next)
  }

  /** Every saved version, newest first, with how many unfinished tickets are on each. */
  versions(projectId: number): PipelineVersionSummary[] {
    this.latest(projectId)
    return (
      this.db
        .prepare(
          `SELECT p.version, p.created_at AS createdAt, p.stages,
             (SELECT COUNT(*) FROM tickets t WHERE t.project_id = p.project_id AND t.pipeline_version = p.version AND t.stage NOT IN ('done', 'backlog')) AS tickets
           FROM pipelines p WHERE p.project_id = ? ORDER BY p.version DESC`
        )
        .all(projectId) as { version: number; createdAt: string; stages: string; tickets: number }[]
    ).map((row) => ({ version: row.version, createdAt: row.createdAt, tickets: row.tickets, stageNames: (JSON.parse(row.stages) as StageConfig[]).map((stage) => stage.name) }))
  }

  /** Brings an older version back by saving it as a new one, so history stays in order and tickets keep theirs. */
  restore(projectId: number, version: number): PipelineVersion {
    const older = this.db.prepare('SELECT stages FROM pipelines WHERE project_id = ? AND version = ?').get(projectId, version) as { stages: string } | undefined
    if (!older) throw new Error(`There's no version ${version}`)
    return this.save(projectId, JSON.parse(older.stages) as StageConfig[])
  }

  /** Brings back one stage's settings from an older version into the latest, saved as a new version. */
  restoreStage(projectId: number, version: number, stageId: string): PipelineVersion {
    const older = this.db.prepare('SELECT stages FROM pipelines WHERE project_id = ? AND version = ?').get(projectId, version) as { stages: string } | undefined
    const stage = older ? (JSON.parse(older.stages) as StageConfig[]).find((item) => item.id === stageId) : undefined
    if (!stage) throw new Error(`Version ${version} has no stage ${stageId}`)
    const current = this.latest(projectId).stages
    const index = current.findIndex((item) => item.id === stageId)
    const stages = [...current]
    if (index >= 0) stages[index] = stage
    else stages.splice(Math.min(Math.max(stages.findIndex((item) => item.kind === 'pr' || item.kind === 'ci'), 1), stages.length), 0, stage)
    return this.save(projectId, stages)
  }

  /** How many tickets are still on each older version, for the "2 tickets on version 2" note. */
  ticketsOnOlderVersions(projectId: number): { version: number; tickets: number }[] {
    const latest = this.latest(projectId).version
    return this.db
      .prepare("SELECT pipeline_version AS version, COUNT(*) AS tickets FROM tickets WHERE project_id = ? AND pipeline_version < ? AND stage NOT IN ('done', 'backlog') GROUP BY pipeline_version")
      .all(projectId, latest) as { version: number; tickets: number }[]
  }
}

interface TicketRow {
  id: number
  project_id: number
  linear_id: string | null
  key: string
  title: string
  url: string | null
  description: string
  linear_data: string
  pipeline_version: number | null
  stage: string
  status: TicketStatus
  stop_reason: StopReason | null
  stop_detail: string | null
  waiting_for: WaitingFor | null
  loop: number
  review_failures: number
  extra_loops: number
  slot: number | null
  branch: string | null
  affected_repos: string
  current_run_id: number | null
  plan_approved_at: string | null
  created_at: string
  updated_at: string
}

function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    projectId: row.project_id,
    linearId: row.linear_id,
    key: row.key,
    title: row.title,
    url: row.url,
    description: row.description,
    linear: JSON.parse(row.linear_data) as LinearData,
    pipelineVersion: row.pipeline_version,
    stage: row.stage,
    status: row.status,
    stopReason: row.stop_reason,
    stopDetail: row.stop_detail,
    waitingFor: row.waiting_for,
    loop: row.loop,
    reviewFailures: row.review_failures,
    extraLoops: row.extra_loops,
    slot: row.slot,
    branch: row.branch,
    affectedRepos: JSON.parse(row.affected_repos) as string[],
    currentRunId: row.current_run_id,
    planApprovedAt: row.plan_approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export interface NewTicket {
  projectId: number
  key: string
  title: string
  description?: string
  url?: string | null
  linearId?: string | null
  linear?: LinearData
}

export type TicketPatch = Partial<Omit<Ticket, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>

const COLUMNS: Record<keyof TicketPatch, string> = {
  linearId: 'linear_id',
  key: 'key',
  title: 'title',
  url: 'url',
  description: 'description',
  linear: 'linear_data',
  pipelineVersion: 'pipeline_version',
  stage: 'stage',
  status: 'status',
  stopReason: 'stop_reason',
  stopDetail: 'stop_detail',
  waitingFor: 'waiting_for',
  loop: 'loop',
  reviewFailures: 'review_failures',
  extraLoops: 'extra_loops',
  slot: 'slot',
  branch: 'branch',
  affectedRepos: 'affected_repos',
  currentRunId: 'current_run_id',
  planApprovedAt: 'plan_approved_at'
}

export class TicketStore {
  constructor(private readonly db: Db) {}

  create(ticket: NewTicket): Ticket {
    const result = this.db
      .prepare('INSERT INTO tickets (project_id, key, title, description, url, linear_id, linear_data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ticket.projectId, ticket.key, ticket.title, ticket.description ?? '', ticket.url ?? null, ticket.linearId ?? null, JSON.stringify(ticket.linear ?? {}))
    return this.get(Number(result.lastInsertRowid))
  }

  get(id: number): Ticket {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined
    if (!row) throw new Error(`Ticket ${id} not found`)
    return toTicket(row)
  }

  findByKey(projectId: number, key: string): Ticket | null {
    const row = this.db.prepare('SELECT * FROM tickets WHERE project_id = ? AND key = ?').get(projectId, key) as TicketRow | undefined
    return row ? toTicket(row) : null
  }

  findByLinearId(projectId: number, linearId: string): Ticket | null {
    const row = this.db.prepare('SELECT * FROM tickets WHERE project_id = ? AND linear_id = ?').get(projectId, linearId) as TicketRow | undefined
    return row ? toTicket(row) : null
  }

  list(projectId: number): Ticket[] {
    return (this.db.prepare('SELECT * FROM tickets WHERE project_id = ? ORDER BY updated_at DESC, id DESC').all(projectId) as TicketRow[]).map(toTicket)
  }

  /** Tickets holding a slot or with a run going, across projects. */
  active(): Ticket[] {
    return (this.db.prepare("SELECT * FROM tickets WHERE status = 'running' OR slot IS NOT NULL").all() as TicketRow[]).map(toTicket)
  }

  update(id: number, patch: TicketPatch): Ticket {
    const sets: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch) as [keyof TicketPatch, unknown][]) {
      if (value === undefined) continue
      sets.push(`${COLUMNS[key]} = ?`)
      values.push(key === 'linear' || key === 'affectedRepos' ? JSON.stringify(value) : value)
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE tickets SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values, id)
    }
    return this.get(id)
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM tickets WHERE id = ?').run(id)
  }

  log(ticketId: number, kind: string, message: string): void {
    this.db.prepare('INSERT INTO ticket_log (ticket_id, kind, message) VALUES (?, ?, ?)').run(ticketId, kind, message)
  }

  logEntries(ticketId: number): { ts: string; kind: string; message: string }[] {
    return this.db.prepare('SELECT ts, kind, message FROM ticket_log WHERE ticket_id = ? ORDER BY id').all(ticketId) as { ts: string; kind: string; message: string }[]
  }

  usedSlots(projectId: number): number[] {
    return (this.db.prepare('SELECT slot FROM tickets WHERE project_id = ? AND slot IS NOT NULL').all(projectId) as { slot: number }[]).map((row) => row.slot)
  }
}
