import type { AdapterId } from '@shared/agent'
import { robotFromSeed, type Palette, type RobotParts } from '@shared/robot'
import type { CrewStats } from '@shared/crew'
import type { CrewMember } from '@shared/runs'
import type { Db } from '../db'

/** The first seed at or after `start` whose robot has the given palette, so default crew keep their colours. */
export function seedWithPalette(palette: Palette, start = 1): number {
  for (let seed = start; seed < start + 100_000; seed++) {
    if (robotFromSeed(seed).palette === palette) return seed
  }
  return start
}

const DEFAULTS: { name: string; role: CrewMember['role']; palette: Palette; model: Record<AdapterId, string> }[] = [
  { name: 'Ember', role: 'Planner', palette: 'ember', model: { 'claude-code': 'claude-opus-5-5', cursor: 'auto' } },
  { name: 'Rivet', role: 'Builder', palette: 'teal', model: { 'claude-code': 'claude-sonnet-5-5', cursor: 'auto' } },
  { name: 'Anvil', role: 'Reviewer', palette: 'periwinkle', model: { 'claude-code': 'claude-opus-5-5', cursor: 'auto' } },
  { name: 'Ingot', role: 'Shipper', palette: 'brass', model: { 'claude-code': 'claude-sonnet-5-5', cursor: 'auto' } }
]

interface CrewRow {
  id: number
  name: string
  role: CrewMember['role']
  adapter: AdapterId
  model: string
  seed: number
  parts: string
}

function toMember(row: CrewRow): CrewMember {
  const parts = JSON.parse(row.parts || '{}') as Partial<RobotParts>
  return { id: row.id, name: row.name, role: row.role, adapter: row.adapter, model: row.model, seed: row.seed, ...(Object.keys(parts).length ? { parts } : {}) }
}

export class CrewStore {
  constructor(private readonly db: Db) {}

  list(): CrewMember[] {
    return (this.db.prepare('SELECT * FROM crew ORDER BY id').all() as CrewRow[]).map(toMember)
  }

  get(id: number): CrewMember {
    const row = this.db.prepare('SELECT * FROM crew WHERE id = ?').get(id) as CrewRow | undefined
    if (!row) throw new Error(`Crew member ${id} not found`)
    return toMember(row)
  }

  byRole(role: CrewMember['role']): CrewMember | undefined {
    const row = this.db.prepare('SELECT * FROM crew WHERE role = ? ORDER BY id LIMIT 1').get(role) as CrewRow | undefined
    return row ? toMember(row) : undefined
  }

  /** Creates Ember, Rivet, Anvil and Ingot on the installed agent, once, when there's no crew yet. */
  ensureDefaults(adapter: AdapterId): CrewMember[] {
    if (this.list().length > 0) return this.list()
    const insert = this.db.prepare('INSERT INTO crew (name, role, adapter, model, seed) VALUES (?, ?, ?, ?, ?)')
    this.db.transaction(() => {
      DEFAULTS.forEach((member, index) => insert.run(member.name, member.role, adapter, member.model[adapter], seedWithPalette(member.palette, 1 + index * 1000)))
    })()
    return this.list()
  }

  create(member: Omit<CrewMember, 'id'>): CrewMember {
    const result = this.db.prepare('INSERT INTO crew (name, role, adapter, model, seed, parts) VALUES (?, ?, ?, ?, ?, ?)').run(member.name.trim(), member.role, member.adapter, member.model, member.seed >>> 0, JSON.stringify(member.parts ?? {}))
    return this.get(Number(result.lastInsertRowid))
  }

  update(id: number, patch: Partial<Omit<CrewMember, 'id'>>): CrewMember {
    const next = { ...this.get(id), ...patch }
    this.db.prepare('UPDATE crew SET name = ?, role = ?, adapter = ?, model = ?, seed = ?, parts = ? WHERE id = ?').run(next.name.trim(), next.role, next.adapter, next.model, next.seed >>> 0, JSON.stringify(next.parts ?? {}), id)
    return this.get(id)
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM crew WHERE id = ?').run(id)
  }
}

/** What each crew member has done: tickets shipped (now Done), runs and spend. */
export function crewStats(db: Db): CrewStats[] {
  return db
    .prepare(
      `SELECT r.crew_id AS crewId, COUNT(DISTINCT CASE WHEN t.stage = 'done' THEN t.id END) AS shipped, COUNT(r.id) AS runs, COALESCE(SUM(r.cost_usd), 0) AS costUsd
       FROM runs r LEFT JOIN tickets t ON t.id = r.ticket_id
       WHERE r.crew_id IS NOT NULL
       GROUP BY r.crew_id`
    )
    .all() as CrewStats[]
}
