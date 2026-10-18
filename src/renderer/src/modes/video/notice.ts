// The words for the player area when there is no picture to show yet: no video built, one being built,
// a build that failed, a page that is still loading or did not load. Plain data, so it can be tested.

import type { VideoProject } from '@shared/video'

/** loading: the page is coming up. ready: it answers seeks. error: it is not a video page, or it did not load. */
export type PlayerPhase = 'loading' | 'ready' | 'error'

export interface Notice {
  /** A plain word for tests and for the screen: which of the notices this is. */
  kind: 'new' | 'planning' | 'planned' | 'building' | 'checking' | 'failed' | 'loading' | 'unreadable'
  icon: 'film' | 'spin' | 'alert'
  title: string
  line: string
  /** The one thing the notice can offer. Building is offered in the Plan tab only, so it is never on screen twice. */
  action?: 'activity'
}

/** The words for a video that has no picture yet, from where it is in its life. */
export function noticeFor(video: VideoProject, hasVideo: boolean, phase: PlayerPhase): Notice | null {
  if (hasVideo) {
    if (phase === 'loading') return { kind: 'loading', icon: 'spin', title: 'Loading the video', line: '' }
    if (phase === 'error') {
      return {
        kind: 'unreadable',
        icon: 'alert',
        title: 'This video did not load',
        line: 'Open Activity to see what the checks found.',
        action: 'activity'
      }
    }
    return null
  }
  switch (video.status) {
    case 'planning':
      return {
        kind: 'planning',
        icon: 'spin',
        title: 'Writing the plan',
        line: 'The agent is reading your project. The plan shows up on the right when it is done.'
      }
    case 'planned':
      return {
        kind: 'planned',
        icon: 'film',
        title: 'Plan ready',
        line: 'Read it on the right, change anything you like, then press Build the video under it.'
      }
    case 'building':
      return {
        kind: 'building',
        icon: 'spin',
        title: 'Building the video',
        line: 'The agent is writing it. Regatta checks every frame when it is done.'
      }
    case 'checking':
      return {
        kind: 'checking',
        icon: 'spin',
        title: 'Checking the video',
        line: 'Sample frames are drawn twice to make sure each one comes out the same.'
      }
    case 'failed': {
      const first = video.checks[0]
      const why = first && first.name === 'loads' && !first.passed ? first.detail : 'The agent stopped before there was a video to show.'
      return { kind: 'failed', icon: 'alert', title: 'There is no video yet', line: why, action: 'activity' }
    }
    case 'new':
    case 'ready':
      return {
        kind: 'new',
        icon: 'film',
        title: 'No video yet',
        line: 'Start with a plan. The agent builds the video from it.'
      }
  }
}
