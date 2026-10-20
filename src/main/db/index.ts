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

/**
 * Runs the migrations this database hasn't had, each in a transaction. Foreign keys are off meanwhile (they
 * can't be switched inside a transaction), so a migration that rebuilds a table doesn't cascade into the
 * tables pointing at it; they're checked before being switched back on.
 */
export function migrate(db: Db): number {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current >= migrations.length) return migrations.length
  const enforced = db.pragma('foreign_keys', { simple: true }) === 1
  db.pragma('foreign_keys = OFF')
  try {
    for (let index = current; index < migrations.length; index++) {
      db.transaction(() => {
        db.exec(migrations[index])
        const broken = db.pragma('foreign_key_check') as unknown[]
        if (broken.length > 0) throw new Error(`Migration ${index + 1} would leave ${broken.length} broken references`)
        db.pragma(`user_version = ${index + 1}`)
      })()
    }
  } finally {
    if (enforced) db.pragma('foreign_keys = ON')
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
