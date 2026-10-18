# Architecture

Regatta is an Electron app with three parts that only talk through a typed contract.

```
main process (Node)            preload (bridge)              renderer (React)
  sessions.ts  pty + status  <-- window.regatta.invoke -->  stores, modes, panels, overlays
  hooks.ts     agent events  --> window.regatta.on    -->   terminal/registry.ts (xterm)
  files.ts, search.ts, git.ts, memory.ts, notifier.ts, settings.ts
```

## The contract: `src/shared/ipc.ts`

- `InvokeChannels`: request and response calls (renderer asks, main answers).
- `SendChannels`: fire and forget messages from the renderer (terminal input, resize).
- `EventChannels`: events main pushes to the renderer.
- The channel name lists at the bottom are the runtime allowlist used by the preload bridge.

Every channel the first build wave needs is already declared and already has a handler in
`src/main/index.ts` that calls a module function. Your job is usually to fill in that module
function and the UI that uses it. If you truly need a new channel, add it to `ipc.ts` (types and
the channel list) and register it in `src/main/index.ts`, and say so in your report.

Renderer code calls main like this:

```ts
import { bridge } from '../lib/bridge'
const entries = await bridge.invoke('files:list', '')
const off = bridge.on('session:status', ({ id, status }) => { ... })
```

## Sessions and status

- `SessionManager` (`src/main/sessions.ts`) starts each agent in a pty (`@lydell/node-pty`), keeps a
  hidden copy of its screen (`@xterm/headless`) and a `StatusTracker`.
- `StatusTracker` (`src/main/status/tracker.ts`) is pure logic with unit tests. States:
  `starting`, `working`, `waiting` (needs you), `idle` (ready), `quiet` (no signal), `done`, `failed`.
  Silence never counts as finished.
- Claude Code reports events through hooks injected with `--settings`; Codex through `notify`.
  Both post to the local `HookServer` (`src/main/hooks.ts`). Other agents are read from their screen.

## Renderer layout

```
src/renderer/src/
  App.tsx                 title bar, the five modes, overlays
  app/TitleBar.tsx        logo, mode tabs, right-side controls
  app/shortcuts.ts        app-wide keyboard shortcuts
  modes/code/             Code mode: Toolbar, CodeMode (grid), Pane, FleetSidebar
  panels/                 panels docked beside the grid (Files, Find, Device, Thread, Flows) and Preview
  overlays/               dialogs and slide-overs (Inbox, Broadcast, QuickActions, Settings, LaunchSet)
  components/ui.tsx       Button, IconButton, Kbd, Popover, MenuItem, MenuLabel, MenuDivider, cx
  components/overlay.tsx  Modal, SlideOver, NotBuiltYet
  components/marks.tsx    Logo, AgentBadge, StatusDot, StatusChip
  store/sessions.ts       sessions, agents, workspace, focus (Zustand)
  store/ui.ts             mode, layout, panels, overlay, density (Zustand)
  terminal/registry.ts    one xterm per session, outside React
```

Zustand rule: a selector must return the same value when nothing changed. Never return a new array
or object from a selector (`s.order.map(...)` inside `useSessions(...)` causes an infinite render
loop). Select the raw pieces and compute in the component, or use `useShallow`.

## Tests

- Unit tests: Vitest, files named `*.test.ts` next to the code. Run `npm test`.
- End-to-end: `scripts/e2e/<name>.test.mjs`, each exporting a default async function that uses
  `launch()` from `scripts/e2e/lib.mjs` and returns `t.close()`. The app window renders hidden.
  Run one file: `npm run build && env -u ELECTRON_RUN_AS_NODE node scripts/e2e/run.mjs <name>`.
  Run all: `npm run e2e`.
- The test agent (`scripts/fake-agent.mjs`, menu label "Test Agent", only present in tests) never
  calls any AI service. Type a task and it works for about 3 seconds; `ask` makes it ask a yes or no
  question; `fail` exits with code 3; `quit` exits with code 0.
- Use `data-testid` attributes for anything a test needs to find.

## Commands

```
npm install          also downloads the Electron binary
npm run dev          run the app with hot reload
npm run typecheck    TypeScript, no emit
npm test             unit tests
npm run e2e          build, then every end-to-end test
```
