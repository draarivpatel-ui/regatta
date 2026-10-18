// The regatta-video:// path rules: what a video folder serves, and what it refuses.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { contentTypeOf, resolveVideoFile, serveVideoRequest } from './protocol'

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function makeWorld(): { folder: string; resources: string; outside: string } {
  const folder = tempDir('rg-video-proto-')
  const resources = tempDir('rg-video-proto-res-')
  const outside = tempDir('rg-video-proto-out-')
  writeFileSync(join(folder, 'index.html'), '<html></html>')
  writeFileSync(join(folder, 'PLAN.md'), 'plan')
  mkdirSync(join(folder, 'assets'), { recursive: true })
  writeFileSync(join(folder, 'assets', 'logo.svg'), '<svg></svg>')
  mkdirSync(join(folder, 'thumbs'), { recursive: true })
  writeFileSync(join(folder, 'thumbs', 'hook.png'), 'png')
  mkdirSync(join(folder, '.history', '1'), { recursive: true })
  writeFileSync(join(folder, '.history', '1', 'index.html'), 'old')
  writeFileSync(join(resources, 'regatta-video.js'), 'runtime')
  writeFileSync(join(resources, 'regatta-video.css'), 'style')
  writeFileSync(join(outside, 'secret.json'), 'not yours')
  symlinkSync(join(outside, 'secret.json'), join(folder, 'assets', 'linked.json'))
  return { folder, resources, outside }
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function path(extra: string): string {
  return `/${extra}`
}

describe('resolveVideoFile', () => {
  it('serves a file from the video folder with its content type', () => {
    const { folder, resources } = makeWorld()
    const found = resolveVideoFile(folder, resources, path('index.html'))
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.file).toBe(join(folder, 'index.html'))
    expect(found.type).toContain('text/html')
  })

  it('serves the runtime files from Regatta resources, not the copy in the folder', () => {
    const { folder, resources } = makeWorld()
    writeFileSync(join(folder, 'regatta-video.js'), 'the agent edited this')
    const found = resolveVideoFile(folder, resources, path('regatta-video.js'))
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.file).toBe(join(resources, 'regatta-video.js'))
  })

  it('takes the root as index.html', () => {
    const { folder, resources } = makeWorld()
    const found = resolveVideoFile(folder, resources, '/')
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.file).toBe(join(folder, 'index.html'))
  })

  it('refuses a path that walks out of the folder', () => {
    const { folder, resources } = makeWorld()
    expect(resolveVideoFile(folder, resources, path('../secret.json')).ok).toBe(false)
    expect(resolveVideoFile(folder, resources, path('assets/../../secret.json')).ok).toBe(false)
  })

  it('refuses an absolute path', () => {
    const { folder, resources, outside } = makeWorld()
    const found = resolveVideoFile(folder, resources, `/${join(outside, 'secret.json')}`)
    expect(found.ok).toBe(false)
  })

  it('refuses hidden paths, including the history', () => {
    const { folder, resources } = makeWorld()
    expect(resolveVideoFile(folder, resources, path('.history/1/index.html')).ok).toBe(false)
    expect(resolveVideoFile(folder, resources, path('.video.json')).ok).toBe(false)
  })

  it('refuses a symlink that leaves the folder', () => {
    const { folder, resources } = makeWorld()
    expect(resolveVideoFile(folder, resources, path('assets/linked.json')).ok).toBe(false)
  })

  it('refuses a walk upwards however it is written', () => {
    const { folder, resources } = makeWorld()
    for (const sneaky of ['%2e%2e/secret.json', '..%2fsecret.json', 'assets/%2e%2e/%2e%2e/secret.json', '..\\secret.json', 'assets\\..\\..\\secret.json', './index.html']) {
      expect(resolveVideoFile(folder, resources, `/${sneaky}`).ok).toBe(false)
    }
  })

  it('refuses an absolute path however it is written', () => {
    const { folder, resources } = makeWorld()
    for (const sneaky of ['//etc/passwd', '/C:/Windows/win.ini', '//index.html', 'assets//logo.svg']) {
      expect(resolveVideoFile(folder, resources, sneaky).ok).toBe(false)
    }
  })

  it('refuses a path with a NUL, a bad escape or a hidden folder in the middle', () => {
    const { folder, resources } = makeWorld()
    expect(resolveVideoFile(folder, resources, '/index.html%00.png').ok).toBe(false)
    expect(resolveVideoFile(folder, resources, '/%E0%A4%A').ok).toBe(false)
    expect(resolveVideoFile(folder, resources, '/assets/.git/config').ok).toBe(false)
  })

  it('refuses a symlinked folder that leaves the video folder', () => {
    const { folder, resources, outside } = makeWorld()
    symlinkSync(outside, join(folder, 'assets', 'out'))
    expect(resolveVideoFile(folder, resources, '/assets/out/secret.json').ok).toBe(false)
  })

  it('serves a file reached by a symlink that stays inside the folder', () => {
    const { folder, resources } = makeWorld()
    symlinkSync(join(folder, 'assets', 'logo.svg'), join(folder, 'assets', 'same.svg'))
    expect(resolveVideoFile(folder, resources, '/assets/same.svg').ok).toBe(true)
  })

  it('does not serve a runtime file name from a sub folder', () => {
    const { folder, resources } = makeWorld()
    writeFileSync(join(folder, 'assets', 'regatta-video.js'), 'not the runtime')
    const found = resolveVideoFile(folder, resources, '/assets/regatta-video.js')
    expect(found.ok).toBe(true)
    if (found.ok) expect(found.file).toBe(join(folder, 'assets', 'regatta-video.js'))
  })

  it('refuses a file type it does not serve and a file that is not there', () => {
    const { folder, resources } = makeWorld()
    expect(resolveVideoFile(folder, resources, path('assets/notes.txt')).ok).toBe(false)
    expect(resolveVideoFile(folder, resources, path('assets/nothing.png')).ok).toBe(false)
  })

  it('refuses a folder', () => {
    const { folder, resources } = makeWorld()
    expect(resolveVideoFile(folder, resources, path('assets')).ok).toBe(false)
  })
})

