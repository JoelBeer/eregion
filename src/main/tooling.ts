import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Project } from '@shared/model'
import { render } from '@shared/template'
import { parseSkill, relocateServer, type McpServerInfo, type McpServerSpec, type RunTooling, type SkillInfo, type SkillSource } from '@shared/tooling'
import { getSetting, setSetting, type Db } from './db'
import { runnerForRuntimeId } from './projects/detect'
import type { ProjectStore } from './projects/store'
import { NativeRunner } from './runner/native'
import type { Runner } from './runner/types'

type ServerMap = Record<string, McpServerSpec>

/** Fills {{placeholders}} in every string of a server's config, such as a per-ticket database name. */
export function fillPlaceholders(spec: McpServerSpec, values: Record<string, string>): McpServerSpec {
  const fill = (value: string): string => (value.includes('{{') ? render(value, (name) => values[name]).text : value)
  const fillMap = (map?: Record<string, string>) => (map ? Object.fromEntries(Object.entries(map).map(([key, value]) => [key, fill(value)])) : undefined)
  return {
    ...spec,
    ...(spec.command ? { command: fill(spec.command) } : {}),
    ...(spec.args ? { args: spec.args.map(fill) } : {}),
    ...(spec.url ? { url: fill(spec.url) } : {}),
    ...(spec.env ? { env: fillMap(spec.env) } : {}),
    ...(spec.headers ? { headers: fillMap(spec.headers) } : {})
  }
}

function serversIn(text: string | null): ServerMap {
  if (!text) return {}
  try {
    return ((JSON.parse(text) as { mcpServers?: ServerMap }).mcpServers ?? {}) as ServerMap
  } catch {
    return {}
  }
}

/**
 * The skills and MCP servers agents can use, found where Claude Code and Cursor look, and which of
 * them Eregion passes to each run. New skills start off; nothing changes in your own settings.
 */
export class Tooling {
  private cache: { at: number; skills: SkillInfo[] } | null = null

  constructor(
    private readonly db: Db,
    private readonly projects: ProjectStore,
    private readonly runnerFor: (runtime: string) => Runner = runnerForRuntimeId,
    private readonly home: string = homedir(),
    private readonly insideLinux: boolean = process.platform === 'linux'
  ) {}

  private allProjects(): Project[] {
    return this.projects.list().map((summary) => this.projects.get(summary.id))
  }

  // ---------- Skills ----------

  private async skillsIn(runner: Runner, folder: string, source: SkillSource, where: string): Promise<Omit<SkillInfo, 'allowed' | 'isNew'>[]> {
    const listing = await runner.exec(['sh', '-c', 'for f in "$1"/*/SKILL.md; do [ -f "$f" ] && echo "$f"; done; true', 'sh', folder])
    const found: Omit<SkillInfo, 'allowed' | 'isNew'>[] = []
    for (const path of listing.stdout.split('\n').filter(Boolean)) {
      const markdown = (await runner.readFile(path)) ?? ''
      const { name, description } = parseSkill(markdown, path.split('/').at(-2) ?? 'skill')
      found.push({ name, description, source, where, path })
    }
    return found
  }

  skillDefault(): 'on' | 'off' {
    return getSetting(this.db, 'skills.default', 'off')
  }

