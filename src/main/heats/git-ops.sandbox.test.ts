// Sandbox tests for Regatta's automatic git calls.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { addWorktree, commitAll, diffBetween, diffFrom, dirtyTracked, hasChanges, headSha, sandboxGitArgs } from './git-ops'
import { scanStorage } from '../storage'

const IDENTITY = ['-c', 'user.name=Regatta Test', '-c', 'user.email=test@regatta.local', '-c', 'commit.gpgsign=false']

const dirs: string[] = []
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function sh(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    ...(env ? { env } : {})
  })
}

async function withIsolatedGitConfig<T>(gitconfigPath: string, fn: () => Promise<T>): Promise<T> {
  const prevGlobal = process.env['GIT_CONFIG_GLOBAL']
  const prevNoSystem = process.env['GIT_CONFIG_NOSYSTEM']
  process.env['GIT_CONFIG_GLOBAL'] = gitconfigPath
  process.env['GIT_CONFIG_NOSYSTEM'] = '1'
  try {
    return await fn()
  } finally {
    if (prevGlobal === undefined) delete process.env['GIT_CONFIG_GLOBAL']
    else process.env['GIT_CONFIG_GLOBAL'] = prevGlobal
    if (prevNoSystem === undefined) delete process.env['GIT_CONFIG_NOSYSTEM']
    else process.env['GIT_CONFIG_NOSYSTEM'] = prevNoSystem
  }
}

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('1. Finding the filters fails closed (P1)', () => {
  it('refuses commitAll and diffFrom when git config output is over the 8 MiB limit, and never runs the clean filter', async () => {
    const repo = temp('regatta-sandbox-overlimit-')
    sh(['init', '-b', 'main'], repo)
    sh(['config', 'user.name', 'Regatta Test'], repo)
    sh(['config', 'user.email', 'test@regatta.local'], repo)

    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=held\n')
    writeFileSync(join(repo, 'work.txt'), 'initial\n')
    sh(['add', '.gitattributes', 'work.txt'], repo)
    sh([...IDENTITY, 'commit', '-m', 'initial'], repo)
    const base = await headSha(repo)

    const box = temp('regatta-sandbox-overlimit-box-')
    const marker = join(box, 'clean-filter-ran')
    const cleanScript = join(box, 'clean.sh')
    writeFileSync(cleanScript, `#!/bin/sh\n: > '${marker}'\ncat\n`, { mode: 0o755 })

    // Build a valid gitconfig whose filter.* --get-regexp output exceeds 8 MiB (MAX_BUFFER).
    const chunk = 'x'.repeat(64 * 1024)
    const lines: string[] = [
      '[user]',
      '\tname = Regatta Test',
      '\temail = test@regatta.local',
      '[filter "held"]',
      `\tclean = ${cleanScript}`
    ]
    for (let i = 0; i < 140; i++) {
      lines.push(`[filter "pad${i}"]`, `\tsmudge = ${chunk}`)
    }
    const gitconfig = join(box, 'gitconfig')
    writeFileSync(gitconfig, lines.join('\n') + '\n')

    // Modify work.txt so any git status / diff / add that runs without filter overrides or after failing open would invoke cleanScript.
    writeFileSync(join(repo, 'work.txt'), 'changed on disk\n')

    await withIsolatedGitConfig(gitconfig, async () => {
      await expect(diffFrom(repo, base)).rejects.toThrow(/buffer|limit|config/i)
      expect(existsSync(marker)).toBe(false)

      await expect(diffBetween(repo, base, base)).rejects.toThrow(/buffer|limit|config/i)
      expect(existsSync(marker)).toBe(false)

      await expect(commitAll(repo, 'should refuse')).rejects.toThrow(/buffer|limit|config/i)
      expect(existsSync(marker)).toBe(false)
    })
  }, 60_000)

  it('refuses when git config fails with a syntax error or when git cannot be started', async () => {
    const repo = temp('regatta-sandbox-badconfig-')
    sh(['init', '-b', 'main'], repo)
    writeFileSync(join(repo, 'a.txt'), 'hello\n')
    sh(['add', 'a.txt'], repo)
    sh([...IDENTITY, 'commit', '-m', 'init'], repo)
    const base = await headSha(repo)

    const box = temp('regatta-sandbox-badconfig-box-')
    const badConfig = join(box, 'bad-gitconfig')
    writeFileSync(badConfig, '[filter "broken"\n\tclean = cat\n')

    await withIsolatedGitConfig(badConfig, async () => {
      await expect(sandboxGitArgs(repo)).rejects.toThrow(/config|fatal/i)
      await expect(diffFrom(repo, base)).rejects.toThrow(/config|fatal/i)
      await expect(commitAll(repo, 'should refuse')).rejects.toThrow(/config|fatal/i)
    })

    // Git failing to start (empty PATH).
    await expect(sandboxGitArgs(repo, { PATH: '/nonexistent-bin-dir' })).rejects.toThrow(/git config|ENOENT/i)
  }, 30_000)

  it('(a1) never runs a clean filter whose command ends in .clean during diffFrom, and commitAll refuses', async () => {
    const repo = temp('regatta-sandbox-dotclean-')
    sh(['init', '-b', 'main'], repo)
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=f\n')
    sh(['add', '.'], repo)
    sh([...IDENTITY, 'commit', '-m', 'init'], repo)

    const scripts = temp('regatta-sandbox-dotclean-scripts-')
    const marker = join(scripts, 'ran-dotclean')
    const scriptPath = join(scripts, 'strip.clean')
    writeFileSync(scriptPath, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 })
    sh(['config', 'filter.f.clean', scriptPath], repo)

    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    const stat = await diffFrom(repo, 'HEAD')
    expect(stat).toEqual({ files: 1, added: 1, removed: 1 })
    expect(existsSync(marker)).toBe(false)

    await expect(commitAll(repo, 'should refuse')).rejects.toThrow(/clean or process filter/i)
    expect(existsSync(marker)).toBe(false)
  }, 30_000)

  it('(a1b) refuses with its name when a filter driver or config hook name contains "="', async () => {
    const repoFilter = temp('regatta-sandbox-eq-filter-')
    sh(['init', '-b', 'main'], repoFilter)
    writeFileSync(join(repoFilter, 'a.txt'), 'a\n')
    writeFileSync(join(repoFilter, '.gitattributes'), '*.txt filter=a=b\n')
    sh(['add', '.'], repoFilter)
    sh([...IDENTITY, 'commit', '-m', 'init'], repoFilter)

    const scripts = temp('regatta-sandbox-eq-scripts-')
    const filterMarker = join(scripts, 'ran-eq-filter')
    const filterScript = join(scripts, 'filter.sh')
    writeFileSync(filterScript, `#!/bin/sh\ntouch "${filterMarker}"\ncat\n`, { mode: 0o755 })
    sh(['config', 'filter.a=b.clean', filterScript], repoFilter)
    writeFileSync(join(repoFilter, 'a.txt'), 'changed\n')

    await expect(sandboxGitArgs(repoFilter)).rejects.toThrow(/a=b/)
    await expect(diffFrom(repoFilter, 'HEAD')).rejects.toThrow(/a=b/)
    await expect(commitAll(repoFilter, 'should refuse')).rejects.toThrow(/a=b/)
    expect(existsSync(filterMarker)).toBe(false)

    const repoHook = temp('regatta-sandbox-eq-hook-')
    sh(['init', '-b', 'main'], repoHook)
    writeFileSync(join(repoHook, 'a.txt'), 'a\n')
    sh(['add', '.'], repoHook)
    sh([...IDENTITY, 'commit', '-m', 'init'], repoHook)

    const hookMarker = join(scripts, 'ran-eq-hook')
    const hookScript = join(scripts, 'hook.sh')
    writeFileSync(hookScript, `#!/bin/sh\ntouch "${hookMarker}"\n`, { mode: 0o755 })
    sh(['config', 'hook.a=b.event', 'pre-commit'], repoHook)
    sh(['config', 'hook.a=b.command', hookScript], repoHook)
    writeFileSync(join(repoHook, 'a.txt'), 'changed\n')

    await expect(sandboxGitArgs(repoHook)).rejects.toThrow(/a=b/)
    await expect(diffFrom(repoHook, 'HEAD')).rejects.toThrow(/a=b/)
    await expect(commitAll(repoHook, 'should refuse')).rejects.toThrow(/a=b/)
    expect(existsSync(hookMarker)).toBe(false)
  }, 30_000)

  it('finds a clean filter whose value starts with a newline so commitAll refuses', async () => {
    const repo = temp('regatta-sandbox-nl-filter-')
    sh(['init', '-b', 'main'], repo)
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=lfs\n')
    writeFileSync(join(repo, 'a.txt'), 'initial\n')
    sh(['add', '.'], repo)
    sh([...IDENTITY, 'commit', '-m', 'init'], repo)

    const scripts = temp('regatta-sandbox-nl-scripts-')
    const marker = join(scripts, 'ran-nl-filter')
    const filterScript = join(scripts, 'filter.sh')
    writeFileSync(filterScript, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 })
    sh(['config', 'filter.lfs.clean', `\n${filterScript}`], repo)

    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    await diffFrom(repo, 'HEAD')
    expect(existsSync(marker)).toBe(false)

    await expect(commitAll(repo, 'should refuse')).rejects.toThrow(/clean or process filter/i)
    expect(existsSync(marker)).toBe(false)
  }, 30_000)
})

