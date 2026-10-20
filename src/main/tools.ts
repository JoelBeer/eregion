import type { Runtime, ToolCheck } from '@shared/types'
import { availableRuntimes, runnerFor, runtimeLabel } from './runner'
import type { Runner } from './runner'

const VERSION_COMMANDS: Record<string, string> = {
  git: 'git --version',
  gh: 'gh --version',
  claude: 'claude --version',
  'cursor-agent': 'cursor-agent --version',
  codex: 'codex --version'
}

/** Pulls the first version-looking token out of a tool's --version output. */
export function parseVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/)?.[0]
}

async function checkTool(runner: Runner, tool: string, label: string): Promise<ToolCheck> {
  const result = await runner.exec(runner.shell(VERSION_COMMANDS[tool] ?? `${tool} --version`), { timeoutMs: 20_000 })
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

/** Checks git, gh, Claude Code, the Cursor CLI and Codex in every runtime on this machine. */
export async function checkTools(runtimes: Runtime[] = availableRuntimes()): Promise<ToolCheck[]> {
  const tools = Object.keys(VERSION_COMMANDS)
  const checks = runtimes.flatMap((runtime) => {
    const runner = runnerFor(runtime)
    const label = runtimeLabel(runtime)
    return tools.map((tool) => checkTool(runner, tool, label))
  })
  return Promise.all(checks)
}

/**
 * Checks one command (an agent's, say) in every runtime on this machine: found when it's on the PATH, with
 * its version if it answers --version (not every program does).
 */
export async function checkCommand(command: string, runtimes: Runtime[] = availableRuntimes()): Promise<ToolCheck[]> {
  return Promise.all(
    runtimes.map(async (runtime) => {
      const runner = runnerFor(runtime)
      const check: ToolCheck = { tool: command, runtime: runtimeLabel(runtime), found: false }
      const found = await runner.exec(runner.shell(`command -v ${command}`), { timeoutMs: 20_000 })
      if (found.code !== 0) return check
      const version = await runner.exec(runner.shell(`${command} --version`), { timeoutMs: 20_000 })
      return { ...check, found: true, version: version.code === 0 ? parseVersion(version.stdout) : undefined }
    })
  )
}