  async skills(): Promise<SkillInfo[]> {
    const native = new NativeRunner()
    const found = [
      ...(await this.skillsIn(native, join(this.home, '.claude', 'skills'), 'personal', '~/.claude/skills')),
      ...(await this.skillsIn(native, join(this.home, '.claude', 'skills', 'synced'), 'synced', '~/.claude/skills/synced'))
    ]
    for (const project of this.allProjects()) {
      for (const repo of project.repos) {
        const runner = this.runnerFor(repo.runtime)
        found.push(...(await this.skillsIn(runner, runner.join(repo.path, '.claude', 'skills'), 'project', repo.name)))
      }
    }
    const choices = getSetting<Record<string, boolean>>(this.db, 'skills.allowed', {})
    const known = new Set(getSetting<string[]>(this.db, 'skills.known', []))
    const fallback = this.skillDefault() === 'on'
    const unique = new Map<string, SkillInfo>()
    for (const skill of found) {
      // Claude Code resolves a name once (personal over project), so one choice covers every copy.
      if (!unique.has(skill.name)) unique.set(skill.name, { ...skill, allowed: choices[skill.name] ?? fallback, isNew: !known.has(skill.name) })
    }
    const skills = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name))
    this.cache = { at: Date.now(), skills }
    return skills
  }

  setSkillAllowed(name: string, allowed: boolean): void {
    setSetting(this.db, 'skills.allowed', { ...getSetting<Record<string, boolean>>(this.db, 'skills.allowed', {}), [name]: allowed })
    this.cache = null
  }

  setSkillDefault(value: 'on' | 'off'): void {
    setSetting(this.db, 'skills.default', value)
    this.cache = null
  }

  /** Marks every skill found so far as seen, so only later arrivals are flagged New. */
  markSkillsSeen(names: string[]): void {
    setSetting(this.db, 'skills.known', [...new Set([...getSetting<string[]>(this.db, 'skills.known', []), ...names])])
  }

  // ---------- MCP servers ----------

  async servers(): Promise<McpServerInfo[]> {
    const native = new NativeRunner()
    const choices = getSetting<Record<string, boolean>>(this.db, 'mcp.allowed', {})
    const servers: McpServerInfo[] = []
    const add = (source: string, repo: string | null, map: ServerMap): void => {
      for (const [name, spec] of Object.entries(map)) {
        const key = `${source}:${name}`
        if (!servers.some((server) => server.key === key)) servers.push({ key, name, source, repo, spec, allowed: choices[key] ?? false })
      }
    }
    const claudeJson = await native.readFile(join(this.home, '.claude.json'))
    let userConfig: { mcpServers?: ServerMap; projects?: Record<string, { mcpServers?: ServerMap }> } = {}
    try {
      userConfig = claudeJson ? JSON.parse(claudeJson) : {}
    } catch {
      userConfig = {}
    }
    add('~/.claude.json', null, userConfig.mcpServers ?? {})
    add('~/.cursor/mcp.json', null, serversIn(await native.readFile(join(this.home, '.cursor', 'mcp.json'))))
    for (const project of this.allProjects()) {
      for (const repo of project.repos) {
        const runner = this.runnerFor(repo.runtime)
        add(`${repo.name}/.mcp.json`, repo.name, serversIn(await runner.readFile(runner.join(repo.path, '.mcp.json'))))
        add(`${repo.name}/.cursor/mcp.json`, repo.name, serversIn(await runner.readFile(runner.join(repo.path, '.cursor', 'mcp.json'))))
        add(`~/.claude.json (${repo.name})`, repo.name, userConfig.projects?.[repo.path]?.mcpServers ?? {})
      }
    }
    add('Eregion', null, getSetting<ServerMap>(this.db, 'mcp.custom', {}))
    return servers
  }

  setServerAllowed(key: string, allowed: boolean): void {
    setSetting(this.db, 'mcp.allowed', { ...getSetting<Record<string, boolean>>(this.db, 'mcp.allowed', {}), [key]: allowed })
  }

  addServer(name: string, spec: McpServerSpec): void {
    const clean = name.trim()
    if (!/^[\w-]+$/.test(clean)) throw new Error('A server name is letters, numbers, dashes or underscores')
    if (!spec.command?.trim() && !spec.url?.trim()) throw new Error('Give the server a command to run or a URL')
    setSetting(this.db, 'mcp.custom', { ...getSetting<ServerMap>(this.db, 'mcp.custom', {}), [clean]: spec })
    this.setServerAllowed(`Eregion:${clean}`, true)
  }

  removeServer(name: string): void {
    const custom = getSetting<ServerMap>(this.db, 'mcp.custom', {})
    delete custom[name]
    setSetting(this.db, 'mcp.custom', custom)
  }

  // ---------- Runs ----------

  /**
   * What one run gets: only the allowed MCP servers (a repo's servers moved into the run's own
   * copy of that repo, with {{placeholders}} filled from the ticket's values), and a deny rule for
   * every skill you haven't allowed.
   */
  async forRun(project: Project, repoPaths: Record<string, string>, values: Record<string, string>): Promise<RunTooling> {
    const projectRepos = new Set(project.repos.map((repo) => repo.name))
    const mcpServers: ServerMap = {}
    for (const server of (await this.servers()).filter((item) => item.allowed)) {
      if (server.repo && !projectRepos.has(server.repo)) continue
      const repo = project.repos.find((item) => item.name === server.repo)
      let spec = repo && repoPaths[repo.name] ? relocateServer(server.spec, repo.path, repoPaths[repo.name], this.insideLinux) : server.spec
      spec = fillPlaceholders(spec, values)
      mcpServers[mcpServers[server.name] ? `${server.name}-${Object.keys(mcpServers).length}` : server.name] = spec
    }
    const skills = this.cache && Date.now() - this.cache.at < 30_000 ? this.cache.skills : await this.skills()
    const allowedSkills = skills.some((skill) => skill.allowed)
    return {
      mcpConfig: JSON.stringify({ mcpServers }),
      settings: JSON.stringify({ skillOverrides: Object.fromEntries(skills.filter((skill) => !skill.allowed).map((skill) => [skill.name, 'off'])) }),
      allowedTools: [...Object.keys(mcpServers).map((name) => `mcp__${name}`), ...(allowedSkills ? ['Skill'] : [])],
      deniedTools: skills.filter((skill) => !skill.allowed).map((skill) => `Skill(${skill.name})`)
    }
  }
}
