import type { ChildProcess } from 'node:child_process'
import type { Runtime } from '@shared/types'

/**
 * The runner for a runtime; given the project, its commands act as the project's GitHub account (its git and
 * gh calls, and the agents working on it).
 */
export type RunnerFor = (runtime: string, project?: { github?: { account?: string | null } }) => Runner

export interface ExecOptions {
  /** Working directory, as a path inside the runner's runtime (a Linux path for WSL). */
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** Written to the process's stdin, which is then closed. */
  input?: string
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Knows where and how to execute, and nothing about projects. Every process Eregion starts goes
 * through the runner of the repo it belongs to, so native and WSL repos behave the same.
 * Paths are always paths inside the runtime.
 */
export interface Runner {
  readonly runtime: Runtime
  /** Runs a command to completion and collects its output. */
  exec(argv: string[], options?: ExecOptions): Promise<ExecResult>
  /** Starts a long-running process (agents, services) and streams its output. */
  spawn(argv: string[], options?: ExecOptions): ChildProcess
  /** Wraps a recipe's shell command line so it runs in a login shell, which loads the user's PATH. */
  shell(commandLine: string): string[]
  readFile(path: string): Promise<string | null>
  writeFile(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  copyFile(from: string, to: string): Promise<void>
  /** Stops a process and everything it started. `pid` is the process id inside the runtime. */
  killTree(pid: number): Promise<void>
  /** Joins path segments the way the runtime expects. */
  join(...segments: string[]): string
  /** Converts a path inside the runtime to one the host can open, and back. */
  toHostPath(path: string): string
  fromHostPath(path: string): string
}

/**
 * Shell snippet that stops a process tree on Linux and macOS: children first, then the parent.
 * Used by both runners, because WSL processes can only be reached from inside WSL.
 */
export function posixKillTree(pid: number): string {
  return `kt() { for c in $(pgrep -P "$1" 2>/dev/null); do kt "$c"; done; kill -TERM "$1" 2>/dev/null; }; kt ${pid}; true`
}
