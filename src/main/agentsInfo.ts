import { BUILT_IN_CONNECTORS, customAgentProblems, customConnector, type AgentConnector, type CustomAgent } from '@shared/connectors'
import { TEST_PROMPT, type AgentInfo, type AgentTest, type ModelOption } from '@shared/agents'
import { startAgent } from './agents/session'
import { getSetting, setSetting, type Db } from './db'
import type { ProjectStore } from './projects/store'
import { availableRuntimes, runnerFor, runtimeLabel } from './runner'
import { checkCommand } from './tools'

function runtimeName(runtimeId: string): string {
  return runtimeId.startsWith('wsl:') ? runtimeLabel({ kind: 'wsl', distro: runtimeId.slice(4) }) : runtimeLabel({ kind: 'native' })
}

/**
 * The agents Eregion can run: Claude Code, Cursor and Codex, plus the ones you add with a command template.
 * Where each is installed, which models it offers, and a quick test prompt through the same code runs use.
 */
export class AgentsInfo {
  constructor(
    private readonly db: Db,
    private readonly projects: ProjectStore
  ) {}

  private customAgents(): CustomAgent[] {
    return getSetting<CustomAgent[]>(this.db, 'agents.custom', [])
  }

  /** Every agent, built-in first. */
  connectors(): AgentConnector[] {
    return [...BUILT_IN_CONNECTORS, ...this.customAgents().map(customConnector)]
  }

  connector(id: string): AgentConnector | undefined {
    return this.connectors().find((connector) => connector.id === id)
  }

  /** Adds or replaces a custom agent. */
  saveCustom(agent: CustomAgent): AgentConnector {
    const others = this.customAgents().filter((item) => item.id !== agent.id)
    const cleaned: CustomAgent = {
      ...agent,
      name: agent.name.trim(),
      command: agent.command.trim(),
      args: agent.args.filter((arg) => arg !== ''),
      resumeArgs: agent.resumeArgs?.filter((arg) => arg !== ''),
      models: agent.models.map((model) => model.trim()).filter(Boolean)
    }
    const problems = customAgentProblems(cleaned, [...BUILT_IN_CONNECTORS.map((item) => item.id), ...others.map((item) => item.id)])
    if (problems.length > 0) throw new Error(problems.join('. '))
    setSetting(this.db, 'agents.custom', [...others, cleaned])
    return customConnector(cleaned)
  }

  /** Removes a custom agent. Crew members on it keep their setting, and say it's gone until you pick another. */
  removeCustom(id: string): void {
    setSetting(
      this.db,
      'agents.custom',
      this.customAgents().filter((item) => item.id !== id)
    )
  }

  private addedModels(): Record<string, string[]> {
    return getSetting<Record<string, string[]>>(this.db, 'agents.models', {})
  }

  models(adapter: string): ModelOption[] {
    const connector = this.connector(adapter)
    const added = this.addedModels()[adapter] ?? []
    return [...(connector?.models ?? []).map((model) => ({ ...model, custom: false })), ...added.filter((id) => !connector?.models.some((model) => model.id === id)).map((id) => ({ id, label: id, custom: true }))]
  }

  addModel(adapter: string, id: string): void {
    const model = id.trim()
    if (!/^[\w.:/-]+$/.test(model)) throw new Error('A model id is letters, numbers, dots, dashes, slashes or colons, like claude-opus-5-5')
    if (this.models(adapter).some((item) => item.id === model)) return
    const added = this.addedModels()
    setSetting(this.db, 'agents.models', { ...added, [adapter]: [...(added[adapter] ?? []), model] })
  }

  removeModel(adapter: string, id: string): void {
    const added = this.addedModels()
    setSetting(this.db, 'agents.models', { ...added, [adapter]: (added[adapter] ?? []).filter((item) => item !== id) })
  }

  private tests(adapter: string): AgentTest[] {
    return getSetting<AgentTest[]>(this.db, `agents.tests.${adapter}`, [])
  }

  async list(): Promise<AgentInfo[]> {
    const projects = this.projects
      .list()
      .map((summary) => this.projects.get(summary.id))
      .filter((project) => project.repos.length > 0)
      .map((project) => ({ name: project.name, runtime: [...new Set(project.repos.map((repo) => runtimeName(repo.runtime)))].join(', ') }))
    return Promise.all(
      this.connectors().map(async (connector) => ({
        ...connector,
        checks: await checkCommand(connector.command),
        models: this.models(connector.id),
        tests: this.tests(connector.id),
        projects
      }))
    )
  }

  /**
   * Sends one tiny prompt with the cheapest model in every runtime where the agent is installed, through the
   * same session code stages use, so a pass means runs will work too.
   */
  async test(adapter: string): Promise<AgentTest[]> {
    const connector = this.connector(adapter)
    if (!connector) throw new Error(`Unknown agent ${adapter}`)
    const results: AgentTest[] = []
    for (const runtime of availableRuntimes()) {
      const runner = runnerFor(runtime)
      const found = await runner.exec(runner.shell(`command -v ${connector.command}`), { timeoutMs: 15_000 })
      if (found.code !== 0) continue
      const home = await runner.exec(runner.shell('echo $HOME'), { timeoutMs: 15_000 })
      const started = Date.now()
      const session = startAgent({ connector, runner, cwd: home.stdout.trim() || '/', model: connector.testModel || this.models(adapter)[0]?.id || '', prompt: TEST_PROMPT, profile: 'chat' })
      const timer = setTimeout(() => void session.stop(), 120_000)
      const outcome = await session.done
      clearTimeout(timer)
      const detail = outcome.error ?? (outcome.lastText.trim() || '(no reply)')
      results.push({
        runtime: runtimeLabel(runtime),
        at: new Date().toISOString(),
        ms: Date.now() - started,
        ok: outcome.state === 'done' && /\bok\b/i.test(outcome.lastText),
        signedIn: !/log ?in|logged out|invalid api key|authenticat|sign in/i.test(detail),
        usageReported: outcome.usage !== null,
        costUsd: outcome.costUsd,
        detail
      })
    }
    if (results.length === 0) throw new Error(`${connector.command} isn't installed in any runtime on this machine`)
    setSetting(this.db, `agents.tests.${adapter}`, results)
    return results
  }
}
