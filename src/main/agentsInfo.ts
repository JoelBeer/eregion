import type { AdapterId } from '@shared/agent'
import { BUILT_IN_MODELS, parseTestOutput, TEST_MODEL, TEST_PROMPT, type AgentInfo, type AgentTest, type ModelOption } from '@shared/agents'
import { getSetting, setSetting, type Db } from './db'
import type { ProjectStore } from './projects/store'
import { availableRuntimes, runnerFor, runtimeLabel } from './runner'
import { checkTools } from './tools'

const AGENTS: { id: AdapterId; name: string; tool: 'claude' | 'cursor-agent'; command: string; note: string }[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    tool: 'claude',
    command: 'claude',
    note: 'Autonomous runs may edit files and run commands inside the ticket’s worktrees only, and never commit, push or switch branches. Eregion passes this with each run and never changes your Claude Code settings.'
  },
  {
    id: 'cursor',
    name: 'Cursor CLI',
    tool: 'cursor-agent',
    command: 'cursor-agent',
    note: 'Runs headless with --force inside the ticket’s worktrees. Eregion never changes your Cursor settings. Not yet verified against a real Cursor install.'
  }
]

function runtimeName(runtimeId: string): string {
  return runtimeId.startsWith('wsl:') ? runtimeLabel({ kind: 'wsl', distro: runtimeId.slice(4) }) : runtimeLabel({ kind: 'native' })
}

/** The agent CLIs: where they're installed, which models they offer, and a quick test prompt. */
export class AgentsInfo {
  constructor(
    private readonly db: Db,
    private readonly projects: ProjectStore
  ) {}

  private custom(): Record<AdapterId, string[]> {
    return getSetting(this.db, 'agents.models', { 'claude-code': [], cursor: [] })
  }

  models(adapter: AdapterId): ModelOption[] {
    const custom = this.custom()[adapter] ?? []
    return [...BUILT_IN_MODELS[adapter].map((model) => ({ ...model, custom: false })), ...custom.map((id) => ({ id, label: id, custom: true }))]
  }

  addModel(adapter: AdapterId, id: string): void {
    const model = id.trim()
    if (!/^[\w.:/-]+$/.test(model)) throw new Error('A model id is letters, numbers, dots, dashes, slashes or colons, like claude-opus-5-5')
    if (this.models(adapter).some((item) => item.id === model)) return
    const custom = this.custom()
    setSetting(this.db, 'agents.models', { ...custom, [adapter]: [...(custom[adapter] ?? []), model] })
  }

  removeModel(adapter: AdapterId, id: string): void {
    const custom = this.custom()
    setSetting(this.db, 'agents.models', { ...custom, [adapter]: (custom[adapter] ?? []).filter((item) => item !== id) })
  }

  private tests(adapter: AdapterId): AgentTest[] {
    return getSetting<AgentTest[]>(this.db, `agents.tests.${adapter}`, [])
  }

  async list(): Promise<AgentInfo[]> {
    const checks = await checkTools()
    const projects = this.projects.list().map((summary) => this.projects.get(summary.id))
    return AGENTS.map((agent) => ({
      id: agent.id,
      name: agent.name,
      command: agent.command,
      checks: checks.filter((check) => check.tool === agent.tool),
      models: this.models(agent.id),
      tests: this.tests(agent.id),
      projects: projects.filter((project) => project.repos.length > 0).map((project) => ({ name: project.name, runtime: [...new Set(project.repos.map((repo) => runtimeName(repo.runtime)))].join(', ') })),
      note: agent.note
    }))
  }

  /** Sends a tiny headless prompt with the cheapest model in every runtime where the CLI is installed. */
  async test(adapter: AdapterId): Promise<AgentTest[]> {
    const agent = AGENTS.find((item) => item.id === adapter)
    if (!agent) throw new Error(`Unknown agent ${adapter}`)
    const results: AgentTest[] = []
    for (const runtime of availableRuntimes()) {
      const runner = runnerFor(runtime)
      const found = await runner.exec(runner.shell(`command -v ${agent.command}`), { timeoutMs: 15_000 })
      if (found.code !== 0) continue
      const started = Date.now()
      const result = await runner.exec(runner.shell(`${agent.command} -p '${TEST_PROMPT}' --model ${TEST_MODEL[adapter]} --output-format json`), { timeoutMs: 120_000 })
      results.push({ runtime: runtimeLabel(runtime), at: new Date().toISOString(), ms: Date.now() - started, ...parseTestOutput(result.stdout, result.stderr, result.code) })
    }
    if (results.length === 0) throw new Error(`${agent.command} isn't installed in any runtime on this machine`)
    setSetting(this.db, `agents.tests.${adapter}`, results)
    return results
  }
}
