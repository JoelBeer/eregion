import Database from 'better-sqlite3'
import { migrations } from './schema'

export type Db = Database.Database

/** Opens (or creates) the database and brings its schema up to date. Pass ':memory:' in tests. */
export function openDatabase(file: string): Db {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

export function migrate(db: Db): number {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let index = current; index < migrations.length; index++) {
    db.transaction(() => {
      db.exec(migrations[index])
      db.pragma(`user_version = ${index + 1}`)
    })()
  }
  return migrations.length
}

export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row ? (JSON.parse(row.value) as T) : fallback
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value)
  )
}
