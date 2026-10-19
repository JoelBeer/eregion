import type { ChildProcess } from 'node:child_process'
import type { Runtime } from '@shared/types'
import { collect, start } from './process'
import type { ExecOptions, ExecResult, Runner } from './types'

/** Runs commands directly on the host: Mac, Linux, or Windows repos that live on Windows. */
export class NativeRunner implements Runner {
  readonly runtime: Runtime = { kind: 'native' }

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const [file, ...args] = argv
    return collect(file, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, timeoutMs: options.timeoutMs })
  }

  spawn(argv: string[], options: ExecOptions = {}): ChildProcess {
    const [file, ...args] = argv
    return start(file, args, { cwd: options.cwd, env: { ...process.env, ...options.env } })
  }

  shell(commandLine: string): string[] {
    return this.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', commandLine] : ['bash', '-lc', commandLine]
  }

  toHostPath(path: string): string {
    return path
  }

  fromHostPath(path: string): string {
    return path
  }
}
