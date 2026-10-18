import { describe, expect, it } from 'vitest'
import type { VideoProject, VideoStatus } from '@shared/video'
import { noticeFor } from './notice'

function video(status: VideoStatus, extra: Partial<VideoProject> = {}): VideoProject {
  return {
    id: 'abc',
    title: 'Launch clip',
    brief: 'Panes, then the name.',
    aspect: '16:9',
    width: 1280,
    height: 720,
    fps: 30,
    agent: 'fake',
    projectRoot: '/tmp/project',
    status,
    duration: null,
    scenes: [],
    turns: [],
    checks: [],
    renders: [],
    thumbnails: {},
    canUndo: false,
    createdAt: 1,
    updatedAt: 1,
    ...extra
  }
}

describe('noticeFor a video that is not built yet', () => {
  it('says what is happening in each status, in plain words', () => {
    expect(noticeFor(video('planning'), false, 'loading')?.kind).toBe('planning')
    expect(noticeFor(video('building'), false, 'loading')?.kind).toBe('building')
    expect(noticeFor(video('checking'), false, 'loading')?.kind).toBe('checking')
    expect(noticeFor(video('new'), false, 'loading')?.kind).toBe('new')
  })

  it('points at the Build button in the Plan tab once the plan is ready, without a second button of its own', () => {
    const notice = noticeFor(video('planned'), false, 'loading')
    expect(notice?.kind).toBe('planned')
    expect(notice?.action).toBeUndefined()
    expect(notice?.line).toContain('Build the video')
  })

  it('shows the reason a page could not load, and points at Activity', () => {
    const failed = video('failed', { checks: [{ name: 'loads', passed: false, detail: 'The page took too long to load.' }] })
    const notice = noticeFor(failed, false, 'loading')
    expect(notice?.kind).toBe('failed')
    expect(notice?.line).toBe('The page took too long to load.')
    expect(notice?.action).toBe('activity')
  })

  it('still says something when the agent stopped without a reason on record', () => {
    const notice = noticeFor(video('failed'), false, 'loading')
    expect(notice?.kind).toBe('failed')
    expect(notice?.line.length).toBeGreaterThan(10)
  })

  it('never uses a dash or an exclamation mark in what it says', () => {
    const statuses: VideoStatus[] = ['new', 'planning', 'planned', 'building', 'checking', 'ready', 'failed']
    for (const status of statuses) {
      const notice = noticeFor(video(status), false, 'loading')
      const words = `${notice?.title} ${notice?.line}`
      expect(words).not.toMatch(/[\u2014\u2013!]/)
    }
  })
})

describe('noticeFor a video that has a page', () => {
  const built = video('ready', { duration: 12, scenes: [{ id: 'a', title: 'A', start: 0, duration: 12 }] })

  it('says nothing once the page is ready', () => {
    expect(noticeFor(built, true, 'ready')).toBeNull()
  })

  it('says it is loading while the page comes up', () => {
    expect(noticeFor(built, true, 'loading')?.kind).toBe('loading')
  })

  it('says the page did not load, and points at Activity, when it is not a video page', () => {
    const notice = noticeFor(built, true, 'error')
    expect(notice?.kind).toBe('unreadable')
    expect(notice?.action).toBe('activity')
  })
})
