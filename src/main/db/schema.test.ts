import { describe, expect, it } from 'vitest'
import { getSetting, migrate, openDatabase, setSetting } from '.'
import { migrations } from './schema'

describe('database', () => {
  it('creates every table and records the schema version', () => {
    const db = openDatabase(':memory:')
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name)
    expect(tables).toEqual(
      expect.arrayContaining(['settings', 'projects', 'repos', 'steps', 'services', 'pipelines', 'crew', 'tickets', 'chats', 'runs', 'events', 'messages', 'pull_requests', 'ci_attempts'])
    )
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length)
  })

  it('does nothing when migrated twice', () => {
    const db = openDatabase(':memory:')
    expect(() => migrate(db)).not.toThrow()
  })

  it('enforces foreign keys and cascades deletes from a project', () => {
    const db = openDatabase(':memory:')
    const project = db.prepare("INSERT INTO projects (name, initials, color) VALUES ('Word Magic', 'WM', '#F2D06B')").run()
    db.prepare("INSERT INTO repos (project_id, name, path, runtime) VALUES (?, 'word-magic', '/home/joel/sites/word-magic', 'native')").run(project.lastInsertRowid)
    expect(() => db.prepare("INSERT INTO repos (project_id, name, path, runtime) VALUES (999, 'x', '/x', 'native')").run()).toThrow()
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.lastInsertRowid)
    expect(db.prepare('SELECT COUNT(*) AS n FROM repos').get()).toEqual({ n: 0 })
  })

  it('rejects a stop reason that the board does not know', () => {
    const db = openDatabase(':memory:')
    const project = db.prepare("INSERT INTO projects (name, initials, color) VALUES ('P', 'P', '#000')").run()
    expect(() =>
      db.prepare("INSERT INTO tickets (project_id, key, title, stop_reason) VALUES (?, 'P-1', 't', 'bored')").run(project.lastInsertRowid)
    ).toThrow()
  })

  it('stores settings as JSON', () => {
    const db = openDatabase(':memory:')
    expect(getSetting(db, 'linear.import', { mode: 'me' })).toEqual({ mode: 'me' })
    setSetting(db, 'linear.import', { mode: 'people', ids: ['a', 'b'] })
    setSetting(db, 'linear.import', { mode: 'person', ids: ['a'] })
    expect(getSetting(db, 'linear.import', null)).toEqual({ mode: 'person', ids: ['a'] })
  })
})
