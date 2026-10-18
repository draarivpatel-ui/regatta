# Design

Regatta looks like a calm instrument panel: deep navy chrome, terminals that read clearly, one teal
accent for actions, and one color per agent state. Dense but never cramped.

## Tokens (`src/renderer/src/styles/theme.css`)

Use the Tailwind classes these tokens create. Never hard-code a hex color in a component.

| Role | Class examples | Value |
|---|---|---|
| App background | `bg-bg` | #0b0e13 |
| Title bar, sidebars | `bg-chrome` | #0d1117 |
| Panels, menus | `bg-panel`, `bg-raised` | #10151c, #151b24 |
| Hover, pressed | `bg-hover`, `bg-press` | #1a212b, #202834 |
| Lines | `border-line`, `border-line-strong` | #1d242e, #2a3340 |
| Text | `text-fg`, `text-muted`, `text-faint` | #e7ebf0, #9aa4b2, #687282 |
| Accent | `bg-accent`, `text-accent`, `text-accent-bright`, `text-accent-ink` | #2dd4bf, #5eead4, #042f2b |
| Terminal | `bg-term` | #0b0f15 |

Agent states (dot, chip, borders): `st-starting` #a5b4fc, `st-working` #60a5fa, `st-waiting`
#fbbf24, `st-idle` #34d399, `st-quiet` #7d8796, `st-done` #94a3b8, `st-failed` #f87171. Use them as
`text-st-waiting`, `bg-st-idle`, `border-st-waiting/40`, and so on. In code that needs the raw value
use `STATE_COLOR` from `lib/format.ts`.

Type: system sans for UI (13px body, 12.5px controls, 11 to 11.5px secondary), monospace for
terminals, file paths, branch names and agent short names. Headings 15 to 17px semibold with
`tracking-[-0.01em]`. Never use small all-caps labels above headings; use sentence case.

Radius: 6px controls (`rounded-md`), 8 to 10px menu items and cards, 11px panes, 16px dialogs.

## Components to reuse

- `Button` (`variant`: ghost, subtle, outline, accent; `size`: sm, md; `active`), `IconButton`.
- `Popover` + `MenuItem` / `MenuLabel` / `MenuDivider` for menus.
- `Modal` for focused tasks (Broadcast, Quick actions, Start a crew, Settings).
- `SlideOver` for lists you scan and leave (Inbox).
- `AgentBadge` for agents (our own two-letter monograms, never other companies' logos).
- `StatusDot` and `StatusChip` for state.
- Icons: `lucide-react` only, size 13 to 15 in toolbars and menus, `strokeWidth` default.

## Motion

| What | How |
|---|---|
| Dialog open | scale 96% to 100% plus fade, 180 ms, `animate-dialog-in` |
| Slide-over open | from 28px right plus fade, 250 ms, `animate-slide-in` |
| Docked panel open | from 16px left plus fade, 220 ms, `animate-dock-in` |
| New pane, toast | rise 6px plus fade, 220 ms, `animate-fade-up` |
| Menus | scale and drop 4px, 160 ms, `animate-pop-in` |
| Working dot | gentle breathe, `animate-breathe`; needs-you dot adds a ping ring |
| Hover and color changes | `transition-colors duration-150` |

Everything respects `prefers-reduced-motion` (already handled in theme.css).

## Words

- Plain, short, friendly. Say what happened and what the user can do next.
- State names shown to users: starting, working, needs you, ready, quiet, exited, failed.
- Group names: "Waiting on you", "Working", "Quiet", "Ready for a prompt", "Finished".
- No em dashes or en dashes. No exclamation marks. No jargon when a plain word works.
- Our names: Fleet (the sidebar list of agents), Inbox (everything that needs you), Broadcast,
  Crew (several agents started together), Skipper (hand off a task with checks), Heats (agents
  racing on one task), Checkpoints (roll back an agent step), Relay (continue in another agent when
  one hits its limit), Night watch (overnight queue), Flows (multi-step pipelines).
