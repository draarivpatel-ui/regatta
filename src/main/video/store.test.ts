// The folder layout of a video: what is written, what is snapshotted, what comes back.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { VideoProject } from '../../shared/video'
import {
  HISTORY_DIR,
  RENDERS_DIR,
  indexPath,
  listSnapshots,
  listVideoFolders,
  makeJobDir,
  nextSnapshotName,
  normalizeProject,
  planPath,
  readProject,
  removeVideoFolder,
  renderFileName,
  restoreSnapshot,
  settleAfterRestart,
  sizeOf,
  slugTitle,
  snapshotFolder,
  starterHtml,
  trimSnapshots,
  uniqueRenderPath,
  videosDir,
  writeProject,
  copyRuntimeFiles
} from './store'

/** Gets item `i`, failing the test (not the type checker) when it is not there. */
function at<T>(list: readonly T[], i: number): T {
  const item = list[i]
  if (item === undefined) throw new Error(`There is no item ${i} in a list of ${list.length}`)
  return item
}

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function makeVideo(): { dataDir: string; folder: string } {
  const dataDir = tempDir('rg-video-store-')
  mkdirSync(videosDir(dataDir), { recursive: true })
  const folder = join(videosDir(dataDir), 'abc123')
  mkdirSync(folder, { recursive: true })
  return { dataDir, folder }
}

function project(id: string): VideoProject {
  const at = 1700000000000
  return {
    id,
    title: 'Test video',
    brief: 'A short clip.',
    aspect: '16:9',
    width: 1280,
    height: 720,
    fps: 30,
    agent: 'fake',
    projectRoot: '/projects/demo',
    status: 'planning',
    duration: 12,
    scenes: [],
    turns: [
      { id: 't1', kind: 'plan', status: 'running', startedAt: at, endedAt: null, note: 'Write the plan', tokens: 10, latest: '' }
    ],
    checks: [],
    renders: [
      { id: 'r1', path: 'renders/a.mp4', status: 'rendering', progress: 0.4, startedAt: at, endedAt: null, sizeBytes: null, loudness: null, note: '' }
    ],
    thumbnails: {},
    canUndo: false,
    createdAt: at,
    updatedAt: at
  }
}

describe('video.json', () => {
  it('round trips a project, without the derived field', () => {
    const { folder } = makeVideo()
    writeProject(folder, project('abc123'))
    const stored = JSON.parse(readFileSync(join(folder, 'video.json'), 'utf8')) as Record<string, unknown>
    expect('canUndo' in stored).toBe(false)
    const read = readProject(folder)
    expect(read?.title).toBe('Test video')
    expect(read?.canUndo).toBe(false)
    expect(read?.turns).toHaveLength(1)
  })

  it('is written whole: no temp file is left beside it', () => {
    const { folder } = makeVideo()
    writeProject(folder, project('abc123'))
    expect(readdirSync(folder)).toEqual(['video.json'])
  })

  it('is skipped when it is broken', () => {
    const { folder } = makeVideo()
    writeFileSync(join(folder, 'video.json'), '{ not json')
    expect(readProject(folder)).toBeNull()
    rmSync(join(folder, 'video.json'))
    expect(readProject(folder)).toBeNull()
  })

  it('is skipped when it is valid JSON of the wrong shape', () => {
    const { folder } = makeVideo()
    for (const body of ['[]', '"text"', '7', 'null', '{}', '{"id":"abc123"}']) {
      writeFileSync(join(folder, 'video.json'), body)
      expect(readProject(folder)).toBeNull()
    }
  })

  it('is skipped when the id is not the folder\'s own', () => {
    const { folder } = makeVideo()
    writeFileSync(join(folder, 'video.json'), JSON.stringify(project('other')))
    expect(readProject(folder)).toBeNull()
  })

  it('lists every video folder under the data dir', () => {
    const { dataDir } = makeVideo()
    mkdirSync(join(videosDir(dataDir), 'zzz'), { recursive: true })
    writeFileSync(join(videosDir(dataDir), 'not-a-folder.txt'), '')
    expect(listVideoFolders(dataDir).map((f) => f.split('/').pop())).toEqual(['abc123', 'zzz'])
  })

  it('does not list a symlink to a folder as a video', () => {
    const { dataDir } = makeVideo()
    const elsewhere = tempDir('rg-video-elsewhere-')
    symlinkSync(elsewhere, join(videosDir(dataDir), 'linked'))
    expect(listVideoFolders(dataDir).map((f) => f.split('/').pop())).toEqual(['abc123'])
  })
})

