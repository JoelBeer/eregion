import { spawn, type ChildProcess } from 'node:child_process'
import type { ExecResult } from './types'

export interface StartOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export function start(file: string, args: string[], options: StartOptions = {}): ChildProcess {
  return spawn(file, args, { cwd: options.cwd, env: options.env, windowsHide: true })
}

/** Runs a process to completion. A missing executable resolves with code 127 instead of throwing. */
export function collect(file: string, args: string[], options: StartOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = start(file, args, options)
    let stdout = ''
    let stderr = ''
    const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined

    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve({ code: error.code === 'ENOENT' ? 127 : 1, stdout, stderr: stderr || error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}
