import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commandEnvironment, defaultShell, parseEnvironment, readLoginEnvironment, withoutAppOnly } from './environment'
import { NativeRunner } from './native'

describe('parseEnvironment', () => {
  it('reads the variables between the markers and ignores what startup files print around them', () => {
    const output = 'Welcome back!\nM' + 'PATH=/opt/homebrew/bin:/usr/bin\0NOTE=two\nlines\0' + 'M\nbye'
    expect(parseEnvironment(output, 'M')).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin', NOTE: 'two\nlines' })
  })

  it('drops the variables that describe the shell itself', () => {
    expect(parseEnvironment('MPWD=/x\0SHLVL=2\0_=/usr/bin/env\0OLDPWD=/y\0HOME=/h\0M', 'M')).toEqual({ HOME: '/h' })
  })

  it('returns nothing when the markers are missing', () => {
    expect(parseEnvironment('zsh: command not found', 'M')).toEqual({})
  })
})

describe('withoutAppOnly', () => {
  it('leaves out what starting Eregion with npm run added', () => {
    const env = withoutAppOnly(
      {
        HOME: '/h',
        NODE_ENV: 'production',
        INIT_CWD: '/eregion',
        npm_config_prefix: '/x',
        npm_lifecycle_event: 'preview',
        PATH: '/eregion/node_modules/.bin:/node_modules/.bin:/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin:/opt/homebrew/bin:/usr/bin'
      },
      ':'
    )
    expect(env).toEqual({ HOME: '/h', PATH: '/opt/homebrew/bin:/usr/bin' })
  })

  it('cleans a Windows Path too', () => {
    expect(withoutAppOnly({ Path: 'C:\\eregion\\node_modules\\.bin;C:\\Windows' }, ';')).toEqual({ Path: 'C:\\Windows' })
  })
})

describe('commandEnvironment', () => {
  const saved = process.env.NODE_ENV
  afterEach(() => {
    process.env.NODE_ENV = saved
  })

  it("leaves out Eregion's own NODE_ENV but keeps one a command sets", () => {
    process.env.NODE_ENV = 'production'
    expect(commandEnvironment()).not.toHaveProperty('NODE_ENV')
    expect(commandEnvironment({ NODE_ENV: 'test' }).NODE_ENV).toBe('test')
  })
})

describe.skipIf(process.platform === 'win32')('readLoginEnvironment', () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'eregion-home-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it("reads the login shell's startup files, without Eregion's NODE_ENV", async () => {
    await writeFile(join(home, '.bash_profile'), 'echo "hello from the profile"\nexport EREGION_LOGIN=yes\n')
    const env = await readLoginEnvironment('bash', { PATH: process.env.PATH, HOME: home, NODE_ENV: 'production' })
    expect(env.EREGION_LOGIN).toBe('yes')
    expect(env.HOME).toBe(home)
    expect(env).not.toHaveProperty('NODE_ENV')
  })

  it('gives up on time when a startup file leaves something running in the background', async () => {
    await writeFile(join(home, '.bash_profile'), 'sleep 20 &\n')
    const started = Date.now()
    expect(await readLoginEnvironment('bash', { PATH: process.env.PATH, HOME: home }, 500)).toEqual({})
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('returns nothing when the shell is missing', async () => {
    expect(await readLoginEnvironment('definitely-not-a-shell-eregion', { HOME: home })).toEqual({})
  })
})

describe('defaultShell', () => {
  it('falls back to zsh on macOS and bash elsewhere', () => {
    expect(defaultShell('darwin')).toBe('/bin/zsh')
    expect(defaultShell('linux')).toBe('/bin/bash')
  })
})

describe.skipIf(process.platform === 'win32')('NativeRunner environment', () => {
  const saved = process.env.NODE_ENV
  afterEach(() => {
    process.env.NODE_ENV = saved
  })

  it("doesn't pass Eregion's NODE_ENV to the commands it runs", async () => {
    process.env.NODE_ENV = 'production'
    const runner = new NativeRunner()
    const result = await runner.exec(runner.shell('echo "NODE_ENV=${NODE_ENV-unset}"'))
    expect(result.stdout).toBe('NODE_ENV=unset\n')
  })
})