describe('normalizeProject', () => {
  const good = (): Record<string, unknown> => JSON.parse(JSON.stringify(project('abc123'))) as Record<string, unknown>

  it('takes a good project as it is', () => {
    const read = normalizeProject(good(), 'abc123')
    expect(read?.id).toBe('abc123')
    expect(read?.aspect).toBe('16:9')
    expect(read?.agent).toBe('fake')
    expect(read?.duration).toBe(12)
  })

  it('takes the size from the shape, whatever the file says', () => {
    const read = normalizeProject({ ...good(), aspect: '9:16', width: 5, height: 6 }, 'abc123')
    expect([read?.width, read?.height]).toEqual([720, 1280])
  })

  it('refuses an unknown shape, agent, empty title or unsafe id', () => {
    expect(normalizeProject({ ...good(), aspect: '4:3' }, 'abc123')).toBeNull()
    expect(normalizeProject({ ...good(), agent: 'shell' }, 'abc123')).toBeNull()
    expect(normalizeProject({ ...good(), title: '   ' }, 'abc123')).toBeNull()
    expect(normalizeProject({ ...good(), id: '../escape' }, '../escape')).toBeNull()
    expect(normalizeProject({ ...good(), id: 'a/b' }, 'a/b')).toBeNull()
  })

  it('treats an unknown status as failed and a silly frame rate as 30', () => {
    const read = normalizeProject({ ...good(), status: 'weird', fps: 9000 }, 'abc123')
    expect(read?.status).toBe('failed')
    expect(read?.fps).toBe(30)
  })

  it('drops turns, checks, scenes and renders that are not real, and keeps the real ones', () => {
    const stored = good()
    stored['turns'] = [...(stored['turns'] as unknown[]), 'junk', null, { id: 'x' }, { id: 'y', kind: 'dance', status: 'done' }]
    stored['checks'] = [{ name: 'loads', passed: true, detail: 'fine' }, { name: 'bogus', passed: true }, 3]
    stored['scenes'] = [{ id: 'a', title: 'A', start: 0, duration: 3 }, { title: 'no id' }, 'x']
    stored['renders'] = [
      { id: 'r1', path: 'renders/ok.mp4', status: 'done', progress: 3, startedAt: 1, endedAt: 2, sizeBytes: 9, loudness: -14, note: '' },
      { id: 'r2', path: '../outside.mp4', status: 'done' },
      { id: 'r3', path: 'renders/sub/dir.mp4', status: 'done' },
      { id: 'r4', path: 'renders/ok.mp4', status: 'dancing' }
    ]
    const read = normalizeProject(stored, 'abc123')
    expect(read?.turns.map((turn) => turn.id)).toEqual(['t1'])
    expect(read?.checks).toEqual([{ name: 'loads', passed: true, detail: 'fine' }])
    expect(read?.scenes.map((scene) => scene.id)).toEqual(['a'])
    expect(read?.renders.map((render) => render.id)).toEqual(['r1'])
    expect(read?.renders[0]?.progress).toBe(1)
  })

  it('keeps only thumbnails that point inside thumbs/', () => {
    const read = normalizeProject({ ...good(), thumbnails: { a: 'thumbs/a.png', b: '../b.png', c: 'thumbs/c.jpg', d: 7 } }, 'abc123')
    expect(read?.thumbnails).toEqual({ a: 'thumbs/a.png' })
  })

  it('never reads a derived field from the file', () => {
    expect(normalizeProject({ ...good(), canUndo: true }, 'abc123')?.canUndo).toBe(false)
  })
})

describe('settleAfterRestart', () => {
  it('stops a turn that was running and fails the video', () => {
    const settled = settleAfterRestart(project('abc123'), 5000)
    expect(at(settled.turns, 0).status).toBe('stopped')
    expect(at(settled.turns, 0).endedAt).toBe(5000)
    expect(settled.status).toBe('failed')
  })

  it('stops a render that was running and leaves a ready video ready', () => {
    const done = settleAfterRestart({ ...project('abc123'), status: 'ready' }, 5000)
    expect(at(done.renders, 0).status).toBe('stopped')
    expect(at(done.renders, 0).endedAt).toBe(5000)
    expect(done.status).toBe('ready')
  })

  it('fails a video that was building or checking', () => {
    for (const status of ['planning', 'building', 'checking'] as const) {
      expect(settleAfterRestart({ ...project('abc123'), status }, 1).status).toBe('failed')
    }
    expect(settleAfterRestart({ ...project('abc123'), status: 'planned' }, 1).status).toBe('planned')
  })

  it('leaves a finished video alone', () => {
    const finished = settleAfterRestart(
      {
        ...project('abc123'),
        status: 'ready',
        turns: [{ ...at(project('abc123').turns, 0), status: 'done', endedAt: 1 }],
        renders: [{ ...at(project('abc123').renders, 0), status: 'done', endedAt: 2 }]
      },
      5000
    )
    expect(at(finished.turns, 0).status).toBe('done')
    expect(at(finished.turns, 0).endedAt).toBe(1)
    expect(at(finished.renders, 0).status).toBe('done')
    expect(finished.status).toBe('ready')
  })
})

