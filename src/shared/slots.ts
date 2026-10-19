/** The lowest slot from 1 to the live cap that no live environment is using, or null when all are taken. */
export function nextFreeSlot(used: number[], cap: number): number | null {
  const taken = new Set(used)
  for (let slot = 1; slot <= cap; slot++) {
    if (!taken.has(slot)) return slot
  }
  return null
}
