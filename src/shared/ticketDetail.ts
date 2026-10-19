import type { Environment } from './environment'
import type { Fix, ParsedBuildNotes, ParsedPlan, Review } from './outputs'
import type { StageConfig } from './pipeline'
import type { RunSummary } from './runs'
import type { TicketCard } from './tickets'

export interface TicketDetail {
  card: TicketCard
  stages: StageConfig[]
  runs: RunSummary[]
  environment: Environment | null
  log: { ts: string; kind: string; message: string }[]
}

export interface TicketOutputs {
  dir: string
  plan: { markdown: string; parsed: ParsedPlan; blockers: string[] } | null
  buildNotes: { markdown: string; parsed: ParsedBuildNotes } | null
  review: { text: string; review: Review | null; problems: string[] } | null
  fixes: { text: string; fixes: Fix[] | null; problems: string[] } | null
  /** Earlier versions kept in history/, newest last. */
  history: string[]
}

export interface DiffFile {
  path: string
  additions: number
  deletions: number
  /** Review issues this file's changes fix, from fixes.json. */
  fixes: { issueId: string; severity: string }[]
  patch: string
}

export interface RepoDiff {
  repo: string
  branch: string | null
  base: string
  files: DiffFile[]
  error: string | null
}

/** Splits `git diff` output into files with line counts. */
export function parseDiff(diff: string): Omit<DiffFile, 'fixes'>[] {
  const files: Omit<DiffFile, 'fixes'>[] = []
  const chunks = diff.split(/^diff --git /m).filter((chunk) => chunk.trim())
  for (const chunk of chunks) {
    const header = chunk.split('\n')[0]
    const path = header.match(/ b\/(.+)$/)?.[1] ?? header
    let additions = 0
    let deletions = 0
    for (const line of chunk.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++
      if (line.startsWith('-') && !line.startsWith('---')) deletions++
    }
    files.push({ path, additions, deletions, patch: `diff --git ${chunk}` })
  }
  return files
}
