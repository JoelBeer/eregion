import type { Runner } from '../runner'

export class GitError extends Error {}

export async function gitIn(runner: Runner, cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const result = await runner.exec(['git', ...args], { cwd, timeoutMs })
  if (result.code !== 0) {
    throw new GitError(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout.trim()
}

export async function gitOk(runner: Runner, cwd: string, args: string[]): Promise<boolean> {
  return (await runner.exec(['git', ...args], { cwd, timeoutMs: 60_000 })).code === 0
}

/**
 * The ref new work starts from: origin/<branch> after a fetch, or the local branch when the
 * repo has no origin or the fetch fails (offline). Returns the ref and whether the fetch worked.
 */
export async function baseRef(runner: Runner, mainPath: string, branch: string): Promise<{ ref: string; fetched: boolean }> {
  let fetched = false
  if (await gitOk(runner, mainPath, ['remote', 'get-url', 'origin'])) {
    fetched = (await runner.exec(['git', 'fetch', '--prune', 'origin', branch], { cwd: mainPath, timeoutMs: 120_000 })).code === 0
  }
  if (await gitOk(runner, mainPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])) {
    return { ref: `origin/${branch}`, fetched }
  }
  return { ref: branch, fetched }
}

/** Worktree paths git knows about for a repo. */
export async function worktreePaths(runner: Runner, mainPath: string): Promise<string[]> {
  const output = await gitIn(runner, mainPath, ['worktree', 'list', '--porcelain'])
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
}

export async function branchExists(runner: Runner, mainPath: string, branch: string): Promise<boolean> {
  return gitOk(runner, mainPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
}

/**
 * Makes sure a worktree exists at `path`: on `branch` (created from `base` when new), or detached
 * at `base` when `branch` is null. An existing worktree is reused, and a detached one is switched
 * onto the branch when the ticket now needs to change that repo.
 */
export async function ensureWorktree(runner: Runner, mainPath: string, path: string, base: string, branch: string | null): Promise<'created' | 'reused' | 'switched'> {
  const existing = (await worktreePaths(runner, mainPath)).includes(path)
  if (existing) {
    if (!branch) return 'reused'
    const current = await gitIn(runner, path, ['branch', '--show-current'])
    if (current === branch) return 'reused'
    if (await branchExists(runner, mainPath, branch)) {
      await gitIn(runner, path, ['switch', branch])
    } else {
      await gitIn(runner, path, ['switch', '-c', branch])
    }
    return 'switched'
  }
  await gitIn(runner, mainPath, ['worktree', 'prune'])
  if (!branch) {
    await gitIn(runner, mainPath, ['worktree', 'add', '--detach', path, base])
  } else if (await branchExists(runner, mainPath, branch)) {
    await gitIn(runner, mainPath, ['worktree', 'add', path, branch])
  } else {
    await gitIn(runner, mainPath, ['worktree', 'add', '-b', branch, path, base])
  }
  return 'created'
}

export async function removeWorktree(runner: Runner, mainPath: string, path: string): Promise<void> {
  if ((await worktreePaths(runner, mainPath)).includes(path)) {
    await gitIn(runner, mainPath, ['worktree', 'remove', '--force', path])
  }
  await gitIn(runner, mainPath, ['worktree', 'prune'])
}
