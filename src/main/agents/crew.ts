import type { AdapterId } from '@shared/agent'
import { robotFromSeed, type Palette } from '@shared/robot'
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
}

function toMember(row: CrewRow): CrewMember {
  return { id: row.id, name: row.name, role: row.role, adapter: row.adapter, model: row.model, seed: row.seed }
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
    const result = this.db.prepare('INSERT INTO crew (name, role, adapter, model, seed) VALUES (?, ?, ?, ?, ?)').run(member.name.trim(), member.role, member.adapter, member.model, member.seed >>> 0)
    return this.get(Number(result.lastInsertRowid))
  }

  update(id: number, patch: Partial<Omit<CrewMember, 'id'>>): CrewMember {
    const next = { ...this.get(id), ...patch }
    this.db.prepare('UPDATE crew SET name = ?, role = ?, adapter = ?, model = ?, seed = ? WHERE id = ?').run(next.name.trim(), next.role, next.adapter, next.model, next.seed >>> 0, id)
    return this.get(id)
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM crew WHERE id = ?').run(id)
  }
}
