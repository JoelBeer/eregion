import type { ChildProcess } from 'node:child_process'
import type { Runtime } from '@shared/types'

export interface ExecOptions {
  /** Working directory, as a path inside the runner's runtime (a Linux path for WSL). */
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Knows where and how to execute, and nothing about projects. Every process Eregion starts goes
 * through the runner of the repo it belongs to, so native and WSL repos behave the same.
 */
export interface Runner {
  readonly runtime: Runtime
  /** Runs a command to completion and collects its output. */
  exec(argv: string[], options?: ExecOptions): Promise<ExecResult>
  /** Starts a long-running process (agents, services) and streams its output. */
  spawn(argv: string[], options?: ExecOptions): ChildProcess
  /** Wraps a recipe's shell command line so it runs in a login shell, which loads the user's PATH. */
  shell(commandLine: string): string[]
  /** Converts a path inside the runtime to one the host can open, and back. */
  toHostPath(path: string): string
  fromHostPath(path: string): string
}
