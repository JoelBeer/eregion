import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { combineRules } from '@shared/rules'
import { openDatabase } from './db'
import { ProjectStore } from './projects/store'
import { RulesStore } from './rules'
import { FakeGitHub } from './testing/fake-github'
import { git, makeRepo } from './testing/git'

async function setup() {
  const repo = await makeRepo({ 'README.md': 'app', 'CLAUDE.md': '# Rules\nUse Pest.\n', '.cursor/rules/style.mdc': 'Tabs never.\n' })
  const db = openDatabase(':memory:')
  const projects = new ProjectStore(db)
  const project = projects.create('Word Magic')
  projects.addRepo(project.id, { name: 'app', path: repo.clone, runtime: 'native', defaultBranch: 'main' })
  const github = new FakeGitHub()
  return { repo, project, github, rules: new RulesStore(db, projects, github) }
}

describe.skipIf(process.platform === 'win32')('RulesStore', () => {
  it('lists Eregion, project and repo rules, with the standard files offered when missing', async () => {
    const { rules, project } = await setup()
    await rules.save('eregion', 'British English.')
    await rules.save(`project:${project.id}`, 'Run pint before finishing.')
    const list = await rules.list()
    expect(list.filter((rule) => rule.scope !== 'machine').map((rule) => [rule.label, rule.exists, rule.saveBy])).toEqual([
      ['Eregion rules', true, 'save'],
      ['Word Magic rules', true, 'save'],
      ['app/CLAUDE.md', true, 'pr'],
      ['app/AGENTS.md', false, 'pr'],
      ['app/.cursor/rules/style.mdc', true, 'pr']
    ])
    expect(list[0].content).toBe('British English.')
    expect(combineRules(list[0].content, list[1].content, 'Word Magic')).toBe('British English.\n\nFor Word Magic:\nRun pint before finishing.')
  })

  it('opens a pull request for a repo rule file without touching the checkout, syncing AGENTS.md when asked', async () => {
    const { rules, repo, github } = await setup()
    const [claude] = (await rules.list()).filter((rule) => rule.label === 'app/CLAUDE.md')
    const url = await rules.proposeChange(claude.id, '# Rules\nUse Pest. Run pint.\n', { syncAgents: true })

    expect(url).toBe('https://github.com/me/app/pull/1')
    expect(github.prs[0]).toMatchObject({ title: 'Update CLAUDE.md and AGENTS.md', base: 'main', draft: false })
    const branch = github.prs[0].branch
    expect(git(repo.origin, 'show', `${branch}:CLAUDE.md`)).toBe('# Rules\nUse Pest. Run pint.')
    expect(git(repo.origin, 'show', `${branch}:AGENTS.md`)).toBe('# Rules\nUse Pest. Run pint.')
    expect(await readFile(join(repo.clone, 'CLAUDE.md'), 'utf8')).toBe('# Rules\nUse Pest.\n')
    expect(git(repo.clone, 'worktree', 'list')).not.toContain('eregion-rules')
    await expect(rules.save(claude.id, 'x')).rejects.toThrow('pull request')
  })
})
