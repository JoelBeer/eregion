/**
 * Agent connectors: what Eregion needs to know to run an agent CLI. Claude Code, Cursor and Codex are built
 * in; anything else is added in Settings › Agents as a command template. Stages, the crew and the Forge
 * only offer what the chosen agent can do, and say why when it can't.
 */

/** How the CLI reports what it's doing. */
export type OutputFormat = 'claude-stream-json' | 'cursor-stream-json' | 'codex-jsonl' | 'text'

export const OUTPUT_FORMAT_LABELS: Record<OutputFormat, string> = {
  'claude-stream-json': "Claude Code's stream-json",
  'cursor-stream-json': "Cursor's stream-json",
  'codex-jsonl': "Codex's JSON lines (--json)",
  text: 'Plain text'
}

export interface AgentCapabilities {
  /** Your messages reach it while it works, rather than waiting for its turn to end. */
  midRunMessages: boolean
  /** It can carry on the same conversation: Plan, the Forge, and asking it to fix a file all need this. */
  followUps: boolean
  /** Per-run MCP servers and skills. */
  tooling: boolean
  /** Eregion can stop it running git commit, push or checkout itself. */
  blocksGit: boolean
  reportsTokens: boolean
  reportsCost: boolean
}

export interface AgentConnector {
  /** 'claude-code', 'cursor', 'codex', or a custom agent's id. */
  id: string
  name: string
  /** The command on PATH in the repos' runtime. */
  command: string
  builtIn: boolean
  output: OutputFormat
  /**
   * Custom agents: the arguments after the command for a new run. {{prompt}} is the message ({{model}} the
   * model); with no {{prompt}}, the message goes to the command's input instead.
   */
  args?: string[]
  /** Custom agents: the arguments to carry on a conversation, with {{session}} and {{prompt}}. None means no follow-ups. */
  resumeArgs?: string[]
  capabilities: AgentCapabilities
  /** Built-in models; you can add more in Settings › Agents. */
  models: { id: string; label: string }[]
  /** The model a test prompt uses: the cheapest. */
  testModel: string
  note: string
}

export const BUILT_IN_CONNECTORS: AgentConnector[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    builtIn: true,
    output: 'claude-stream-json',
    capabilities: { midRunMessages: true, followUps: true, tooling: true, blocksGit: true, reportsTokens: true, reportsCost: true },
    models: [
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1' }
    ],
    testModel: 'claude-haiku-5-5',
    note: 'Autonomous runs may edit files and run commands inside the ticket’s worktrees only, and never commit, push or switch branches. Eregion passes this with each run and never changes your Claude Code settings.'
  },
  {
    id: 'cursor',
    name: 'Cursor CLI',
    command: 'cursor-agent',
    builtIn: true,
    output: 'cursor-stream-json',
    capabilities: { midRunMessages: false, followUps: true, tooling: false, blocksGit: false, reportsTokens: true, reportsCost: false },
    models: [{ id: 'auto', label: 'Auto (Cursor picks)' }],
    testModel: 'auto',
    note: 'Runs headless with --force inside the ticket’s worktrees, billed to your Cursor plan. Eregion never changes your Cursor settings. Not yet verified against a real Cursor install.'
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    builtIn: true,
    output: 'codex-jsonl',
    capabilities: { midRunMessages: false, followUps: true, tooling: false, blocksGit: false, reportsTokens: true, reportsCost: false },
    // Codex's model names change often: 'default' runs whatever your Codex config picks; add others in Settings › Agents.
    models: [{ id: 'default', label: 'Codex default (from your config)' }],
    testModel: 'default',
    note: 'Runs `codex exec --json` in the workspace-write sandbox, with the outputs folder as an extra writable root, billed to your ChatGPT or OpenAI plan. Eregion never changes your Codex settings. Built from Codex’s documented flags; not yet verified against a real Codex install.'
  }
]

/** What a custom agent can do follows from its output format and whether it can carry on a conversation. */
export function customCapabilities(output: OutputFormat, resumeArgs: string[] | undefined): AgentCapabilities {
  const structured = output !== 'text'
  return {
    midRunMessages: false,
    followUps: structured && Boolean(resumeArgs?.length),
    tooling: false,
    blocksGit: false,
    reportsTokens: structured,
    reportsCost: output === 'claude-stream-json'
  }
}

/** A custom agent as Settings › Agents saves it. */
export interface CustomAgent {
  id: string
  name: string
  command: string
  output: OutputFormat
  args: string[]
  resumeArgs?: string[]
  models: string[]
}

export function customConnector(agent: CustomAgent): AgentConnector {
  return {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    builtIn: false,
    output: agent.output,
    args: agent.args,
    resumeArgs: agent.resumeArgs?.length ? agent.resumeArgs : undefined,
    capabilities: customCapabilities(agent.output, agent.resumeArgs),
    models: agent.models.map((id) => ({ id, label: id })),
    testModel: agent.models[0] ?? '',
    note: 'Added by you. Eregion runs it with your command template and reads its output as you said.'
  }
}

/** Checks a custom agent before it's saved. Returns what's wrong, if anything. */
export function customAgentProblems(agent: CustomAgent, taken: string[]): string[] {
  const problems: string[] = []
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(agent.id)) problems.push('The id is 2 to 31 lowercase letters, numbers or dashes, starting with a letter')
  else if (taken.includes(agent.id)) problems.push(`There's already an agent called ${agent.id}`)
  if (!agent.name.trim()) problems.push('Give it a name')
  if (!/^[\w./-]+$/.test(agent.command)) problems.push('The command is one program name or path, like aider or ~/bin/my-agent')
  if (agent.args.some((arg) => arg.includes('{{session}}'))) problems.push('{{session}} belongs in the follow-up arguments')
  if (agent.resumeArgs?.length && !agent.resumeArgs.some((arg) => arg.includes('{{session}}'))) problems.push('The follow-up arguments need {{session}}, so it carries on the same conversation')
  return problems
}

/** Fills {{prompt}}, {{model}} and {{session}} in a custom agent's arguments. */
export function fillArgs(args: string[], values: { prompt: string; model: string; session?: string }): string[] {
  return args.map((arg) => arg.replace(/\{\{(prompt|model|session)\}\}/g, (_, name: 'prompt' | 'model' | 'session') => values[name] ?? ''))
}

/** The built-in connector with this id, or a stand-in for one that's no longer set up. */
export function builtInConnector(id: string): AgentConnector | undefined {
  return BUILT_IN_CONNECTORS.find((connector) => connector.id === id)
}

/** What a run needs from its agent. */
export interface AgentNeeds {
  /** Plan, the Forge, and any stage that may need a fix request. */
  followUps?: boolean
  /** The run gets MCP servers or skills. */
  tooling?: boolean
}

/** Why an agent can't do what's needed, in words for the screen; empty when it can. */
export function missingCapabilities(connector: AgentConnector, needs: AgentNeeds): string[] {
  const missing: string[] = []
  if (needs.followUps && !connector.capabilities.followUps) missing.push(`${connector.name} can't carry on a conversation, so it can't plan, chat in the Forge, or be asked to fix a file`)
  if (needs.tooling && !connector.capabilities.tooling) missing.push(`${connector.name} runs don't get per-run MCP servers or skills`)
  return missing
}

/** How Costs labels a run with no reported spend. */
export function noCostLabel(connector: AgentConnector | undefined): string {
  if (!connector) return 'not reported'
  return connector.builtIn && !connector.capabilities.reportsCost ? `${connector.name.replace(/ CLI$/, '')} plan` : 'not reported'
}