describe('2. No lazy fetch and no transport (P2)', () => {
  it('diffBetween and Storage runner fail on a missing partial-clone blob without invoking remote.origin.uploadpack, while allowHooks stays normal', async () => {
    const box = temp('regatta-sandbox-partial-')
    const origin = join(box, 'origin.git')
    mkdirSync(origin, { recursive: true })
    sh(['init', '--bare', '-b', 'main'], origin)
    sh(['config', 'uploadpack.allowFilter', 'true'], origin)

    const seed = join(box, 'seed')
    sh(['clone', `file://${origin}`, seed], box)
    sh(['config', 'user.name', 'Regatta Test'], seed)
    sh(['config', 'user.email', 'test@regatta.local'], seed)
    writeFileSync(join(seed, 'first.txt'), 'first blob content\n')
    sh(['add', 'first.txt'], seed)
    sh([...IDENTITY, 'commit', '-m', 'first'], seed)
    const firstSha = sh(['rev-parse', 'HEAD'], seed).trim()

    writeFileSync(join(seed, 'first.txt'), 'second blob content\n')
    sh(['add', 'first.txt'], seed)
    sh([...IDENTITY, 'commit', '-m', 'second'], seed)
    const secondSha = sh(['rev-parse', 'HEAD'], seed).trim()
    sh(['push', 'origin', 'main'], seed)

    const partial = join(box, 'partial')
    sh(['clone', '--filter=blob:none', '--no-checkout', `file://${origin}`, partial], box)

    const worktreesDir = join(box, 'worktrees')
    mkdirSync(worktreesDir, { recursive: true })
    const leftoverWt = join(worktreesDir, 'wt-leftover')
    sh(['worktree', 'add', '--no-checkout', '-b', 'regatta/leftover', leftoverWt, firstSha], partial)

    const marker = join(box, 'uploadpack-ran')
    const uploadpackScript = join(box, 'spy-upload-pack.sh')
    writeFileSync(
      uploadpackScript,
      `#!/bin/sh\n: > '${marker}'\nexec git-upload-pack "$@"\n`,
      { mode: 0o755 }
    )
    sh(['config', 'remote.origin.uploadpack', uploadpackScript], partial)

    // Verify that firstSha's blob is genuinely missing in the partial clone.
    await expect(diffBetween(partial, firstSha, secondSha)).rejects.toThrow(/missing|unable to read|bad object|cannot read|promisor|lazy/i)
    expect(existsSync(marker)).toBe(false)

    // Storage's runner also sets GIT_NO_LAZY_FETCH=1 and GIT_ALLOW_PROTOCOL= and never contacts the remote.
    const report = await scanStorage({
      dataDir: join(box, 'data'),
      worktreesDir,
      checkpointsDir: join(box, 'cp'),
      accountsDir: join(box, 'acc'),
      inUse: () => []
    })
    expect(report.leftovers.length).toBe(1)
    expect(existsSync(marker)).toBe(false)

    // Calls with allowHooks (such as addWorktree) stay as the user's own git would behave and can fetch the missing blob.
    const wtPath = join(worktreesDir, 'wt-allow-hooks')
    await addWorktree(partial, wtPath, 'regatta/test-wt', firstSha)
    expect(existsSync(marker)).toBe(true)
  }, 60_000)
})

