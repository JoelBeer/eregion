import type { ChildProcess } from 'node:child_process'
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, posix, win32 } from 'node:path'
import type { Runtime } from '@shared/types'
import { collect, start } from './process'
import { posixKillTree, type ExecOptions, type ExecResult, type Runner } from './types'

/** Runs commands directly on the host: Mac, Linux, or Windows repos that live on Windows. */
export class NativeRunner implements Runner {
  readonly runtime: Runtime = { kind: 'native' }

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const [file, ...args] = argv
    return collect(file, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, timeoutMs: options.timeoutMs, input: options.input })
  }

  spawn(argv: string[], options: ExecOptions = {}): ChildProcess {
    const [file, ...args] = argv
    return start(file, args, { cwd: options.cwd, env: { ...process.env, ...options.env } })
  }

  shell(commandLine: string): string[] {
    return this.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', commandLine] : ['bash', '-lc', commandLine]
  }

  async readFile(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return null
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  async copyFile(from: string, to: string): Promise<void> {
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
  }

  async killTree(pid: number): Promise<void> {
    if (this.platform === 'win32') {
      await collect('taskkill', ['/T', '/F', '/PID', String(pid)])
    } else {
      await collect('bash', ['-c', posixKillTree(pid)])
    }
  }

  join(...segments: string[]): string {
    return this.platform === 'win32' ? win32.join(...segments) : posix.join(...segments)
  }

  toHostPath(path: string): string {
    return path
  }

  fromHostPath(path: string): string {
    return path
  }
}
