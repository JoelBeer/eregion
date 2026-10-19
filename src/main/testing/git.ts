import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Runs git synchronously in a test repo with a fixed identity. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
  }).trim()
}

/**
 * Creates a bare "origin" and a clone of it with the given files committed on `branch`, so tests
 * can exercise fetch, worktrees and default-branch detection without touching real repos.
 */
export async function makeRepo(files: Record<string, string>, branch = 'main'): Promise<{ root: string; clone: string; origin: string }> {
  const root = await mkdtemp(join(tmpdir(), 'eregion-git-'))
  const origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  const clone = join(root, 'clone')
  git(root, 'init', '--bare', '-b', branch, origin)
  await mkdir(seed)
  git(seed, 'init', '-b', branch)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(seed, path)), { recursive: true })
    await writeFile(join(seed, path), content)
  }
  git(seed, 'add', '-A')
  git(seed, 'commit', '-m', 'Initial commit')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-u', 'origin', branch)
  git(root, 'clone', origin, clone)
  return { root, clone, origin }
}