describe('starter page', () => {
  it('carries the size and the two includes, with an empty stage', () => {
    const html = starterHtml('My video', 720, 1280, 30)
    expect(html).toContain('<meta name="regatta-video" content="width=720,height=1280,fps=30" />')
    expect(html).toContain('<link rel="stylesheet" href="regatta-video.css" />')
    expect(html).toContain('<script src="regatta-video.js"></script>')
    expect(html).toContain('<main id="stage"></main>')
    expect(html).toContain('<title>My video</title>')
  })

  it('drops angle brackets from the title', () => {
    expect(starterHtml('<script>x</script>', 1280, 720, 30)).not.toContain('<script>x')
  })

  it('copies the runtime files in', () => {
    const resources = tempDir('rg-video-res-')
    writeFileSync(join(resources, 'regatta-video.js'), 'js')
    writeFileSync(join(resources, 'regatta-video.css'), 'css')
    const { folder } = makeVideo()
    copyRuntimeFiles(resources, folder)
    expect(readFileSync(join(folder, 'regatta-video.js'), 'utf8')).toBe('js')
    expect(readFileSync(join(folder, 'regatta-video.css'), 'utf8')).toBe('css')
  })

  it('says so when a runtime file is missing from Regatta\'s resources', () => {
    const resources = tempDir('rg-video-res-')
    writeFileSync(join(resources, 'regatta-video.js'), 'js')
    const { folder } = makeVideo()
    expect(() => copyRuntimeFiles(resources, folder)).toThrow('regatta-video.css is missing')
  })
})

describe('names', () => {
  it('makes a slug out of a title', () => {
    expect(slugTitle('Regatta: the launch clip')).toBe('regatta-the-launch-clip')
    expect(slugTitle('   ')).toBe('video')
  })

  it('names a render after the title and the minute', () => {
    const at = new Date(2026, 8, 14, 9, 5).getTime()
    expect(renderFileName('My Clip!', at)).toBe('renders/my-clip-20260914-0905.mp4')
  })

  it('moves a render on to -2, -3 when the name is taken, by an earlier render or by a file', () => {
    const { folder } = makeVideo()
    const at0 = new Date(2026, 8, 14, 9, 5).getTime()
    const first = 'renders/my-clip-20260914-0905.mp4'
    expect(uniqueRenderPath(folder, 'My Clip!', at0, [])).toBe(first)
    expect(uniqueRenderPath(folder, 'My Clip!', at0, [first])).toBe('renders/my-clip-20260914-0905-2.mp4')
    expect(uniqueRenderPath(folder, 'My Clip!', at0, [first, 'renders/my-clip-20260914-0905-2.mp4'])).toBe('renders/my-clip-20260914-0905-3.mp4')
    mkdirSync(join(folder, RENDERS_DIR), { recursive: true })
    writeFileSync(join(folder, first), 'x')
    expect(uniqueRenderPath(folder, 'My Clip!', at0, [])).toBe('renders/my-clip-20260914-0905-2.mp4')
  })

  it('reads a size from the aspect', () => {
    expect(sizeOf('9:16')).toEqual({ width: 720, height: 1280 })
    expect(sizeOf('1:1')).toEqual({ width: 1080, height: 1080 })
    expect(() => sizeOf('4:3' as never)).toThrow()
  })

  it('knows only its own shapes, not the names every object has', () => {
    for (const odd of ['constructor', 'toString', '__proto__', 'hasOwnProperty', '']) expect(() => sizeOf(odd as never)).toThrow('Pick one of these shapes')
    expect(() => sizeOf(undefined as never)).toThrow('Pick one of these shapes')
  })
})

