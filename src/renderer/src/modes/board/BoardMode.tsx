// Board mode (Labs): one board for everything in flight. Its cards are derived from the engines' own
// state by buildBoard, and move on their own as work progresses; only a person marks a card done.
// The actions call the engines' existing channels. The board keeps nothing of its own but archived ids
// and send-back notes.
// See docs/design/spotfix.md "The Board".

import { useEffect, useMemo, useRef, useState } from 'react'
import { SquareKanban } from 'lucide-react'
import type { Prefs, AgentKind } from '@shared/types'
import type { BoardAction, BoardCard } from '@shared/board'
import { BOARD_COLUMNS, buildBoard } from '@shared/board'
import { bridge } from '../../lib/bridge'
import { Button } from '../../components/ui'
import { Modal } from '../../components/overlay'
import { useSessions } from '../../store/sessions'
import { useHeats } from '../../store/heats'
import { useNight } from '../../store/night'
import { useFlows } from '../../store/flows'
import { useChat } from '../../store/chat'
import { useTasks } from '../agents/automate/tasks/store'
import { useUi } from '../../store/ui'
import { useNow } from '../../lib/useNow'
import { useBoard } from './store'
import { dispatchCardAction, openCard, submitSendBack } from './format'
import { BoardCardView } from './BoardCard'

/** Four columns of 240px with 16px gaps only fit once the board area is this wide; below it the groups read as a vertical list. */
const COLUMNS_MIN_WIDTH_PX = 4 * 240 + 3 * 16
/** The narrowest a card in the list grid gets. */
const LIST_CARD_MIN_WIDTH_PX = 280

/** Reads the Labs flags, so the board shows its gate if the switch is off in another window. */
function useLabs(): { prefs: Prefs | null; enableBoard: () => void } {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  useEffect(() => {
    let alive = true
    void bridge
      .invoke('prefs:get')
      .then((next) => alive && setPrefs(next))
      .catch(() => undefined)
    const off = bridge.on('prefs:changed', (next) => alive && setPrefs(next))
    return () => {
      alive = false
      off()
    }
  }, [])
  const enableBoard = (): void => {
    if (!prefs) return
    void bridge.invoke('prefs:set', { labs: { ...prefs.labs, board: true } }).catch(() => undefined)
  }
  return { prefs, enableBoard }
}

function LabsGate({ onEnable }: { onEnable: () => void }): React.JSX.Element {
  return (
    <div data-testid="board-mode" className="flex h-full flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <SquareKanban size={26} className="text-faint" />
      <p className="text-[14px] font-semibold text-fg">The Board is in Labs</p>
      <p className="max-w-[360px] text-[12.5px] leading-relaxed text-muted">
        One board for everything in flight. Its cards move by themselves as your runs progress, and only
        you move a card to Done.
      </p>
      <div className="mt-1">
        <Button variant="accent" size="md" data-testid="board-enable" onClick={onEnable}>
          Turn on Board
        </Button>
      </div>
    </div>
  )
}