describe('contentTypeOf', () => {
  it('knows the types a video uses', () => {
    expect(contentTypeOf('index.html')).toContain('text/html')
    expect(contentTypeOf('regatta-video.js')).toContain('javascript')
    expect(contentTypeOf('regatta-video.css')).toContain('text/css')
    expect(contentTypeOf('video.json')).toContain('application/json')
    expect(contentTypeOf('logo.png')).toBe('image/png')
    expect(contentTypeOf('shot.jpg')).toBe('image/jpeg')
    expect(contentTypeOf('logo.svg')).toBe('image/svg+xml')
    expect(contentTypeOf('hero.webp')).toBe('image/webp')
    expect(contentTypeOf('font.woff2')).toBe('font/woff2')
  })

  it('refuses anything else', () => {
    expect(contentTypeOf('notes.txt')).toBeNull()
    expect(contentTypeOf('Makefile')).toBeNull()
  })
})

describe('serveVideoRequest', () => {
  const folderOf = (folder: string) => (id: string) => (id === 'abc12345' ? folder : null)

  it('answers a file with its type, its length, and no caching', () => {
    const { folder, resources } = makeWorld()
    const answer = serveVideoRequest(folderOf(folder), resources, 'regatta-video://abc12345/index.html?mode=player')
    expect(answer.status).toBe(200)
    expect(answer.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(answer.headers['cache-control']).toBe('no-store')
    expect(answer.headers['content-length']).toBe(String('<html></html>'.length))
    expect(Buffer.from(answer.body as Uint8Array).toString('utf8')).toBe('<html></html>')
  })

  it('answers the root as the page', () => {
    const { folder, resources } = makeWorld()
    const answer = serveVideoRequest(folderOf(folder), resources, 'regatta-video://abc12345/')
    expect(answer.status).toBe(200)
    expect(answer.headers['content-type']).toContain('text/html')
  })

  it('answers the runtime from Regatta\'s resources', () => {
    const { folder, resources } = makeWorld()
    writeFileSync(join(folder, 'regatta-video.js'), 'the agent edited this')
    const answer = serveVideoRequest(folderOf(folder), resources, 'regatta-video://abc12345/regatta-video.js')
    expect(Buffer.from(answer.body as Uint8Array).toString('utf8')).toBe('runtime')
    expect(answer.headers['content-type']).toContain('javascript')
  })

  it('says 404, with no caching, for a video it does not know', () => {
    const { folder, resources } = makeWorld()
    const answer = serveVideoRequest(folderOf(folder), resources, 'regatta-video://nope/index.html')
    expect(answer.status).toBe(404)
    expect(answer.headers['cache-control']).toBe('no-store')
    expect(answer.body).toBe('No such video')
  })

  it('says 404 for every kind of path it refuses', () => {
    const { folder, resources, outside } = makeWorld()
    for (const url of [
      'regatta-video://abc12345/../secret.json',
      'regatta-video://abc12345/%2e%2e/secret.json',
      'regatta-video://abc12345/.history/1/index.html',
      'regatta-video://abc12345/assets/linked.json',
      `regatta-video://abc12345//${outside}/secret.json`,
      'regatta-video://abc12345/assets/nothing.png',
      'regatta-video://abc12345/assets'
    ]) {
      const answer = serveVideoRequest(folderOf(folder), resources, url)
      expect(answer.status, url).toBe(404)
      expect(answer.headers['cache-control']).toBe('no-store')
    }
  })

  it('says 404 for an address that is not an address', () => {
    const { folder, resources } = makeWorld()
    expect(serveVideoRequest(folderOf(folder), resources, 'not a url').status).toBe(404)
    expect(serveVideoRequest(folderOf(folder), resources, '').status).toBe(404)
  })
})
