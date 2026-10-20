/** The rule files agents read, as Settings › AI rules lists them. */

export type RuleScope = 'eregion' | 'project' | 'repo' | 'machine'

export interface RuleFile {
  /** `eregion`, `project:<id>`, `repo:<repoId>:<path>` or `machine:claude`. */
  id: string
  scope: RuleScope
  /** The file's path as shown: relative inside a repo, ~/… on this machine. */
  label: string
  /** Where it lives: the project name, or "This machine". */
  group: string
  /** Who reads it, in a few words. */
  readBy: string
  exists: boolean
  content: string
  /** Repo files change through a pull request; the rest save in place. */
  saveBy: 'save' | 'pr'
}

/** Repo rule files Eregion offers to create when they're missing. */
export const STANDARD_REPO_RULES = ['CLAUDE.md', 'AGENTS.md']

export function readByFor(path: string): string {
  if (path === 'CLAUDE.md') return 'Claude Code, in every run in this repo'
  if (path === 'AGENTS.md') return 'Cursor and other agents, in every run in this repo'
  if (path.startsWith('.cursor/rules/')) return 'Cursor, when the rule applies'
  return 'Agents that look for it'
}

/** Eregion's rules plus the project's, as they're added to every stage prompt. */
export function combineRules(eregion: string, project: string, projectName: string): string {
  return [eregion.trim(), project.trim() ? `For ${projectName}:\n${project.trim()}` : ''].filter(Boolean).join('\n\n')
}