export function BoardMode(): React.JSX.Element {
  const { prefs, enableBoard } = useLabs()

  const tasks = useTasks((s) => s.tasks)
  const loadTasks = useTasks((s) => s.load)
  const updateTask = useTasks((s) => s.update)
  const heats = useHeats((s) => s.heats)
  const loadHeats = useHeats((s) => s.load)
  const night = useNight((s) => s.state)
  const loadNight = useNight((s) => s.load)
  const runs = useFlows((s) => s.runs)
  const loadFlows = useFlows((s) => s.load)
  const sessions = useSessions((s) => s.sessions)
  const teammates = useChat((s) => s.teammates)
  const loadChat = useChat((s) => s.load)

  const data = useBoard((s) => s.data)
  const loadBoard = useBoard((s) => s.load)
  const archive = useBoard((s) => s.archive)
  const sendBack = useBoard((s) => s.sendBack)

  const now = useNow()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [noteFor, setNoteFor] = useState<BoardCard | null>(null)
  const [noteText, setNoteText] = useState('')

  useEffect(() => {
    void loadTasks()
    void loadHeats()
    void loadNight()
    void loadFlows()
    void loadChat()
    void loadBoard()
  }, [loadTasks, loadHeats, loadNight, loadFlows, loadChat, loadBoard])

  const sessionList = useMemo(() => Object.values(sessions), [sessions])
  const teammateAgents = useMemo(() => {
    const map: Record<string, AgentKind> = {}
    for (const mate of teammates) map[mate.id] = mate.agent
    return map
  }, [teammates])

  const board = useMemo(
    () => buildBoard({ tasks, heats, night, runs, sessions: sessionList, archived: data.archived, notes: data.notes, teammateAgents }, now),
    [tasks, heats, night, runs, sessionList, data.archived, data.notes, teammateAgents, now]
  )

  // Columns only when the board area is wide enough for all four; the sidebars take width away from the
  // area, so measure the area's own content width with a ResizeObserver on the area itself. The App keeps
  // every mode mounted and hides the inactive ones, and an observer attached while the element has no box
  // never delivers its first one, so the effect re-runs whenever the active mode changes: that re-measure
  // is what catches the real width the moment the board is opened.
  const mode = useUi((s) => s.mode)
  const areaRef = useRef<HTMLDivElement>(null)
  const [wideEnough, setWideEnough] = useState(false)
  useEffect(() => {
    const measureNow = (): void => {
      const el = areaRef.current
      if (!el) return
      const cs = getComputedStyle(el)
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
      setWideEnough(el.clientWidth - pad >= COLUMNS_MIN_WIDTH_PX)
    }
    measureNow()
    const observer = new ResizeObserver(() => measureNow())
    const el = areaRef.current
    if (el) observer.observe(el)
    window.addEventListener('resize', measureNow)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measureNow)
    }
  }, [mode])

  if (prefs && !prefs.labs.board) return <LabsGate onEnable={enableBoard} />

  const runAction = async (card: BoardCard, action: BoardAction): Promise<void> => {
    setBusyId(card.id)
    try {
      if (action === 'archive') {
        await archive(card.id)
        return
      }
      if (action === 'sendback') {
        const taskNote = card.kind === 'task' ? tasks.find((t) => t.id === card.id)?.note : undefined
        setNoteFor(card)
        setNoteText(taskNote || data.notes[card.id] || '')
        return
      }
      await dispatchCardAction(card, action, { tasks, heats, runs, invoke: bridge.invoke, archive })
    } finally {
      setBusyId((current) => (current === card.id ? null : current))
    }
  }

  const renderCard = (card: BoardCard): React.JSX.Element => (
    <BoardCardView key={card.id} card={card} now={now} busy={busyId === card.id} onOpen={() => openCard(card)} onAction={(action) => void runAction(card, action)} />
  )

  const anyCards = BOARD_COLUMNS.some((c) => board[c.id].length > 0)

  return (
    <div data-testid="board-mode" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden [contain:inline-size] bg-bg">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-chrome/60 px-6 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-fg tracking-[-0.01em]">
            <SquareKanban size={15} className="text-accent" />
            Board
          </h2>
          <p className="mt-0.5 text-[11.5px] text-faint">Everything in flight, in one place. Cards move by themselves; only you mark one done.</p>
        </div>
      </header>

      <div ref={areaRef} data-testid="board-area" data-layout={wideEnough ? 'columns' : 'list'} className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-4">
        {!prefs && <p className="text-[12px] text-faint">Loading the board...</p>}
        {prefs && !anyCards && (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <SquareKanban size={22} className="text-faint" />
            <p className="mt-2 max-w-[400px] text-[12.5px] leading-relaxed text-muted">
              Nothing is in flight. Tasks, heats, night runs, flows and panes all show up here as they move.
            </p>
          </div>
        )}

        {prefs &&
          anyCards &&
          (wideEnough ? (
            <div className="flex min-h-0 items-stretch gap-4">
              {BOARD_COLUMNS.map((column) => {
                const cards = board[column.id]
                return (
                  <section
                    key={column.id}
                    data-testid={`board-col-${column.id}`}
                    className="flex min-w-0 flex-1 basis-0 flex-col rounded-xl border border-line bg-chrome/40"
                  >
                    <h3 data-testid={`board-group-${column.id}`} className="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px] font-semibold text-muted">
                      <span className="truncate">{column.label}</span>
                      <span className="shrink-0 text-faint">{cards.length}</span>
                    </h3>
                    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                      {cards.length === 0 && <p className="px-1 py-2 text-[11.5px] text-faint">Nothing here.</p>}
                      {cards.map(renderCard)}
                    </div>
                  </section>
                )
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {BOARD_COLUMNS.map((column) => {
                const cards = board[column.id]
                return (
                  <section key={column.id} data-testid={`board-col-${column.id}`} className="min-w-0">
                    <h3 data-testid={`board-group-${column.id}`} className="flex items-center gap-2 py-1 text-[12px] font-semibold text-muted">
                      <span className="truncate">{column.label}</span>
                      <span className="shrink-0 text-faint">{cards.length}</span>
                    </h3>
                    {cards.length === 0 ? (
                      <p className="px-1 py-1 text-[11.5px] text-faint">Nothing here.</p>
                    ) : (
                      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${LIST_CARD_MIN_WIDTH_PX}px, 1fr))` }}>
                        {cards.map(renderCard)}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          ))}
      </div>

      {noteFor && (
        <SendBackModal
          card={noteFor}
          initial={noteText}
          onClose={() => setNoteFor(null)}
          onSubmit={async (note) => {
            const ok = await submitSendBack(noteFor, note, {
              updateTask,
              sendBackBoard: sendBack,
              hasBoardNote: Boolean(data.notes[noteFor.id])
            })
            if (ok) setNoteFor(null)
          }}
        />
      )}
    </div>
  )
}

function SendBackModal({ card, initial, onClose, onSubmit }: { card: BoardCard; initial: string; onClose: () => void; onSubmit: (note: string) => Promise<void> }): React.JSX.Element {
  const [text, setText] = useState(initial)
  const [saving, setSaving] = useState(false)
  return (
    <Modal
      title={`Send ${card.title} back`}
      subtitle="It moves to Waiting. The note goes with it, so the next run reads it."
      onClose={onClose}
      testId="board-sendback"
      width={460}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="accent"
            size="sm"
            data-testid="board-sendback-save"
            disabled={saving}
            onClick={() => {
              setSaving(true)
              void onSubmit(text).finally(() => setSaving(false))
            }}
          >
            Send back
          </Button>
        </>
      }
    >
      <label className="block text-[12px] text-muted">
        What the next run should know
        <textarea
          data-testid="board-sendback-note"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          className="mt-1 w-full resize-none rounded-md border border-line bg-term px-2 py-1.5 text-[12.5px] text-fg outline-none focus:border-line-strong"
        />
      </label>
    </Modal>
  )
}
