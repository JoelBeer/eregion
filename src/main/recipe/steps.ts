import type { Step, StepConfig } from '@shared/model'
import { describeStep } from '@shared/recipe'
import { render, type Lookup } from '@shared/template'
import type { Runner } from '../runner'
import { setEnvValues } from './env'

export type StepStatus = 'done' | 'skipped' | 'failed' | 'failed-continued'

export interface StepResult {
  index: number
  label: string
  status: StepStatus
  output: string
  durationMs: number
}

export interface StepTarget {
  runner: Runner
  /** The worktree the steps run in. */
  cwd: string
  /** The original clone, for "Copy file from main repo". */
  mainPath: string
  lookup: Lookup
}

const DEFAULT_TIMEOUT_SEC = 15 * 60

function fillOrThrow(text: string, lookup: Lookup): string {
  const result = render(text, lookup)
  if (result.missing.length > 0) throw new Error(`Unknown placeholder: ${result.missing.join(', ')}`)
  if (result.unknownFilters.length > 0) throw new Error(`Unknown filter: ${result.unknownFilters.join(', ')}`)
  return result.text
}

async function runOne(config: StepConfig, target: StepTarget, timeoutSec: number): Promise<{ ok: boolean; output: string }> {
  const { runner, cwd, lookup } = target
  const resolvePath = (path: string): string => (path.startsWith('/') ? path : runner.join(cwd, fillOrThrow(path, lookup)))

  switch (config.type) {
    case 'command': {
      const result = await runner.exec(runner.shell(fillOrThrow(config.command, lookup)), { cwd, timeoutMs: timeoutSec * 1000 })
      return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() || `exit code ${result.code}` }
    }
    case 'script': {
      const args = config.args ? ` ${fillOrThrow(config.args, lookup)}` : ''
      const result = await runner.exec(runner.shell(`"${config.path}"${args}`), { cwd, timeoutMs: timeoutSec * 1000 })
      return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() || `exit code ${result.code}` }
    }
    case 'set_env': {
      const file = resolvePath(config.file || '.env')
      const current = (await runner.readFile(file)) ?? ''
      const values = config.values.map((entry) => ({ key: entry.key, value: fillOrThrow(entry.value, lookup) }))
      await runner.writeFile(file, setEnvValues(current, values))
      return { ok: true, output: values.map((entry) => `${entry.key}=${entry.value}`).join('\n') }
    }
    case 'copy_file': {
      const from = config.from.startsWith('/') ? config.from : runner.join(target.mainPath, fillOrThrow(config.from, lookup))
      if (!(await runner.exists(from))) return { ok: false, output: `${from} doesn't exist in the main repo` }
      await runner.copyFile(from, resolvePath(config.to || config.from))
      return { ok: true, output: `Copied ${from}` }
    }
  }
}

/**
 * Runs steps in order. A failing step stops the run unless it is marked "continue on error".
 * `onStep` is called as each step starts (status undefined) and when it ends.
 */
export async function runSteps(
  steps: Pick<Step, 'config' | 'options'>[],
  target: StepTarget,
  onStep?: (result: Omit<StepResult, 'status' | 'output' | 'durationMs'> & Partial<StepResult>) => void
): Promise<{ ok: boolean; results: StepResult[] }> {
  const results: StepResult[] = []
  for (const [index, step] of steps.entries()) {
    const label = describeStep(step.config, target.lookup)
    const started = Date.now()
    onStep?.({ index, label })
    let status: StepStatus
    let output: string
    try {
      if (step.options.onlyIfMissing && (await target.runner.exists(target.runner.join(target.cwd, step.options.onlyIfMissing)))) {
        status = 'skipped'
        output = `${step.options.onlyIfMissing} already exists`
      } else {
        const result = await runOne(step.config, target, step.options.timeoutSec ?? DEFAULT_TIMEOUT_SEC)
        status = result.ok ? 'done' : step.options.continueOnError ? 'failed-continued' : 'failed'
        output = result.output
      }
    } catch (error) {
      status = step.options.continueOnError ? 'failed-continued' : 'failed'
      output = (error as Error).message
    }
    const result: StepResult = { index, label, status, output, durationMs: Date.now() - started }
    results.push(result)
    onStep?.(result)
    if (status === 'failed') return { ok: false, results }
  }
  return { ok: true, results }
}
