import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NativeRunner } from './native'

describe.skipIf(process.platform === 'win32')('NativeRunner files and processes', () => {
  const runner = new NativeRunner()

  it('writes, reads, checks and copies files, creating folders as needed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eregion-'))
    const file = runner.join(dir, 'a', '.env')
    await runner.writeFile(file, 'APP_URL=x\n')
    expect(await runner.readFile(file)).toBe('APP_URL=x\n')
    expect(await runner.exists(file)).toBe(true)
    expect(await runner.readFile(runner.join(dir, 'missing'))).toBeNull()
    await runner.copyFile(file, runner.join(dir, 'b', 'c', '.env'))
    expect(await runner.readFile(runner.join(dir, 'b', 'c', '.env'))).toBe('APP_URL=x\n')
  })

  it('passes input to a command on stdin', async () => {
    expect((await runner.exec(['cat'], { input: 'hello' })).stdout).toBe('hello')
  })

  it('stops a process and the children it started', async () => {
    const parent = spawn('bash', ['-c', 'sleep 30 & sleep 30 & wait'])
    await new Promise((resolve) => setTimeout(resolve, 200))
    const children = await runner.exec(['pgrep', '-P', String(parent.pid)])
    expect(children.stdout.trim().split('\n')).toHaveLength(2)

    const exited = new Promise((resolve) => parent.on('exit', resolve))
    await runner.killTree(parent.pid as number)
    await exited
    for (const child of children.stdout.trim().split('\n')) {
      expect((await runner.exec(['kill', '-0', child])).code).not.toBe(0)
    }
  })
})
