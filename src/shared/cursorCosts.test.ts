import { describe, expect, it } from 'vitest'
import { attributeCursorCosts, sqliteUtcMs } from './cursorCosts'

const minute = 60_000

describe('attributeCursorCosts', () => {
  const build = { id: 1, sessionId: 'chat-build', startedMs: 0, endedMs: 30 * minute, tokens: 3000 }
  const review = { id: 2, sessionId: 'chat-review', startedMs: 20 * minute, endedMs: 50 * minute, tokens: 1000 }

  it("gives an event to the run whose session it's in", () => {
    const cents = attributeCursorCosts([build, review], [{ timestamp: 25 * minute, conversationId: 'chat-review', isHeadless: true, chargedCents: 12 }])
    expect(cents).toEqual(new Map([[1, 0], [2, 12]]))
  })

  it('otherwise gives a headless event to the run going at the time, split by tokens when runs overlap', () => {
    const cents = attributeCursorCosts(
      [build, review],
      [
        { timestamp: 5 * minute, isHeadless: true, chargedCents: 10 },
        { timestamp: 25 * minute, isHeadless: true, chargedCents: 8 },
        { timestamp: 45 * minute, conversationId: 'someone-else', isHeadless: true, chargedCents: 4 }
      ]
    )
    expect(cents.get(1)).toBeCloseTo(10 + 6)
    expect(cents.get(2)).toBeCloseTo(2 + 4)
  })

  it('leaves out editor requests and events outside every run', () => {
    const cents = attributeCursorCosts(
      [build],
      [
        { timestamp: 5 * minute, isHeadless: false, chargedCents: 50 },
        { timestamp: 90 * minute, isHeadless: true, chargedCents: 30 }
      ]
    )
    expect(cents).toEqual(new Map([[1, 0]]))
  })
})

it("reads SQLite's datetime('now') text as UTC", () => {
  expect(sqliteUtcMs('2026-10-21 14:06:52')).toBe(Date.UTC(2026, 9, 21, 14, 6, 52))
})
