import type { ToolCheck } from './types'

/** First run can continue once git and a signed-in gh are found, plus at least one agent CLI. */
export function toolsReady(checks: ToolCheck[]): boolean {
  const found = (tool: ToolCheck['tool']): boolean => checks.some((check) => check.tool === tool && check.found)
  const ghSignedIn = checks.some((check) => check.tool === 'gh' && check.found && check.detail?.startsWith('signed in') === true)
  return found('git') && ghSignedIn && (found('claude') || found('cursor-agent'))
}
