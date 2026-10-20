/** Skills and MCP servers as Settings shows them, and what each run is given. */

export type SkillSource = 'project' | 'personal' | 'synced'

export interface SkillInfo {
  name: string
  description: string
  source: SkillSource
  /** The repo it lives in, or ~/.claude/skills. */
  where: string
  path: string
  allowed: boolean
  /** Found since you last looked at Settings › Skills. */
  isNew: boolean
}

export interface McpServerSpec {
  type?: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface McpServerInfo {
  /** Unique across sources: `<source>:<name>`. */
  key: string
  name: string
  /** Where it was found, as shown: word-magic/.mcp.json, ~/.claude.json, Eregion. */
  source: string
  /** A repo's server, which Eregion runs inside each ticket's own worktree. */
  repo: string | null
  spec: McpServerSpec
  allowed: boolean
}

/** What one run is given: its MCP servers and the tools it may not use. */
export interface RunTooling {
  /** Tools to allow on top of the stage's own: each allowed server's tools (mcp__name) and the Skill tool. */
  allowedTools: string[]
  mcpConfig: string
  /** Per-run Claude Code settings: skillOverrides turning off every skill you haven't allowed. */
  settings: string
  deniedTools: string[]
}

/** Reads `name` and `description` from a SKILL.md's frontmatter, falling back to the folder name and first line. */
export function parseSkill(markdown: string, folder: string): { name: string; description: string } {
  const front = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const field = (key: string): string | undefined =>
    front?.[1]
      .match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '')
  const body = front ? markdown.slice(front[0].length) : markdown
  const firstLine = body.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.trim() ?? ''
  return { name: field('name') || folder, description: field('description') || firstLine }
}

/**
 * Runs a repo's MCP server inside a ticket's worktree: the main checkout's path becomes the
 * worktree's, and a `wsl.exe` wrapper (written for Windows) is dropped when already inside Linux.
 */
export function relocateServer(spec: McpServerSpec, mainPath: string, worktree: string, insideLinux: boolean): McpServerSpec {
  const swap = (value: string): string => value.split(mainPath).join(worktree)
  let command = spec.command
  let args = spec.args ?? []
  if (insideLinux && command && /^wsl(\.exe)?$/i.test(command)) {
    let rest = [...args]
    while (rest.length > 0 && rest[0].startsWith('-')) {
      const flag = rest.shift() as string
      if (flag === '-d' || flag === '--distribution' || flag === '--cd' || flag === '-u' || flag === '--user') rest.shift()
      if (flag === '--' || flag === '-e' || flag === '--exec') break
    }
    command = rest[0]
    args = rest.slice(1)
  }
  return {
    ...spec,
    ...(command ? { command: swap(command) } : {}),
    ...(spec.args || args.length ? { args: args.map(swap) } : {}),
    ...(spec.env ? { env: Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, swap(value)])) } : {})
  }
}
