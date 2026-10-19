import { describe, expect, it } from 'vitest'
import { hostToWslPath, parseDistroList, wslArgs, wslToHostPath, WslRunner } from './wsl'
import { NativeRunner } from './native'

describe('wslArgs', () => {
  it('runs a command in the distro', () => {
    expect(wslArgs('Ubuntu', ['git', 'status'])).toEqual(['-d', 'Ubuntu', '--', 'git', 'status'])
  })

  it('sets the working directory', () => {
    expect(wslArgs('Ubuntu', ['ls'], { cwd: '/home/joel/site' })).toEqual(['-d', 'Ubuntu', '--cd', '/home/joel/site', '--', 'ls'])
  })

  it('passes environment variables through env, because Windows variables do not cross into WSL', () => {
    expect(wslArgs('Ubuntu', ['php', 'artisan', 'serve'], { env: { APP_PORT: '8101', DEBUG: '1' } })).toEqual([
      '-d', 'Ubuntu', '--', 'env', 'APP_PORT=8101', 'DEBUG=1', 'php', 'artisan', 'serve'
    ])
  })
})

describe('WSL paths', () => {
  it('converts a Linux path to a Windows UNC path', () => {
    expect(wslToHostPath('Ubuntu', '/home/joel/sites/word-magic')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\joel\\sites\\word-magic')
  })

  it('converts UNC paths back, including the older wsl$ form and any letter case', () => {
    expect(hostToWslPath('Ubuntu', '\\\\wsl.localhost\\Ubuntu\\home\\joel\\x')).toBe('/home/joel/x')
    expect(hostToWslPath('Ubuntu', '\\\\wsl$\\ubuntu\\home\\joel')).toBe('/home/joel')
    expect(hostToWslPath('Ubuntu', '\\\\wsl.localhost\\Ubuntu')).toBe('/')
  })

  it('leaves paths for other distros and plain Windows paths alone', () => {
    expect(hostToWslPath('Ubuntu', '\\\\wsl.localhost\\Debian\\home')).toBe('\\\\wsl.localhost\\Debian\\home')
    expect(hostToWslPath('Ubuntu', 'C:\\Users\\joel')).toBe('C:\\Users\\joel')
  })

  it('round-trips through the runner', () => {
    const runner = new WslRunner('Ubuntu')
    expect(runner.fromHostPath(runner.toHostPath('/home/joel/a b'))).toBe('/home/joel/a b')
  })
})

describe('parseDistroList', () => {
  it('reads the UTF-16 output of wsl --list --quiet', () => {
    const output = Buffer.from('Ubuntu\r\ndocker-desktop\r\n\r\n', 'utf16le')
    expect(parseDistroList(output)).toEqual(['Ubuntu', 'docker-desktop'])
  })
})

describe('shell', () => {
  it('uses a login shell so the user PATH (for example ~/.local/bin) is loaded', () => {
    expect(new WslRunner('Ubuntu').shell('composer install')).toEqual(['bash', '-lc', 'composer install'])
    expect(new NativeRunner('linux').shell('ls')).toEqual(['bash', '-lc', 'ls'])
    expect(new NativeRunner('win32').shell('dir')).toEqual(['cmd.exe', '/d', '/s', '/c', 'dir'])
  })
})
