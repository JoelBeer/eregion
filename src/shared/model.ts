import type { Variable } from './variables'

export type { Variable } from './variables'

/** `native`, or `wsl:<distro>` for a repo inside WSL seen from a Windows host. */
export type RuntimeId = string

export interface LinearProjectConfig {
  teamId?: string
  teamKey?: string
  /** Which issues come in: assigned to the import person, a saved view, or only ones imported by key. */
  pullFrom?: 'assigned' | 'view' | 'manual'
  viewId?: string
  /** Linear workflow state names that count as "ready to import". Empty means any open state. */
  importStates?: string[]
  pull?: { comments: boolean; labels: boolean; attachments: boolean }
  push?: { planComment: boolean; planDescription: boolean; prLinks: boolean; costSummary: boolean }
  /** Linear workflow state id to set when a ticket enters each stage. */
  statusByStage?: Record<string, string>
}

export interface GithubProjectConfig {
  draft?: boolean
  linkPrs?: boolean
  teardownOnMerge?: boolean
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
