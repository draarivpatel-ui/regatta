# Design: conversations (Chat mode, Agents mode, and agent steps in Flows)

One engine runs every conversation with an agent CLI in headless mode, one turn at a time, and keeps
the CLI's own session id so the next turn continues the same conversation.

## Turn

`send(conversationId, text, access)` runs one turn:

| Agent | Command |
|---|---|
| Claude Code | `claude -p <text> --output-format stream-json --verbose --include-partial-messages --permission-mode <plan or acceptEdits> [--resume <session id>] [--append-system-prompt <instructions>] [--model <model>]` |
| Codex | first turn `codex exec --json -s <read-only or workspace-write> <text>`, later turns `codex exec resume <session id> --json <text>` with the same sandbox flag |
| Test agent | `node scripts/fake-agent.mjs --chat <text>` (prints a reply; with access `read` and a text containing "edit", it asks for write access instead) |

- Access `read` means the agent may look but not change files: Claude `plan`, Codex `read-only`.
  Access `write` means it may edit inside the conversation's folder: Claude `acceptEdits`, Codex
  `workspace-write`.
- The session id comes from the first event that carries one (Claude: the `system` init event's
  `session_id`; Codex: the session or thread id event). It is stored on the conversation.
- Streaming: assistant text arrives in pieces and is appended to the current assistant message;
  tool uses become short tool messages ("Read src/app.ts", "Edit src/app.ts"); the final result gives
  token usage.
- Only one turn runs per conversation at a time. `stop` kills it.

## Approvals (Agents mode, and Chat mode in "Ask first")

A read-access turn that wanted to change files ends with a **write request**: Claude calls its
plan-exit tool (`ExitPlanMode`), Codex reports a denied write, and the test agent prints a line
starting with `NEEDS WRITE:`. The conversation then holds `pending: { kind: 'workspace-write', request,
summary }`. Approving reruns the same request with `write` access (the agent decides the individual
edits during that run). Denying clears it and adds a short system note.

## Data (`src/shared/chat.ts`)

`Conversation { id, title, agent, model, cwd, access, cliSessionId, teammateId, messages, status,
pending, tokens, createdAt, updatedAt, error }`, `ChatMessage { id, role: user | assistant | tool |
system, text, at }`, `Teammate { id, name, role, instructions, agent, memory, createdAt }`.
Conversations and teammates are saved as JSON in the app's data folder (`chats/` and
`teammates.json`) and load at start.

## Modes

- **Chat:** a list of conversations on the left (active first), the transcript on the right, and a
  composer with pickers for account (later), agent, model, reasoning, and mode (Ask first or Edit
  directly), an attach button, a token estimate, and send. A new conversation's title is its first
  message, trimmed.
- **Agents:** crew members (teammates) on the left with a pixel avatar, name and role; a "New crew
  member" dialog (name, role, instructions, agent). Each teammate has conversations (tabs at the
  top). Every turn runs with `read` access first and write requests appear as approval cards
  ("Workspace write", the request, Approve workspace edits, Deny). Teammate instructions and memory
  notes are sent as appended system instructions.
- **Flows:** see `docs/design/flows.md` (later).