describe('3. A failed measurement is not zero (P2)', () => {
  it('diffFrom, diffBetween and hasChanges throw on git failures instead of returning clean/NO_CHANGES, while refresh needs-update and needs-merge are not failures', async () => {
    const repo = temp('regatta-sandbox-measure-')
    sh(['init', '-b', 'main'], repo)
    sh(['config', 'user.name', 'Regatta Test'], repo)
    sh(['config', 'user.email', 'test@regatta.local'], repo)
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\n')
    sh(['add', 'tracked.txt'], repo)
    sh([...IDENTITY, 'commit', '-m', 'init'], repo)
    const base = await headSha(repo)

    // Modify tracked.txt so update-index --refresh sees "tracked.txt: needs update" (exit 1), which is not a failure.
    writeFileSync(join(repo, 'tracked.txt'), 'line 1\nline 2\n')
    const stat = await diffFrom(repo, base)
    expect(stat).toEqual({ files: 1, added: 1, removed: 0 })

    // Corrupt .git/index: diffFrom and hasChanges must throw rather than returning NO_CHANGES or false.
    const indexPath = join(repo, '.git', 'index')
    const savedIndex = readFileSync(indexPath)
    writeFileSync(indexPath, 'corrupt-index-bytes')
    try {
      await expect(diffFrom(repo, base)).rejects.toThrow(/index|corrupt|signature|fatal|error/i)
      await expect(hasChanges(repo)).rejects.toThrow(/index|corrupt|signature|fatal|error/i)
    } finally {
      writeFileSync(indexPath, savedIndex)
    }

    // Non-repo folder: hasChanges must throw rather than returning false.
    await expect(hasChanges(temp('regatta-sandbox-notrepo-'))).rejects.toThrow()

    // diffBetween with an invalid revision must throw rather than returning NO_CHANGES.
    await expect(diffBetween(repo, base, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).rejects.toThrow(/bad object|unknown revision|fatal/i)
  }, 30_000)

  it('gives a number rather than an error when the index has a merge conflict (: needs merge)', async () => {
    const repo = temp('regatta-sandbox-conflict-')
    sh(['init', '-b', 'main'], repo)
    writeFileSync(join(repo, 'b.txt'), 'base\n')
    sh(['add', 'b.txt'], repo)
    sh([...IDENTITY, 'commit', '-m', 'init'], repo)

    sh(['switch', '-c', 'side', 'main'], repo)
    writeFileSync(join(repo, 'b.txt'), 'side\n')
    sh([...IDENTITY, 'commit', '-am', 'side'], repo)
    sh(['switch', 'main'], repo)

    const wts = temp('regatta-sandbox-conflict-wts-')
    const lane = join(wts, 'lane')
    await addWorktree(repo, lane, 'regatta/lane', 'main')
    writeFileSync(join(lane, 'b.txt'), 'lane\n')
    sh([...IDENTITY, 'commit', '-am', 'lane'], lane)
    try {
      sh([...IDENTITY, 'merge', 'side'], lane)
    } catch {
      // Conflict expected, leaving b.txt unmerged in the index.
    }

    const stat = await diffFrom(lane, 'main')
    expect(stat.files).toBe(1)
    expect(stat.added).toBeGreaterThan(0)
  }, 30_000)

  it('never runs a submodule-local clean filter during diffFrom or diffBetween', async () => {
    const sub = temp('regatta-sandbox-sub-')
    sh(['init', '-b', 'main'], sub)
    writeFileSync(join(sub, 'a.txt'), 'a\n')
    sh(['add', '.'], sub)
    sh([...IDENTITY, 'commit', '-m', 'init'], sub)

    const repo = temp('regatta-sandbox-super-')
    sh(['init', '-b', 'main'], repo)
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    sh(['add', '.'], repo)
    sh([...IDENTITY, 'commit', '-m', 'init'], repo)
    const firstSha = await headSha(repo)

    sh(['clone', '-q', sub, 'sm'], repo)
    sh(['add', 'sm'], repo)
    sh([...IDENTITY, 'commit', '-m', 'add sm'], repo)
    const secondSha = await headSha(repo)

    const scripts = temp('regatta-sandbox-sub-scripts-')
    const marker = join(scripts, 'ran-sub-filter')
    const filterScript = join(scripts, 'strip.sh')
    writeFileSync(filterScript, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 })
    writeFileSync(join(repo, 'sm', '.gitattributes'), '*.txt filter=f\n')
    sh(['config', 'filter.f.clean', filterScript], join(repo, 'sm'))

    const subFile = join(repo, 'sm', 'a.txt')
    const future = new Date(Date.now() + 10_000)
    utimesSync(subFile, future, future)

    const stat = await diffFrom(repo, 'HEAD')
    expect(stat).toEqual({ files: 0, added: 0, removed: 0 })
    expect(existsSync(marker)).toBe(false)

    const between = await diffBetween(repo, firstSha, secondSha)
    expect(between.files).toBe(1)
    expect(existsSync(marker)).toBe(false)
  }, 30_000)
})

