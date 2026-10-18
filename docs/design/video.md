# Design: Video (Labs)

An agent writes a short video (a launch clip, a feature tour) as code, in the look of the user's own
project; the user previews it frame by frame, points at a frame to ask for a change, and renders an
MP4 on this computer. Off until turned on in Settings > Labs. Proven by a spike
(Electron 44.7.2: about 42 frames a second at 1280x720, identical pixels across runs).

## A video project

`<dataDir>/videos/<id>/`:
- `video.json`: `{ id, title, brief, aspect, width, height, fps, agent, projectRoot, createdAt,
  updatedAt }`. Aspects: 16:9 (1280x720), 9:16 (720x1280), 1:1 (1080x1080). 30 fps.
- `PLAN.md`: the plan the agent writes first and the user may edit: the message, the scenes with
  their seconds, on-screen words, captions, and the mood of the music.
- `index.html`: the composition, written by the agent. It loads `regatta-video.js` and
  `regatta-video.css` (copied in by Regatta, refreshed on every turn; never edited by the agent).
- `assets/`: images and fonts the agent copied from the project (logo, screenshots). No network.
- `renders/`: finished MP4 files. `.history/<n>/`: the folder as it was before agent turn n.

## The composition format (what `AGENT_GUIDE.md` teaches the agent)

- One `<main id="stage">` holding `<section data-scene="hook" data-title="Hook"
  data-duration="3.5">` elements in order. The video's length is the sum of the scene durations.
- Motion comes only from CSS animations and transitions inside a scene, or from JavaScript that
  draws purely from the time it is given: `RegattaVideo.onSeek((t, scene, local) => { ... })`.
  No timers, no `requestAnimationFrame` loops, no `Date`, no unseeded randomness
  (`RegattaVideo.random(seed)` gives a seeded generator), no network, no `<video>` or `<audio>`.
- Captions: `<script type="application/json" id="regatta-captions">[{ "start": 0.2, "end": 2.4,
  "text": "..." }]</script>`. The runtime draws them; `regatta-video.css` styles them; the
  composition may restyle `.rv-caption`.
- Music: `RegattaVideo.score = (ctx, seconds) => { ... }` schedules oscillators, noise and gain
  envelopes on an `OfflineAudioContext` (48 kHz stereo). Deterministic by construction.

## The runtime (`resources/video/regatta-video.js`)

`window.RegattaVideo`: `width`, `height`, `fps`, `duration`, `scenes` (`id`, `title`, `start`,
`duration`), `seek(t)` (show the scene at t, set every CSS animation inside it to the scene-local
time with the Web Animations API and `fill: both`, call `onSeek` listeners, draw the caption; resolves
after two animation frames), `seekSync(t)`, `renderAudio()` (base64 16-bit PCM WAV, or null without
a score), `inspect(x, y)` (the element at stage coordinates: a short CSS selector, its text, the
scene), `random(seed)`, `onSeek(fn)`, `errors` (script errors seen while loading). In player mode the
stage is scaled to fit its window; in render mode it is exactly `width` by `height`.

## Rendering (main process)

A separate Electron process (the app binary started with `--regatta-render=<job file>`) so it can
turn off GPU acceleration without touching the app: `app.disableHardwareAcceleration()`,
`disable-gpu-compositing`, `disable-lcd-text`, `font-render-hinting=none`, a temporary userData
folder and an in-memory partition. A hidden window sized `width / scale` by `height / scale` with
zoom `1 / scale` gives a page of exactly `width` by `height` at device pixel ratio 1 on Retina
screens. Frames are rendered in order (random order is not pixel exact), each with
`seek(t)` then `capturePage()`, and piped as BGRA into ffmpeg (`-f rawvideo -pix_fmt bgra -s WxH
-r 30 -i -`, H.264 `yuv420p`, CRF 18). Audio from `renderAudio()` is normalized to -14 LUFS (true peak
-1.5 dB) with ffmpeg's two-pass `loudnorm`, then muxed as AAC. Progress goes to stdout as JSON lines.
ffmpeg comes from the PATH; without it the Render tab says how to install it.

## Checks (after every agent turn)

1. Loads with no script errors and with at least one scene; the duration is between 3 and 120 s.
2. Pixel stability: sample frames (every scene's middle plus every 15th frame, ascending) are
   rendered twice in order; every pair must match ("28 of 28 frames rendered the same twice").
3. Captions sit inside the video's length and do not overlap.
A failed check goes back to the agent once with the evidence; a second failure is shown to the user.

## Agent turns

Headless runs through the heats runner with the video folder as the working folder and read
access to the project. Turns: write the plan; build the video from the plan; change at a point
(time, scene, element and the user's note); fix a failed check. Each turn snapshots the folder first
so "Undo last change" can restore it.

## Screen (Video mode)

Left: the list of videos and "New video". Center: the player (a `webview` on the
`regatta-video://<id>/` protocol, scaled stage, controls: back to start, previous frame, play or
pause, next frame, mute, time, and "Point" to click a spot on the frame), and under it the timeline
(scene strip with thumbnails, titles and seconds; captions; music waveform; playhead). Right: tabs
Plan (edit PLAN.md, "Save" and "Save and tell the agent"), Activity (turns, checks, tokens), and
Render (Render MP4, progress, finished files with Show in Finder).
