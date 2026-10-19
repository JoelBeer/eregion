import { describe, expect, it } from 'vitest'
import { NativeRunner } from './native'

describe.skipIf(process.platform === 'win32')('NativeRunner', () => {
  const runner = new NativeRunner()

  it('collects output and the exit code', async () => {
    const result = await runner.exec(runner.shell('echo hello; echo oops >&2; exit 3'))
    expect(result).toEqual({ code: 3, stdout: 'hello\n', stderr: 'oops\n' })
  })

  it('runs in the given directory with extra environment variables', async () => {
    const result = await runner.exec(['bash', '-c', 'pwd; echo $EREGION_TEST'], { cwd: '/tmp', env: { EREGION_TEST: 'yes' } })
    expect(result.stdout).toBe('/tmp\nyes\n')
  })

  it('reports a missing executable as exit code 127 instead of throwing', async () => {
    const result = await runner.exec(['definitely-not-a-real-command-eregion'])
    expect(result.code).toBe(127)
  })

  it('kills a command that runs past its timeout', async () => {
    const started = Date.now()
    const result = await runner.exec(['sleep', '5'], { timeoutMs: 200 })
    expect(result.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
