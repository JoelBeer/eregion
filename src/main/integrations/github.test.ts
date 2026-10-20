import { describe, expect, it } from 'vitest'
import type { ExecOptions, ExecResult, Runner } from '../runner/types'
import { GhCli, parseChecks, parsePrUrl, runIdFromLink, trimJobLog } from './github'

function fakeRunner(reply: (argv: string[]) => ExecResult): { runner: Runner; calls: { argv: string[]; options?: ExecOptions }[] } {
  const calls: { argv: string[]; options?: ExecOptions }[] = []
  const runner = {
    exec: async (argv: string[], options?: ExecOptions) => {
      calls.push({ argv, options })
      return reply(argv)
    }
  } as unknown as Runner
  return { runner, calls }
}

describe('GhCli', () => {
  it('opens a draft PR with the body on stdin and returns its URL', async () => {
    const { runner, calls } = fakeRunner(() => ({ code: 0, stdout: 'Creating pull request\nhttps://github.com/me/app/pull/12\n', stderr: '' }))
    const url = await new GhCli().createPr(runner, '/work/app', { base: 'main', branch: 'wm-1-hints', title: 'WM-1: Hints', body: 'Body text', draft: true })
    expect(url).toBe('https://github.com/me/app/pull/12')
    expect(calls[0].argv).toEqual(['gh', 'pr', 'create', '--base', 'main', '--head', 'wm-1-hints', '--title', 'WM-1: Hints', '--body-file', '-', '--draft'])
    expect(calls[0].options).toMatchObject({ cwd: '/work/app', input: 'Body text' })
  })

  it('updates a PR body through the REST API', async () => {
    const { runner, calls } = fakeRunner(() => ({ code: 0, stdout: '{}', stderr: '' }))
    await new GhCli().setPrBody(runner, '/work/app', 'https://github.com/me/app/pull/12', 'New body')
    expect(calls[0].argv).toEqual(['gh', 'api', '-X', 'PATCH', 'repos/me/app/pulls/12', '--input', '-'])
    expect(JSON.parse(calls[0].options?.input ?? '')).toEqual({ body: 'New body' })
  })

  it('reads checks even though gh exits non-zero while they fail', async () => {
    const { runner } = fakeRunner(() => ({ code: 1, stdout: '[{"name":"tests","workflow":"CI","bucket":"fail","link":"https://github.com/me/app/actions/runs/55/job/66"}]', stderr: '' }))
    const checks = await new GhCli().checks(runner, '/work/app', 'https://github.com/me/app/pull/12', true)
    expect(checks).toEqual({ checks: [{ name: 'tests', workflow: 'CI', bucket: 'fail', link: 'https://github.com/me/app/actions/runs/55/job/66' }], scope: 'required' })
  })

  it('treats "no checks reported" as no checks', async () => {
    const { runner } = fakeRunner(() => ({ code: 1, stdout: '', stderr: "no checks reported on the 'wm-1' branch" }))
    expect(await new GhCli().checks(runner, '/w', 'https://github.com/me/app/pull/1', false)).toEqual({ checks: [], scope: 'all' })
  })

  it('watches all checks when the repo requires none', async () => {
    // What Word Magic's PR #2 showed: no branch protection, so --required finds nothing.
    const { runner, calls } = fakeRunner((argv) =>
      argv.includes('--required')
        ? { code: 1, stdout: '', stderr: "no required checks reported on the 'wm-1-add-a-colour-theme' branch" }
        : { code: 0, stdout: '[{"name":"lint","workflow":"CI","bucket":"pass","link":""},{"name":"tests","workflow":"CI","bucket":"pass","link":""}]', stderr: '' }
    )
    const result = await new GhCli().checks(runner, '/w', 'https://github.com/JoelBeer/word-magic/pull/2', true)
    expect(result.scope).toBe('all')
    expect(result.checks.map((check) => `${check.name} ${check.bucket}`)).toEqual(['lint pass', 'tests pass'])
    expect(calls).toHaveLength(2)
  })

  it('re-runs only the failed jobs of the check’s workflow run', async () => {
    const { runner, calls } = fakeRunner(() => ({ code: 0, stdout: '', stderr: '' }))
    await new GhCli().rerunFailed(runner, '/w', { name: 'tests', workflow: 'CI', bucket: 'fail', link: 'https://github.com/me/app/actions/runs/55/job/66' })
    expect(calls[0].argv).toEqual(['gh', 'run', 'rerun', '55', '--failed'])
  })
})

describe('GitHub helpers', () => {
  it('parses PR URLs, run ids and check lists', () => {
    expect(parsePrUrl('https://github.com/JoelBeer/word-magic/pull/7')).toEqual({ repo: 'JoelBeer/word-magic', number: 7 })
    expect(runIdFromLink('https://github.com/me/app/actions/runs/123/job/4')).toBe('123')
    expect(runIdFromLink('https://ci.example.com/build/9')).toBeNull()
    expect(parseChecks('[{"name":"lint","bucket":"weird"}]')).toEqual([{ name: 'lint', workflow: '', bucket: 'pending', link: '' }])
  })
})

describe('trimJobLog', () => {
  it('drops timestamps, colours and the clean-up after the error', () => {
    const log = [
      '2026-10-19T16:33:31.1Z ##[group]Run php artisan test --compact',
      '2026-10-19T16:33:31.5Z   \x1b[44;1m INFO \x1b[49;22m Test directory "tests/Unit" not found.',
      '2026-10-19T16:33:31.9Z ##[error]Process completed with exit code 2.',
      '2026-10-19T16:33:32.0Z Post job cleanup.'
    ].join('\n')
    expect(trimJobLog(log)).toBe('##[group]Run php artisan test --compact\n   INFO  Test directory "tests/Unit" not found.\n##[error]Process completed with exit code 2.')
  })

  it('reads the job log through the REST API', async () => {
    const { runner, calls } = fakeRunner(() => ({ code: 0, stdout: '2026-10-19T16:33:31.9Z ##[error]boom\n', stderr: '' }))
    const log = await new GhCli().failedLog(runner, '/w', { name: 'tests', workflow: 'CI', bucket: 'fail', link: 'https://github.com/JoelBeer/word-magic/actions/runs/39286315474/job/118173465266' })
    expect(calls[0].argv).toEqual(['gh', 'api', 'repos/JoelBeer/word-magic/actions/jobs/118173465266/logs'])
    expect(log).toBe('##[error]boom')
  })
})
