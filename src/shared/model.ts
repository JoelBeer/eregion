import type { TicketSourceConfig } from './sources'
import type { Variable } from './variables'
import type { LinearStateType } from './integrations'
import type { StageConfig } from './pipeline'
import type { CommitStyle } from './commits'

export type { Variable } from './variables'

/** `native`, or `wsl:<distro>` for a repo inside WSL seen from a Windows host. */
export type RuntimeId = string

export interface LinearProjectConfig {
  teamId?: string
  teamKey?: string
  teamName?: string
  /** Which issues come in: those assigned to the import person, or only ones imported by key. */
  pullFrom?: 'assigned' | 'manual'
  /** Linear state types that count as ready to import (backlog, unstarted). */
  importStateTypes?: LinearStateType[]
  /** Seconds between syncs while Eregion is open. */
  pollSec?: number
  /** What goes back to Linear. Missing switches take their defaults, so projects saved before a switch existed get it. */
  push?: { planComment: boolean; planDescription: boolean; planDocument?: boolean; specDocument?: boolean; prLinks: boolean; buildLog?: boolean }
  /** Linear workflow state id to set when a ticket enters each stage, by stage id; `done` when it finishes. */
  statusByStage?: Record<string, string>
}

export const DEFAULT_LINEAR_PUSH = { planComment: true, planDescription: false, planDocument: true, specDocument: true, prLinks: true, buildLog: true }

export interface GithubProjectConfig {
  /** Open PRs as drafts, so the PR stage waits for you to mark them ready. */
  draft?: boolean
  /** Add links between a ticket's PRs when it changes more than one repo. */
  linkPrs?: boolean
  teardownOnMerge?: boolean
  /** The gh account its git and gh commands use (Settings › Accounts); gh's active account when unset. */
  account?: string | null
}

export interface Repo {
  id: number
  projectId: number
  name: string
  /** Path inside the repo's runtime (a Linux path for WSL repos). */
  path: string
  runtime: RuntimeId
  defaultBranch: string
  githubRepo: string | null
  position: number
  /** How its commit messages and PR titles are written: its commitlint config's way unless chosen here. */
  commitStyle: CommitStyle
  /** Conventional types to allow instead of the config's (or the standard ones). Empty uses those. */
  commitTypes: string[]
}

export interface Project {
  id: number
  name: string
  initials: string
  color: string
  variables: Variable[]
  liveSlots: number
  linear: LinearProjectConfig
  github: GithubProjectConfig
  /** Where tickets come from (see sources.ts). Missing on projects from before: sourceOf() works it out. */
  source?: TicketSourceConfig
  /** 1 to 7 while setting up; 8 once the test run has passed. */
  setupStep: number
  /** Run each repo's setup at the same time instead of in order. */
  setupInParallel: boolean
  repos: Repo[]
}

export type StepPhase = 'setup' | 'teardown'

export type StepConfig =
  | { type: 'command'; command: string }
  | { type: 'set_env'; file: string; values: { key: string; value: string }[] }
  | { type: 'copy_file'; from: string; to: string }
  | { type: 'script'; path: string; args: string }

export interface StepOptions {
  continueOnError?: boolean
  timeoutSec?: number
  /** Skip the step when this path (relative to the worktree) already exists. */
  onlyIfMissing?: string
}

export interface Step {
  id: number
  repoId: number
  phase: StepPhase
  position: number
  config: StepConfig
  options: StepOptions
}

export type ReadyCheck = { kind: 'none' } | { kind: 'http'; url: string; timeoutSec: number } | { kind: 'port'; port: string; timeoutSec: number }

export interface Service {
  id: number
  repoId: number
  name: string
  command: string
  readyCheck: ReadyCheck
  openUrl: string | null
}

/** A project with its whole recipe, as exported to and imported from a project file. */
export interface ProjectFile {
  format: 'eregion-project'
  version: 1
  project: Omit<Project, 'id' | 'repos' | 'setupStep'>
  repos: (Omit<Repo, 'id' | 'projectId' | 'path'> & {
    /** Machine-specific, so exported blank and filled in on import. */
    path: string
    steps: Omit<Step, 'id' | 'repoId'>[]
    services: Omit<Service, 'id' | 'repoId'>[]
  })[]
  /** The pipeline's latest version, its stages taken by crew role (crew are per machine). Older files have none. */
  pipeline?: StageConfig[]
}

export interface ProjectSummary {
  id: number
  name: string
  initials: string
  color: string
  setupStep: number
  repoNames: string[]
  runtimes: RuntimeId[]
  liveSlots: number
  slotsInUse: number
  ticketsInProgress: number
  ticketsNeedYou: number
  linearTeamKey: string | null
}

export const BADGE_COLORS = [
  { name: 'Sky', hex: '#76E1EF' },
  { name: 'Teal', hex: '#5FC4B8' },
  { name: 'Brass', hex: '#F2D06B' },
  { name: 'Ember', hex: '#FFB27A' },
  { name: 'Rose', hex: '#F29BB8' },
  { name: 'Periwinkle', hex: '#9DB4F2' },
  { name: 'Moss', hex: '#A8D97A' },
  { name: 'Lilac', hex: '#C6A6F2' }
] as const

/** Badge initials as typed: letters and digits only, capitals, at most three ("w m" → "WM"). They start Eregion's own ticket keys. */
export function cleanInitials(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 3)
}

/** "Word Magic" → "WM", "perchpeak" → "PE". */
export function initialsFor(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/** Built-in placeholders available to every recipe formula and step, with a sample ticket for previews. */
export const BUILTIN_PLACEHOLDERS = [
  { name: 'slot', describe: 'The ticket environment number, 1 to the live cap' },
  { name: 'ticket.key', describe: 'The ticket key, e.g. WM-12. Use | slug or | snake for safe forms' },
  { name: 'ticket.title', describe: 'The ticket title' },
  { name: 'branch', describe: 'The ticket branch' },
  { name: 'repo.path', describe: "This repo's worktree for the ticket" },
  { name: 'repo.main_path', describe: 'The original clone' },
  { name: 'repo.name', describe: 'The repo name in this project' }
] as const

export interface SampleTicket {
  key: string
  title: string
  slot: number
}

export function branchName(key: string, title: string): string {
  const slug = `${key}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.slice(0, 60).replace(/-+$/, '')
}
