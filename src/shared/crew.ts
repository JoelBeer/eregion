/** Crew profiles: stats and ranks from what each member has shipped. */

export interface CrewStats {
  crewId: number
  /** Tickets now Done that this member worked on. */
  shipped: number
  runs: number
  costUsd: number
}

const RANKS: { from: number; name: string }[] = [
  { from: 25, name: 'Master smith' },
  { from: 10, name: 'Smith' },
  { from: 3, name: 'Journeyman' },
  { from: 1, name: 'Apprentice' },
  { from: 0, name: 'New hand' }
]

export function rank(shipped: number): string {
  return (RANKS.find((item) => shipped >= item.from) ?? RANKS[RANKS.length - 1]).name
}

/** Eight robots near a seed, for the new-member picker. Same seed, same eight. */
export function candidateSeeds(seed: number): number[] {
  return Array.from({ length: 8 }, (_, index) => (seed + (index + 1) * 0x9e3779b1) >>> 0)
}

export const ROLES = ['Planner', 'Builder', 'Reviewer', 'Shipper', 'Forge only'] as const