describe('4. commitAll in a filter repository', () => {
  it('refuses with the reason when tracked files use a non-empty clean or process filter, instead of committing unfiltered content', async () => {
    for (const kind of ['clean', 'process'] as const) {
      const repo = temp(`regatta-sandbox-filter-${kind}-`)
      sh(['init', '-b', 'main'], repo)
      sh(['config', 'user.name', 'Regatta Test'], repo)
      sh(['config', 'user.email', 'test@regatta.local'], repo)

      const box = temp(`regatta-sandbox-filter-box-${kind}-`)
      const marker = join(box, `${kind}-ran`)
      const script = join(box, `${kind}.sh`)
      writeFileSync(script, `#!/bin/sh\n: > '${marker}'\ncat\n`, { mode: 0o755 })

      // Commit .gitattributes and an LFS pointer in work.txt, then place smudged content on disk.
      writeFileSync(join(repo, '.gitattributes'), 'work.txt filter=lfs\n')
      const pointer = 'version https://git-lfs.github.com/spec/v1\nsize 14\n'
      writeFileSync(join(repo, 'work.txt'), pointer)
      sh(['add', '.gitattributes', 'work.txt'], repo)
      sh([...IDENTITY, 'commit', '-m', 'add lfs file'], repo)
      const headBefore = await headSha(repo)

      writeFileSync(join(repo, 'work.txt'), 'the smudged binary content\n')
      const future = new Date(Date.now() + 10_000)
      utimesSync(join(repo, 'work.txt'), future, future)
      writeFileSync(join(repo, 'extra.txt'), 'extra work\n')

      const gitconfig = join(box, 'gitconfig')
      writeFileSync(
        gitconfig,
        `[user]\n\tname = Regatta Test\n\temail = test@regatta.local\n[filter "lfs"]\n\t${kind} = ${script}\n\trequired = true\n`
      )

      await withIsolatedGitConfig(gitconfig, async () => {
        await expect(commitAll(repo, 'should refuse in filter repo'), kind).rejects.toThrow(/clean|process|filter/i)
        expect(existsSync(marker), kind).toBe(false)
        expect(await headSha(repo), kind).toBe(headBefore)
        expect(sh(['show', 'HEAD:work.txt'], repo), kind).toBe(pointer)
      })
    }
  }, 60_000)
})

