import { describe, expect, it } from 'vitest'
import { parseSkill, relocateServer } from './tooling'

describe('parseSkill', () => {
  it('reads the frontmatter, or falls back to the folder and first line', () => {
    expect(parseSkill('---\nname: laravel-best-practices\ndescription: "Apply Laravel conventions."\n---\n# Laravel\n', 'x')).toEqual({ name: 'laravel-best-practices', description: 'Apply Laravel conventions.' })
    expect(parseSkill('# Title\nDeploy the app.\n', 'deploy')).toEqual({ name: 'deploy', description: 'Deploy the app.' })
  })
})

describe('relocateServer', () => {
  // Word Magic's real .mcp.json, written for Windows.
  const boost = { command: 'wsl.exe', args: ['/usr/bin/php8.5', '/home/joelb/sites/word-magic/artisan', 'boost:mcp'] }

  it("runs a repo's server in the ticket's worktree, without the wsl.exe wrapper inside Linux", () => {
    expect(relocateServer(boost, '/home/joelb/sites/word-magic', '/home/joelb/.eregion/word-magic/work/WM-3/word-magic', true)).toEqual({
      command: '/usr/bin/php8.5',
      args: ['/home/joelb/.eregion/word-magic/work/WM-3/word-magic/artisan', 'boost:mcp']
    })
  })

  it('keeps the wrapper on Windows, and skips wsl.exe flags', () => {
    expect(relocateServer(boost, '/home/joelb/sites/word-magic', '/w/WM-3/word-magic', false).command).toBe('wsl.exe')
    expect(relocateServer({ command: 'wsl', args: ['-d', 'Ubuntu', '--', 'php', 'artisan', 'boost:mcp'] }, '/x', '/y', true)).toEqual({ command: 'php', args: ['artisan', 'boost:mcp'] })
  })
})
