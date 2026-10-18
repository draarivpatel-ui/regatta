# Design: Spot fix and the Board

## Spot fix (from the browser preview)

See something wrong in the running app? Point at it, say the fix, and look at before and after.

1. In the Preview tab, "Spot fix" turns on a picker inside the page (a script injected into the
   `webview`): hovering outlines the element under the pointer; a click picks it. Regatta records
   a short CSS selector, the element's text (120 characters), its tag, the page URL, and a
   screenshot of the visible page with the element outlined ("before").
2. A box at the spot asks "What should change?" and which agent (installed agents that run
   headless; the last one used is preselected). Send.
3. Regatta takes a checkpoint of the project folder (the same engine as Undo for agents), then runs
   the agent headless in the project folder with: the page URL, the selector, the text, the note,
   the "before" image path, and "Find where this element comes from in the code and make the
   change. Keep everything else as it is." Commands are not allowed.
4. When the agent ends, Regatta runs the project's checks (the detected test and typecheck ones;
   optional) and reloads the preview; after it settles, it takes the "after" screenshot.
5. A result card beside the preview shows before and after side by side, the changed files with
   their diff stats, the check results, and three choices: **Keep** (done), **Undo** (roll back
   the checkpoint, exactly as Undo for agents does, keeping anything the user edited since), and
   **Refine** (another note; repeats from step 3 on top of the current state, with its own
   checkpoint).
Spot fix works in the project folder because the preview shows the app running from it; the
checkpoint is what makes it reversible.

## The Board (Labs, off by default)

One board for everything in flight, whose cards move by themselves as work progresses. Only a
person moves a card to Done.

- Columns: **Waiting** (tasks to do, night tasks queued), **Running** (running tasks, racing or
  handing off heats, running night tasks and flow runs, working panes), **To review** (tasks and
  heats with a winner, ready night tasks, flow runs waiting for approval, panes that need you),
  **Done** (merged or marked done, last 7 days).
- A card shows what it is (task, heat, night task, flow run, pane), its title, agent badges, time
  in the column, and its latest line. Clicking opens the place it lives (the task, the Skipper
  view, the night report, the flow run, the pane).
- Card actions by kind: Run (task to do), Stop (running), Retry (failed task or heat), Send back
  (to review back to waiting, with a note for the next run), Merge (a winner), Mark done, Mark done
  without merging, Archive (hide from the board).
- The board is derived from the engines' own state; it stores only archived ids and send-back
  notes.
