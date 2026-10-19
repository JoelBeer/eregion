import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { git, makeRepo } from '../testing/git'
import { detectRepo, githubRepoFromRemote, parseEnv, runtimeForHostPath } from './detect'

describe('runtimeForHostPath', () => {
  it('turns a WSL UNC path into a WSL runtime on Windows', () => {
    expect(runtimeForHostPath('\\\\wsl.localhost\\Ubuntu\\home\\joel\\sites\\api', 'win32')).toEqual({ runtime: 'wsl:Ubuntu', path: '/home/joel/sites/api' })
  })

  it('keeps native paths native', () => {
    expect(runtimeForHostPath('C:\\code\\api', 'win32')).toEqual({ runtime: 'native', path: 'C:\\code\\api' })
    expect(runtimeForHostPath('/home/joel/sites/api', 'linux')).toEqual({ runtime: 'native', path: '/home/joel/sites/api' })
  })
})

describe('githubRepoFromRemote', () => {
  it('reads https and ssh remotes', () => {
    expect(githubRepoFromRemote('https://github.com/JoelBeer/word-magic.git')).toBe('JoelBeer/word-magic')
    expect(githubRepoFromRemote('git@github.com:JoelBeer/word-magic.git')).toBe('JoelBeer/word-magic')
    expect(githubRepoFromRemote('https://gitlab.com/a/b.git')).toBeNull()
  })
})

describe('parseEnv', () => {
  it('reads quoted values and ignores comments', () => {
    expect(parseEnv('# c\nAPP_NAME="Word Magic"\nAPP_URL=http://localhost:8100 # local\nexport X=1\n')).toEqual({
      APP_NAME: 'Word Magic',
      APP_URL: 'http://localhost:8100',
      X: '1'
    })
  })
})

describe.skipIf(process.platform === 'win32')('detectRepo', () => {
  it('suggests a Word Magic style recipe for a Laravel app with SQLite', async () => {
    const { clone, origin } = await makeRepo(
      {
        'composer.json': '{"require":{"laravel/framework":"^13.0"}}',
        artisan: '#!/usr/bin/env php',
        'package.json': '{"scripts":{"build":"vite build","dev":"vite"}}',
        'package-lock.json': '{}',
        '.env.example': 'APP_URL=http://localhost:8100\nDB_CONNECTION=sqlite\n',
        'database/seeders/DatabaseSeeder.php': '<?php'
      },
      'master'
    )
    git(clone, 'remote', 'set-url', 'origin', 'https://github.com/JoelBeer/word-magic.git')
    git(clone, 'remote', 'add', 'local', origin)
    await writeFile(join(clone, '.env'), 'APP_URL=http://localhost:8100\nDB_CONNECTION=sqlite\n')

    const detection = await detectRepo(clone, 'linux')
    expect(detection).toMatchObject({ runtime: 'native', name: 'clone', defaultBranch: 'master', githubRepo: 'JoelBeer/word-magic' })
    expect(detection.facts.map((fact) => fact.label)).toEqual(expect.arrayContaining(['Default branch', 'GitHub repo', 'Framework', 'Package manager', 'Database']))
    expect(detection.recipe.variables).toEqual([{ name: 'app_port', formula: '8100 + {{slot}}' }])
    expect(detection.recipe.setup.map((step) => step.config)).toEqual([
      { type: 'copy_file', from: '.env', to: '.env' },
      { type: 'set_env', file: '.env', values: [{ key: 'APP_URL', value: 'http://localhost:{{app_port}}' }] },
      { type: 'command', command: 'touch database/database.sqlite' },
      { type: 'command', command: 'composer install --no-interaction' },
      { type: 'command', command: 'npm install' },
      { type: 'command', command: 'php artisan migrate --seed --force' },
      { type: 'command', command: 'npm run build' }
    ])
    expect(detection.recipe.services).toEqual([
      expect.objectContaining({ name: 'app', command: 'php artisan serve --host=0.0.0.0 --port={{app_port}}' })
    ])
  })

  it('suggests a per-ticket MySQL database and its teardown', async () => {
    const { clone } = await makeRepo({ '.env.example': 'APP_URL=http://api.test\nDB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_USERNAME=root\n' })
    const detection = await detectRepo(clone, 'linux')
    expect(detection.recipe.variables).toContainEqual({ name: 'db_name', formula: 'clone_{{ticket.key | snake}}' })
    expect(detection.recipe.teardown[0].config).toEqual({ type: 'command', command: 'mysql -h 127.0.0.1 -u root -e "DROP DATABASE IF EXISTS {{db_name}}"' })
    expect(detection.warnings.join(' ')).toContain('passwords')
  })

  it('refuses a folder that is not a git repository', async () => {
    await expect(detectRepo('/tmp', 'linux')).rejects.toThrow("isn't a git repository")
  })
})
