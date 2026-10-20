import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Project, Repo } from '@shared/model'
import { readByFor, STANDARD_REPO_RULES, type RuleFile } from '@shared/rules'
import { getSetting, setSetting, type Db } from './db'
import type { GitHub } from './integrations/github'
import { runnerForRuntimeId } from './projects/detect'
import type { ProjectStore } from './projects/store'
import { NativeRunner } from './runner/native'
import type { Runner } from './runner/types'
import { baseRef, gitIn } from './workspace/git'

const MACHINE_CLAUDE = join(homedir(), '.claude', 'CLAUDE.md')

/**
 * The rules agents read: Eregion's and each project's (added to every stage prompt), the repos'
 * own rule files (changed only through a pull request), and this machine's ~/.claude/CLAUDE.md.
 */
export class RulesStore {
  constructor(
    private readonly db: Db,
    private readonly projects: ProjectStore,
    private readonly github: GitHub,
    private readonly runnerFor: (runtime: string) => Runner = runnerForRuntimeId
  ) {}

  private repoFiles = async (repo: Repo): Promise<string[]> => {
    const runner = this.runnerFor(repo.runtime)
    const cursor = await runner.exec(['sh', '-c', 'ls -1 .cursor/rules/*.mdc 2>/dev/null; true'], { cwd: repo.path })
    return [...STANDARD_REPO_RULES, ...cursor.stdout.split('\n').filter(Boolean)]
  }

  async list(): Promise<RuleFile[]> {
    const rules: RuleFile[] = [
      { id: 'eregion', scope: 'eregion', label: 'Eregion rules', group: 'Eregion', readBy: 'Every stage of every project, both agents', exists: true, content: getSetting(this.db, 'rules.house', ''), saveBy: 'save' }
    ]
    for (const summary of this.projects.list()) {
      const project = this.projects.get(summary.id)
      rules.push({
        id: `project:${project.id}`,
        scope: 'project',
        label: `${project.name} rules`,
        group: project.name,
        readBy: `Every stage of ${project.name}'s tickets, both agents`,
        exists: true,
        content: getSetting(this.db, `rules.project.${project.id}`, ''),
        saveBy: 'save'
      })
      for (const repo of project.repos) {
        const runner = this.runnerFor(repo.runtime)
        for (const path of await this.repoFiles(repo)) {
          const content = await runner.readFile(runner.join(repo.path, path))
          rules.push({ id: `repo:${repo.id}:${path}`, scope: 'repo', label: `${repo.name}/${path}`, group: project.name, readBy: readByFor(path), exists: content !== null, content: content ?? '', saveBy: 'pr' })
        }
      }
    }
    const machine = await new NativeRunner().readFile(MACHINE_CLAUDE)
    rules.push({ id: 'machine:claude', scope: 'machine', label: '~/.claude/CLAUDE.md', group: 'This machine', readBy: 'Claude Code, in every project on this machine', exists: machine !== null, content: machine ?? '', saveBy: 'save' })
    return rules
  }

  /** Saves Eregion, project and machine rules in place. Repo files go through proposeChange. */
  async save(id: string, content: string): Promise<void> {
    if (id === 'eregion') setSetting(this.db, 'rules.house', content)
    else if (id.startsWith('project:')) setSetting(this.db, `rules.project.${Number(id.slice(8))}`, content)
    else if (id === 'machine:claude') await new NativeRunner().writeFile(MACHINE_CLAUDE, content)
    else throw new Error("A repo's rule file changes through a pull request")
  }

  private repo(id: string): { project: Project; repo: Repo; path: string } {
    const match = id.match(/^repo:(\d+):(.+)$/)
    if (!match) throw new Error(`Not a repo rule file: ${id}`)
    const repoId = Number(match[1])
    for (const summary of this.projects.list()) {
      const project = this.projects.get(summary.id)
      const repo = project.repos.find((item) => item.id === repoId)
      if (repo) return { project, repo, path: match[2] }
    }
    throw new Error('That repo is no longer in a project')
  }

  /**
   * Proposes a rule file change: a branch from the latest base with the new content (and, if
   * asked, the same text in AGENTS.md), pushed and opened as a pull request. Your checkout isn't
   * touched. Returns the pull request's URL.
   */
  async proposeChange(id: string, content: string, options: { syncAgents?: boolean } = {}): Promise<string> {
    const { repo, path } = this.repo(id)
    const runner = this.runnerFor(repo.runtime)
    const { ref } = await baseRef(runner, repo.path, repo.defaultBranch)
    const branch = `eregion/rules-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`
    const folder = (await gitIn(runner, repo.path, ['rev-parse', '--absolute-git-dir'])) + `/eregion-rules-${Date.now()}`
    await gitIn(runner, repo.path, ['worktree', 'add', '--quiet', '-b', branch, folder, ref])
    try {
      const files = [path, ...(options.syncAgents && path === 'CLAUDE.md' ? ['AGENTS.md'] : options.syncAgents && path === 'AGENTS.md' ? ['CLAUDE.md'] : [])]
      for (const file of files) await runner.writeFile(runner.join(folder, file), content)
      await gitIn(runner, folder, ['add', ...files])
      const title = `Update ${files.join(' and ')}`
      await gitIn(runner, folder, ['commit', '--quiet', '-m', title, '-m', 'Edited in Eregion › Settings › AI rules.'])
      await gitIn(runner, folder, ['push', '--quiet', '-u', 'origin', branch], 180_000)
      return await this.github.createPr(runner, folder, { base: repo.defaultBranch, branch, title, body: `${title}, edited in Eregion's AI rules settings.`, draft: false })
    } finally {
      await runner.exec(['git', 'worktree', 'remove', '--force', folder], { cwd: repo.path })
    }
  }
}
