import type { Runtime, ToolCheck } from '@shared/types'
import { availableRuntimes, runnerFor, runtimeLabel } from './runner'
import type { Runner } from './runner'

const VERSION_COMMANDS: Record<ToolCheck['tool'], string> = {
  git: 'git --version',
  gh: 'gh --version',
  claude: 'claude --version',
  'cursor-agent': 'cursor-agent --version'
}

/** Pulls the first version-looking token out of a tool's --version output. */
export function parseVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/)?.[0]
}

async function checkTool(runner: Runner, tool: ToolCheck['tool'], label: string): Promise<ToolCheck> {
  const result = await runner.exec(runner.shell(VERSION_COMMANDS[tool]), { timeoutMs: 20_000 })
  const check: ToolCheck = { tool, runtime: label, found: result.code === 0 }
  if (!check.found) {
    return check
  }
  check.version = parseVersion(result.stdout)
  if (tool === 'gh') {
    const auth = await runner.exec(runner.shell('gh auth status'), { timeoutMs: 20_000 })
    const account = `${auth.stdout}\n${auth.stderr}`.match(/account (\S+)/)?.[1]
    check.detail = auth.code === 0 ? `signed in${account ? ` as ${account}` : ''}` : 'not signed in'
  }
  return check
}

/** Checks git, gh, Claude Code and the Cursor CLI in every runtime on this machine. */
export async function checkTools(runtimes: Runtime[] = availableRuntimes()): Promise<ToolCheck[]> {
  const tools = Object.keys(VERSION_COMMANDS) as ToolCheck['tool'][]
  const checks = runtimes.flatMap((runtime) => {
    const runner = runnerFor(runtime)
    const label = runtimeLabel(runtime)
    return tools.map((tool) => checkTool(runner, tool, label))
  })
  return Promise.all(checks)
}
