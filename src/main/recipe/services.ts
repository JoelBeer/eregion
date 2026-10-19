import type { ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import type { ReadyCheck, Service } from '@shared/model'
import { render, type Lookup } from '@shared/template'
import type { Runner } from '../runner'

const PID_MARKER = '__EREGION_PID__'
const LOG_LIMIT = 400

export type ServiceState = 'starting' | 'ready' | 'failed' | 'stopped'

export interface RunningService {
  key: string
  name: string
  state: ServiceState
  /** Process id inside the runtime, used to stop the whole tree. */
  pid?: number
  openUrl: string | null
  log: string[]
  stop(): Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function httpResponds(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' })
    return response.status < 500
  } catch {
    return false
  }
}

export function portOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    const done = (open: boolean): void => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(1000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** Waits until the service answers, its process exits, or the timeout passes. */
export async function waitUntilReady(check: ReadyCheck, lookup: Lookup, exited: () => boolean): Promise<{ ready: boolean; reason?: string }> {
  if (check.kind === 'none') return { ready: true }
  const deadline = Date.now() + check.timeoutSec * 1000
  const target = render(check.kind === 'http' ? check.url : check.port, lookup).text
  while (Date.now() < deadline) {
    if (exited()) return { ready: false, reason: 'The process exited before it was ready' }
    const ok = check.kind === 'http' ? await httpResponds(target) : await portOpen(Number(target))
    if (ok) return { ready: true }
    await sleep(500)
  }
  return { ready: false, reason: `No answer from ${target} after ${check.timeoutSec} seconds` }
}

/**
 * Starts long-running services and stops them as a tree. On POSIX shells (Linux, macOS, WSL) the
 * service runs under a wrapper that prints its pid first, because from Windows the spawned process
 * is wsl.exe, not the service.
 */
export class ServiceManager {
  private readonly running = new Map<string, RunningService>()

  list(prefix = ''): RunningService[] {
    return [...this.running.values()].filter((service) => service.key.startsWith(prefix))
  }

  get(key: string): RunningService | undefined {
    return this.running.get(key)
  }

  async start(
    key: string,
    service: Pick<Service, 'name' | 'command' | 'readyCheck' | 'openUrl'>,
    runner: Runner,
    cwd: string,
    lookup: Lookup,
    onChange?: (service: RunningService) => void
  ): Promise<RunningService> {
    await this.stop(key)
    const command = render(service.command, lookup).text
    const posix = !(runner.runtime.kind === 'native' && process.platform === 'win32')
    const argv = posix ? runner.shell(`echo ${PID_MARKER}$$; ${command}`) : runner.shell(command)
    const child: ChildProcess = runner.spawn(argv, { cwd })
    let exited = false

    const entry: RunningService = {
      key,
      name: service.name,
      state: 'starting',
      pid: posix ? undefined : child.pid,
      openUrl: service.openUrl ? render(service.openUrl, lookup).text : null,
      log: [],
      stop: async () => {
        if (exited) return
        if (entry.pid !== undefined) await runner.killTree(entry.pid)
        child.kill()
        entry.state = 'stopped'
        onChange?.(entry)
      }
    }
    this.running.set(key, entry)

    const append = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.startsWith(PID_MARKER)) {
          entry.pid = Number(line.slice(PID_MARKER.length))
          continue
        }
        if (line.length > 0) entry.log.push(line)
      }
      if (entry.log.length > LOG_LIMIT) entry.log.splice(0, entry.log.length - LOG_LIMIT)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('exit', () => {
      exited = true
      if (entry.state !== 'stopped') {
        entry.state = entry.state === 'ready' ? 'stopped' : 'failed'
        onChange?.(entry)
      }
    })

    const { ready, reason } = await waitUntilReady(service.readyCheck, lookup, () => exited)
    if (entry.state === 'starting') {
      entry.state = ready ? 'ready' : 'failed'
      if (!ready && reason) entry.log.push(reason)
      onChange?.(entry)
    }
    return entry
  }

  async stop(key: string): Promise<void> {
    const entry = this.running.get(key)
    if (!entry) return
    await entry.stop()
    this.running.delete(key)
  }

  async stopAll(prefix = ''): Promise<void> {
    await Promise.all(this.list(prefix).map((service) => this.stop(service.key)))
  }
}