describe('5. Regatta never enters a submodule or nested repository', () => {
  /** A repository with a submodule `sm` whose own config has a clean filter, and a stat-dirty tracked file inside it. */
  function withSubmodule(): { repo: string; marker: string } {
    const base = temp('regatta-sandbox-sm-')
    const sub = join(base, 'sub')
    mkdirSync(sub)
    sh(['init', '-b', 'main'], sub)
    writeFileSync(join(sub, '.gitattributes'), '*.txt filter=f\n')
    writeFileSync(join(sub, 'a.txt'), 'one\n')
    sh(['add', '-A'], sub)
    sh([...IDENTITY, 'commit', '-m', 'sub'], sub)
    const repo = join(base, 'repo')
    mkdirSync(repo)
    sh(['init', '-b', 'main'], repo)
    sh(['config', 'user.name', 'Regatta Test'], repo)
    sh(['config', 'user.email', 'test@regatta.local'], repo)
    writeFileSync(join(repo, 'top.txt'), 'x\n')
    sh(['clone', '-q', sub, join(repo, 'sm')], base)
    sh(['-c', 'advice.addEmbeddedRepo=false', 'add', '-A'], repo)
    sh([...IDENTITY, 'commit', '-m', 'with submodule'], repo)
    const scripts = temp('regatta-sandbox-sm-scripts-')
    const marker = join(scripts, 'sub-filter-ran')
    const filterScript = join(scripts, 'strip.sh')
    writeFileSync(filterScript, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 })
    sh(['config', 'filter.f.clean', filterScript], join(repo, 'sm'))
    const future = new Date(Date.now() + 10_000)
    utimesSync(join(repo, 'sm', 'a.txt'), future, future)
    return { repo, marker }
  }

  it('commitAll never runs the submodule filter and leaves the submodule pointer out of what it commits', async () => {
    const { repo, marker } = withSubmodule()
    const gitlinkBefore = sh(['ls-tree', 'HEAD', 'sm'], repo).trim()
    expect(await commitAll(repo, 'nothing here')).toBe(false)
    expect(existsSync(marker)).toBe(false)

    // A new commit inside the submodule and a real change at the top: only the top change is committed.
    writeFileSync(join(repo, 'sm', 'agent.txt'), 'agent work\n')
    sh(['-c', 'filter.f.clean=', 'add', 'agent.txt'], join(repo, 'sm'))
    sh([...IDENTITY, '-c', 'filter.f.clean=', 'commit', '-q', '-m', 'in the submodule'], join(repo, 'sm'))
    rmSync(marker, { force: true })
    utimesSync(join(repo, 'sm', 'a.txt'), new Date(Date.now() + 20_000), new Date(Date.now() + 20_000))
    writeFileSync(join(repo, 'top.txt'), 'changed\n')
    expect(await commitAll(repo, 'top change')).toBe(true)
    expect(existsSync(marker)).toBe(false)
    expect(sh(['show', 'HEAD:top.txt'], repo)).toBe('changed\n')
    expect(sh(['ls-tree', 'HEAD', 'sm'], repo).trim()).toBe(gitlinkBefore)
  }, 30_000)

  it('commitAll never runs the submodule filter while it checks for a top-level clean filter (fix round 1 TS-2)', async () => {
    const { repo, marker } = withSubmodule()
    // Any clean driver configured at the top makes commitAll look at what `git add -A` would stage, in a scratch index.
    sh(['config', 'filter.lfsish.clean', 'cat'], repo)
    writeFileSync(join(repo, 'top.txt'), 'changed\n')
    expect(await commitAll(repo, 'top change')).toBe(true)
    expect(existsSync(marker)).toBe(false)
    expect(sh(['show', 'HEAD:top.txt'], repo)).toBe('changed\n')
  }, 30_000)

  it('commitAll never runs the submodule filter when the user staged a file and changed it again (fix round 1 TS-2)', async () => {
    const { repo, marker } = withSubmodule()
    writeFileSync(join(repo, 'top.txt'), 'staged\n')
    sh(['add', 'top.txt'], repo)
    writeFileSync(join(repo, 'top.txt'), 'changed again\n')
    expect(await commitAll(repo, 'top change')).toBe(true)
    expect(existsSync(marker)).toBe(false)
    expect(sh(['show', 'HEAD~1:top.txt'], repo)).toBe('staged\n')
    expect(sh(['show', 'HEAD:top.txt'], repo)).toBe('changed again\n')
  }, 30_000)

  it('hasChanges and dirtyTracked never run the submodule filter', async () => {
    const { repo, marker } = withSubmodule()
    expect(await hasChanges(repo)).toBe(false)
    expect(existsSync(marker)).toBe(false)
    expect(await dirtyTracked(repo)).toBe(false)
    expect(existsSync(marker)).toBe(false)
    // Positive control: plain git status enters the submodule and runs its filter.
    sh(['status', '--porcelain'], repo)
    expect(existsSync(marker)).toBe(true)
  }, 30_000)
})
