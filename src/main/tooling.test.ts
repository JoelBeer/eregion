import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from './db'
import { ProjectStore } from './projects/store'
import { makeRepo } from './testing/git'
import { fillPlaceholders, Tooling } from './tooling'

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'eregion-home-'))
  await mkdir(join(home, '.claude', 'skills', 'tidy'), { recursive: true })
  await writeFile(join(home, '.claude', 'skills', 'tidy', 'SKILL.md'), '---\nname: tidy\ndescription: Tidy things.\n---\n')
  const repo = await makeRepo({ 'README.md': 'app', '.claude/skills/laravel-best-practices/SKILL.md': '---\nname: laravel-best-practices\ndescription: Laravel conventions.\n---\n' })
  // Word Magic's .mcp.json points at the main checkout, through wsl.exe.
  await writeFile(join(repo.clone, '.mcp.json'), JSON.stringify({ mcpServers: { 'laravel-boost': { command: 'wsl.exe', args: ['/usr/bin/php8.5', `${repo.clone}/artisan`, 'boost:mcp'] } } }))
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } }, projects: { [repo.clone]: { mcpServers: { db: { command: 'db-mcp', args: ['--database', '{{db_name}}'] } } } } }))
  const db = openDatabase(':memory:')
  const projects = new ProjectStore(db)
  const project = projects.create('Word Magic')
  projects.addRepo(project.id, { name: 'word-magic', path: repo.clone, runtime: 'native', defaultBranch: 'main' })
  return { tooling: new Tooling(db, projects, undefined, home, true), project: projects.get(project.id), repo }
}

describe.skipIf(process.platform === 'win32')('Tooling', () => {
  it('finds skills where Claude Code looks, starting them off and flagged new', async () => {
    const { tooling } = await setup()
    const skills = await tooling.skills()
    expect(skills.map((skill) => [skill.name, skill.source, skill.where, skill.allowed, skill.isNew])).toEqual([
      ['laravel-best-practices', 'project', 'word-magic', false, true],
      ['tidy', 'personal', '~/.claude/skills', false, true]
    ])
    tooling.markSkillsSeen(skills.map((skill) => skill.name))
    tooling.setSkillAllowed('tidy', true)
    expect((await tooling.skills()).map((skill) => [skill.name, skill.allowed, skill.isNew])).toEqual([
      ['laravel-best-practices', false, false],
      ['tidy', true, false]
    ])
  })

  it('finds MCP servers in the repo, the user config and its per-project entries, all off to begin with', async () => {
    const { tooling } = await setup()
    expect((await tooling.servers()).map((server) => [server.key, server.repo, server.allowed])).toEqual([
      ['~/.claude.json:linear', null, false],
      ['word-magic/.mcp.json:laravel-boost', 'word-magic', false],
      ['~/.claude.json (word-magic):db', 'word-magic', false]
    ])
  })

  it("gives a run only the allowed servers, a repo's server moved into the run's worktree, and denies skills not allowed", async () => {
    const { tooling, project } = await setup()
    tooling.setServerAllowed('word-magic/.mcp.json:laravel-boost', true)
    tooling.setServerAllowed('~/.claude.json (word-magic):db', true)
    tooling.setSkillAllowed('tidy', true)
    const run = await tooling.forRun(project, { 'word-magic': '/work/WM-3/word-magic' }, { db_name: 'wm_wm_3' })
    expect(JSON.parse(run.mcpConfig)).toEqual({
      mcpServers: {
        'laravel-boost': { command: '/usr/bin/php8.5', args: ['/work/WM-3/word-magic/artisan', 'boost:mcp'] },
        db: { command: 'db-mcp', args: ['--database', 'wm_wm_3'] }
      }
    })
    expect(run.deniedTools).toEqual(['Skill(laravel-best-practices)'])
    expect(run.allowedTools).toEqual(['mcp__laravel-boost', 'mcp__db', 'Skill'])
    expect(JSON.parse(run.settings)).toEqual({ skillOverrides: { 'laravel-best-practices': 'off' } })
  })

  it('fills placeholders without breaking on quotes', () => {
    expect(fillPlaceholders({ command: 'x', env: { NAME: '{{name}}' } }, { name: 'say "hi"' })).toEqual({ command: 'x', env: { NAME: 'say "hi"' } })
  })
})