describe('snapshots', () => {
  function withScenes(): { dataDir: string; folder: string } {
    const { dataDir, folder } = makeVideo()
    writeFileSync(join(folder, 'index.html'), 'first')
    writeFileSync(planPath(folder), 'plan')
    mkdirSync(join(folder, RENDERS_DIR), { recursive: true })
    writeFileSync(join(folder, RENDERS_DIR, 'keep.mp4'), 'video')
    return { dataDir, folder }
  }

  it('numbers the next snapshot past the highest', () => {
    const { folder } = withScenes()
    mkdirSync(join(folder, HISTORY_DIR, '1'), { recursive: true })
    mkdirSync(join(folder, HISTORY_DIR, '2'), { recursive: true })
    expect(nextSnapshotName(folder)).toBe('3')
  })

  it('copies the folder without renders or other snapshots', () => {
    const { folder } = withScenes()
    mkdirSync(join(folder, HISTORY_DIR, '1'), { recursive: true })
    writeFileSync(join(folder, HISTORY_DIR, '1', 'stale'), 'x')
    const name = snapshotFolder(folder, '2')
    expect(existsSync(join(name, 'index.html'))).toBe(true)
    expect(existsSync(join(name, 'PLAN.md'))).toBe(true)
    expect(existsSync(join(name, RENDERS_DIR))).toBe(false)
    expect(existsSync(join(name, HISTORY_DIR))).toBe(false)
  })

  it('leaves video.json out of a snapshot and out of a restore', () => {
    const { folder } = withScenes()
    writeFileSync(join(folder, 'video.json'), '{"turns":1}')
    const name = snapshotFolder(folder, '1')
    expect(existsSync(join(name, 'video.json'))).toBe(false)
    writeFileSync(join(folder, 'video.json'), '{"turns":2}')
    writeFileSync(indexPath(folder), 'second')
    restoreSnapshot(folder, '1')
    expect(readFileSync(indexPath(folder), 'utf8')).toBe('first')
    expect(readFileSync(join(folder, 'video.json'), 'utf8')).toBe('{"turns":2}')
  })

  it('brings back what the agent deleted and removes what it added', () => {
    const { folder } = withScenes()
    mkdirSync(join(folder, 'assets'), { recursive: true })
    writeFileSync(join(folder, 'assets', 'logo.svg'), 'logo')
    snapshotFolder(folder, '1')
    rmSync(join(folder, 'assets'), { recursive: true })
    writeFileSync(join(folder, 'extra.txt'), 'added by the agent')
    restoreSnapshot(folder, '1')
    expect(readFileSync(join(folder, 'assets', 'logo.svg'), 'utf8')).toBe('logo')
    expect(existsSync(join(folder, 'extra.txt'))).toBe(false)
  })

  it('keeps only the newest snapshots', () => {
    const { folder } = withScenes()
    for (const n of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']) {
      mkdirSync(join(folder, HISTORY_DIR, n), { recursive: true })
    }
    trimSnapshots(folder, 10)
    expect(listSnapshots(folder)).toEqual(['3', '4', '5', '6', '7', '8', '9', '10', '11', '12'])
  })

  it('restores the snapshot over the folder and keeps the renders', () => {
    const { folder } = withScenes()
    snapshotFolder(folder, '1')
    writeFileSync(indexPath(folder), 'second')
    restoreSnapshot(folder, '1')
    expect(readFileSync(indexPath(folder), 'utf8')).toBe('first')
    expect(existsSync(join(folder, RENDERS_DIR, 'keep.mp4'))).toBe(true)
    expect(listSnapshots(folder)).toEqual([])
  })

  it('refuses to restore a snapshot that is not there', () => {
    const { folder } = withScenes()
    expect(() => restoreSnapshot(folder, '9')).toThrow('Nothing to undo.')
  })
})

describe('removeVideoFolder', () => {
  it('deletes a folder inside the videos folder', () => {
    const { dataDir } = makeVideo()
    expect(removeVideoFolder(dataDir, 'abc123')).toBe(true)
    expect(existsSync(join(videosDir(dataDir), 'abc123'))).toBe(false)
  })

  it('refuses the videos folder itself and anything outside it', () => {
    const { dataDir } = makeVideo()
    const neighbour = join(dataDir, 'neighbour')
    mkdirSync(neighbour)
    writeFileSync(join(neighbour, 'keep.txt'), 'mine')
    expect(removeVideoFolder(dataDir, '..')).toBe(false)
    expect(removeVideoFolder(dataDir, '.')).toBe(false)
    expect(removeVideoFolder(dataDir, '')).toBe(false)
    expect(removeVideoFolder(dataDir, '../neighbour')).toBe(false)
    expect(removeVideoFolder(dataDir, 'abc123/../../neighbour')).toBe(false)
    expect(readFileSync(join(neighbour, 'keep.txt'), 'utf8')).toBe('mine')
    expect(existsSync(videosDir(dataDir))).toBe(true)
  })

  it('reports an unknown video', () => {
    const { dataDir } = makeVideo()
    expect(removeVideoFolder(dataDir, 'nope')).toBe(false)
  })
})

describe('makeJobDir', () => {
  it('makes a scratch folder in the system temp folder', () => {
    const dir = makeJobDir()
    expect(dir.startsWith(join(tmpdir(), 'regatta-video-'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
