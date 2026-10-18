// Flows mode end to end, in the fake world with the Test Agent.
//
// Builds a flow in the window with real clicks (an agent step, a check step, an approval step), runs it in
// its own worktree, approves it, tries a merge the engine refuses and then merges, and checks the merge in git;
// runs it again and discards that run through the confirmation, checking the kept copy, the Copy command button
// and that the command in the note restores the work; fails a check on purpose and reads the engine's sentence on
// the card; stops runs (while a step works, and at the approval); removes the step a run waits at and finishes
// the run from its card; tries a recipe, the 16 step limit, the list and delete; and looks at a narrow window.
// Screenshots go to /tmp/regatta-e2e/flows/.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from './lib.mjs'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 20000 })
}

/** A throwaway repository on main with one commit. The test process already has the test git identity (lib.mjs). */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'regatta-flows-e2e-'))
  git(['init', '-b', 'main'], dir)
  writeFileSync(join(dir, 'README.md'), '# flows e2e\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'first commit'], dir)
  return dir
}

const DISCARD_QUESTION = 'Discard this run? Its worktree is removed only when nothing in it is unsaved; a copy of its commits stays in the repository.'
const CHECK_SENTENCE = 'The check changed tracked files, so its result does not match the committed change.'
const BRIEF = 'Create DONE.txt'
const FLOW_NAME = 'DONE.txt flow'
/** The commit message the engine gives a run's work. */
const subjectOf = (runId) => `Flow run ${runId}: ${FLOW_NAME}`

export default async function flows() {
  let repoDir
  let t
  let win
  let results = []

  const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim()
  const savedFlows = () => JSON.parse(readFileSync(join(t.profile, 'flows.json'), 'utf8'))
  const worktreeFolders = () => readdirSync(join(t.world, 'worktrees')).filter((name) => name.startsWith('flow-'))
  const card = (i) => win.locator('[data-testid=flow-step]').nth(i)
  const latestRun = () => win.locator('[data-testid=flow-run-card][data-latest=true]')
  const inspectorStep = () => win.locator('[data-testid=flow-inspector]').getAttribute('data-step-id')
  const stepStates = () => win.locator('[data-testid=flow-step]').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))
  const keepRefs = () => git(['for-each-ref', '--format=%(refname)', 'refs/regatta/discarded'], repoDir).trim().split('\n').filter(Boolean)
  const refExists = (ref) => {
    try {
      git(['rev-parse', '--verify', '--quiet', ref], repoDir)
      return true
    } catch {
      return false
    }
  }
  /** The subjects of every commit a ref or branch can reach. */
  const subjectsReachable = (ref) => git(['log', '--format=%s', ref], repoDir).split('\n')

  /** Polls for something outside the window (a file, git) until it is true. */
  async function until(label, fn, timeoutMs = 15000) {
    const start = Date.now()
    for (;;) {
      let value = false
      try {
        value = await fn()
      } catch {
        // Not there yet.
      }
      if (value) return value
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
      await win.waitForTimeout(100)
    }
  }
  /**
   * Waits for what an edit leaves behind: the engine's file has what the predicate looks for, and the header says
   * Saved. The header is the part that cannot be fooled by an earlier save: every edit turns it to "Saving…" at
   * once, so "Saved" can only mean the newest edit was confirmed. The predicate says what to look at in the file.
   */
  async function saved(label, predicate) {
    await until(`the engine to have ${label}`, () => predicate(savedFlows()))
    await win.waitForSelector('[data-testid=flow-save-state][data-state=saved]', { timeout: 10000 })
  }
  const waitForRun = (status, timeout = 45000) =>
    win.waitForSelector(`[data-testid=flow-run-card][data-latest=true][data-status=${status}]`, { timeout })
  /** Lets the dialog and card animations finish so a screenshot shows the resting state. */
  async function shot(name) {
    await win
      .waitForFunction(() => document.getAnimations().every((a) => a.effect?.getComputedTiming().iterations === Infinity || a.playState !== 'running'), null, { timeout: 3000 })
      .catch(() => undefined)
    await t.shot(name)
  }
  /** Adds a step at the end by clicking the plus, then waits for its card. */
  async function addStep() {
    const before = await win.locator('[data-testid=flow-step]').count()
    await win.locator('[data-testid=flow-add-step]').click()
    await win.waitForFunction((n) => document.querySelectorAll('[data-testid=flow-step]').length === n, before + 1, { timeout: 5000 })
  }
  async function pickKind(kind) {
    await win.locator(`[data-testid=flow-step-kind-${kind}]`).click()
    await win.waitForSelector(`[data-testid=flow-step-kind-${kind}][aria-pressed=true]`, { timeout: 5000 })
  }
  /** Starts a run and waits until it waits at its approval step. */
  async function runToApproval() {
    await win.click('[data-testid=flow-run]')
    await win.waitForSelector('[data-testid=flow-approve]', { timeout: 60000 })
  }
  /** What the window shows at one instant: for checks that must all describe the same moment of a running agent. */
  const snapshot = () =>
    win.evaluate(() => ({
      steps: [...document.querySelectorAll('[data-testid=flow-step]')].map((e) => e.getAttribute('data-status')),
      runDisabled: document.querySelector('[data-testid=flow-run]')?.disabled === true,
      runStops: document.querySelectorAll('[data-testid=flow-run-stop]').length,
      liveRows: document.querySelectorAll('[data-testid=flow-row-live][data-state=running]').length,
      approves: document.querySelectorAll('[data-testid=flow-approve]').length
    }))

  try {
    repoDir = makeRepo()
    // The Test Agent works for about 5 seconds, so a run is still working when the test looks at it.
    t = await launch('flows', { cwd: repoDir, env: { REGATTA_FAKE_DELAY_MS: '2500' } })
    win = t.win

    // Screenshots of an earlier run would be mistaken for this one.
    for (const file of readdirSync(t.shots)) if (file.endsWith('.png')) rmSync(join(t.shots, file))

    await t.step('Flows mode opens with nothing in it', async () => {
      await win.keyboard.press('Meta+4')
      await win.waitForSelector('[data-testid=flows-mode]', { timeout: 8000 })
      t.check('the Flows tab is the active mode', (await win.locator('[data-testid=mode-flows]').getAttribute('class')).includes('text-accent-bright'))
      // Nothing is drawn until the first list from the engine has come back, so wait for it before looking.
      await win.waitForSelector('[data-testid=flows-empty]', { state: 'visible', timeout: 8000 })
      t.check('the empty state invites a first flow', await win.locator('[data-testid=flows-empty]').isVisible())
      t.check('the list says there are no flows yet', await win.getByText('No flows yet').isVisible())
      await shot('01-empty')
    })

    await t.step('a new flow is made, selected and saved at once', async () => {
      await win.click('[data-testid=flow-new]')
      await win.waitForSelector('[data-testid=flow-row]', { timeout: 5000 })
      t.check('one row in the list', (await win.locator('[data-testid=flow-row]').count()) === 1)
      t.check('the row is selected and says "0 steps"', (await text(win.locator('[data-testid=flow-row]'))).startsWith('Untitled flow 0 steps'))
      await saved('the new flow', (all) => all.length === 1 && all[0].name === 'Untitled flow')
      t.check('the engine has the new flow in flows.json', savedFlows().length === 1)

      const list = await win.locator('[data-testid=flows-list]').boundingBox()
      const header = await win.locator('[data-testid=flow-header]').boundingBox()
      t.check('the list is 260 px wide', Math.abs(list.width - 260) < 1, `${list.width}`)
      t.check('the studio sits beside the list, not below it', header.x >= list.x + list.width - 1 && Math.abs(header.y - list.y) < 2, `list ${list.x},${list.y} header ${header.x},${header.y}`)
      t.check('an empty pipeline shows Start and the plus', (await win.locator('[data-testid=flow-start]').count()) === 1 && (await win.locator('[data-testid=flow-add-step]').count()) === 1)
      t.check('Run flow waits for a first step', await win.locator('[data-testid=flow-run]').isDisabled())
      await shot('02-new-flow')
    })

    await t.step('rename, brief, and a step added the moment the brief is typed (the vanishing card)', async () => {
      await win.click('[data-testid=flow-name]')
      await win.fill('[data-testid=flow-name-input]', FLOW_NAME)
      await win.keyboard.press('Enter')
      t.check('the name changes in the header and the list', (await text(win.locator('[data-testid=flow-name]'))) === FLOW_NAME && (await text(win.locator('[data-testid=flow-row]'))).startsWith(FLOW_NAME))

      await win.fill('[data-testid=flow-brief]', BRIEF)
      await win.locator('[data-testid=flow-add-step]').click() // right away: the brief is still waiting to be saved
      await win.waitForSelector('[data-testid=flow-step]', { timeout: 5000 })
      // An agent step with no prompt cannot be saved, so the window must say so, and the card must stay.
      await win.waitForSelector('[data-testid=flow-save-state][data-state=error]', { timeout: 8000 })
      const state = await text(win.locator('[data-testid=flow-save-state]'))
      t.check('a step that cannot be saved yet says why, not Saved', state === 'Not saved: Every agent step needs an agent and a prompt.', state)
      t.check('the card is still there after the save settled', (await win.locator('[data-testid=flow-step]').count()) === 1)
      t.check('the new card asks for a prompt', (await text(card(0))).includes('Add a prompt'))
    })

    await t.step('the agent step uses the Test Agent and the brief', async () => {
      t.check('the new step is selected: the inspector shows it', (await inspectorStep()) === (await card(0).getAttribute('data-step-id')))
      const options = await win.locator('[data-testid=flow-step-agent] option').allInnerTexts()
      t.check('the agent menu lists the Test Agent and Claude Code', options.includes('Test Agent') && options.includes('Claude Code'), options.join(', '))
      t.check('the agent menu has no Terminal', !options.includes('Terminal'))
      await win.selectOption('[data-testid=flow-step-agent]', 'fake')
      await win.fill('[data-testid=flow-step-title]', 'Create the file')
      await win.fill('[data-testid=flow-step-prompt]', '{{brief}}')
      await saved('the agent step', (all) => all[0]?.steps[0]?.prompt === '{{brief}}' && all[0].steps[0].agent === 'fake' && all[0].steps[0].title === 'Create the file')
      t.check('the card reads "Coding agent · Test Agent"', (await text(card(0))).includes('Coding agent · Test Agent'))
      const [flow] = savedFlows()
      t.check('the engine has the brief, the agent and the prompt', flow.brief === BRIEF && flow.steps[0].agent === 'fake' && flow.steps[0].prompt === '{{brief}}' && flow.name === FLOW_NAME, JSON.stringify(flow.steps[0]))
      await shot('03-agent-step')
    })

    await t.step('a check step, and clicking a card selects it', async () => {
      await addStep()
      t.check('the second card is selected at once', (await inspectorStep()) === (await card(1).getAttribute('data-step-id')))
      await pickKind('check')
      t.check('the title followed the kind while nobody had renamed it', (await win.locator('[data-testid=flow-step-title]').inputValue()) === 'Check step')
      await win.fill('[data-testid=flow-step-title]', 'DONE.txt exists')
      await win.fill('[data-testid=flow-step-command]', 'test -f DONE.txt')
      await saved('the check step', (all) => all[0]?.steps[1]?.command === 'test -f DONE.txt' && all[0].steps[1].title === 'DONE.txt exists')
      t.check('the card reads "Check · test -f DONE.txt"', (await text(card(1))).includes('Check · test -f DONE.txt'))

      await card(0).click()
      t.check('clicking the first card shows it in the inspector', (await inspectorStep()) === (await card(0).getAttribute('data-step-id')) && (await win.locator('[data-testid=flow-step-title]').inputValue()) === 'Create the file')
      t.check('and marks it selected', (await card(0).getAttribute('data-selected')) === 'true' && (await card(1).getAttribute('data-selected')) === 'false')
      await card(1).click()
      t.check('clicking the second card brings the check back', (await win.locator('[data-testid=flow-step-command]').inputValue()) === 'test -f DONE.txt')
    })

    await t.step('an approval step', async () => {
      await addStep()
      await pickKind('approval')
      await win.fill('[data-testid=flow-step-title]', 'Looks good?')
      t.check('an approval step explains that the run pauses', (await text(win.locator('[data-testid=flow-step-approval-note]'))).includes('pauses here'))
      await saved('the approval step', (all) => all[0]?.steps[2]?.kind === 'approval' && all[0].steps[2].title === 'Looks good?')
      t.check('the card reads "Approval"', (await text(card(2))).includes('Approval'))
      t.check('the engine has the three kinds in order', savedFlows()[0].steps.map((s) => s.kind).join() === 'agent,check,approval')
    })

    await t.step('a step can be inserted between cards, moved and removed', async () => {
      t.check('there is one plus at the end and one between each pair of cards', (await win.locator('[data-testid=flow-add-step]').count()) === 1 && (await win.locator('[data-testid=flow-insert-step]').count()) === 2)
      const ids = await win.locator('[data-testid=flow-step]').evaluateAll((els) => els.map((e) => e.getAttribute('data-step-id')))
      await win.locator('[data-testid=flow-insert-step]').first().click()
      await win.waitForFunction((n) => document.querySelectorAll('[data-testid=flow-step]').length === n, 4, { timeout: 5000 })
      const after = await win.locator('[data-testid=flow-step]').evaluateAll((els) => els.map((e) => e.getAttribute('data-step-id')))
      t.check('the plus after the first card inserts the new step second', after[0] === ids[0] && after[2] === ids[1] && after[3] === ids[2] && !ids.includes(after[1]))
      t.check('the inserted step is selected', (await inspectorStep()) === after[1])

      await win.click('[data-testid=flow-step-move-right]')
      const moved = await win.locator('[data-testid=flow-step]').evaluateAll((els) => els.map((e) => e.getAttribute('data-step-id')))
      t.check('moving it right swaps it with the check', moved[1] === ids[1] && moved[2] === after[1])
      await win.click('[data-testid=flow-step-remove]')
      await win.waitForFunction((n) => document.querySelectorAll('[data-testid=flow-step]').length === n, 3, { timeout: 5000 })
      const back = await win.locator('[data-testid=flow-step]').evaluateAll((els) => els.map((e) => e.getAttribute('data-step-id')))
      t.check('removing it leaves the original three in their order', back.join() === ids.join())
      t.check('the inspector moves on to its neighbour', ids.includes(await inspectorStep()))
      await saved('the original three steps again', (all) => all[0]?.steps.map((step) => step.id).join() === ids.join())
    })

    await t.step('the flow runs in its own worktree', async () => {
      const toggle = win.locator('[data-testid=flow-isolate]')
      t.check('the worktree switch starts off', (await toggle.getAttribute('aria-checked')) === 'false')
      await toggle.click()
      t.check('clicking it turns it on', (await toggle.getAttribute('aria-checked')) === 'true')
      await saved('isolate on', (all) => all[0]?.isolate === true)
      t.check('the engine has isolate on', savedFlows()[0].isolate === true)
      t.check('the trigger offers only Manual run', (await win.locator('[data-testid=flow-trigger] option').allInnerTexts()).join() === 'Manual run')
      await card(0).click()
      const pipeline = await win.locator('[data-testid=flow-pipeline]').boundingBox()
      const inspector = await win.locator('[data-testid=flow-inspector]').boundingBox()
      t.check('the inspector is a 320 px column to the right of the pipeline', Math.abs(inspector.width - 320) <= 2 && inspector.x >= pipeline.x + pipeline.width - 2, `inspector ${inspector.x},${inspector.width} pipeline ${pipeline.x},${pipeline.width}`)
      await shot('04-built')
    })

    await t.step('run: the steps work in turn and stop at the approval', async () => {
      await win.click('[data-testid=flow-run]')
      await win.waitForSelector('[data-testid=flow-step][data-status=running]', { timeout: 15000 })
      // One look at the window, so every check below describes the same moment of the working agent.
      const working = await snapshot()
      t.check('the first card is working while the others wait', working.steps.join() === 'running,pending,pending', working.steps.join())
      t.check('Run flow is off while the flow is running', working.runDisabled)
      t.check('the run card offers Stop while a step works', working.runStops === 1)
      t.check('the list marks the running flow', working.liveRows === 1)
      await shot('05-working')

      await win.waitForSelector('[data-testid=flow-approve]', { timeout: 45000 })
      t.check('exactly one Approve button', (await win.locator('[data-testid=flow-approve]').count()) === 1)
      const states = await stepStates()
      t.check('the agent and the check are done and the approval waits', states.join() === 'done,done,waiting', states.join())
      t.check('the run is waiting for the user', (await latestRun().getAttribute('data-status')) === 'waiting')
      t.check('the card has a Stop next to Approve', (await win.locator('[data-testid=flow-stop]').count()) === 1)
      t.check('the run happens in the worktree, so the user\'s folder has no DONE.txt yet', !existsSync(join(repoDir, 'DONE.txt')))
      t.check('the run has a worktree folder of its own', worktreeFolders().length === 1, worktreeFolders().join())

      await win.click('[data-testid=flow-delete]')
      await win.waitForSelector('[data-testid=flow-delete-dialog]', { timeout: 5000 })
      t.check('a flow that is running cannot be deleted', (await text(win.locator('[data-testid=flow-delete-dialog]'))).includes('This flow is running.') && (await win.locator('[data-testid=flow-confirm-yes]').count()) === 0)
      await win.click('[data-testid=flow-confirm-cancel]')
      await win.waitForSelector('[data-testid=flow-delete-dialog]', { state: 'detached', timeout: 5000 })
      await shot('06-waiting-approval')
    })

    await t.step('approve: the run is done and offers merge and discard', async () => {
      await win.click('[data-testid=flow-approve]')
      await waitForRun('done')
      const states = await stepStates()
      t.check('all three cards are done', states.join() === 'done,done,done', states.join())
      t.check('the run card says all 3 steps passed', (await text(latestRun().locator('[data-testid=flow-run-headline]'))) === 'All 3 steps passed')
      t.check('Run flow is available again', await win.locator('[data-testid=flow-run]').isEnabled())
      await win.waitForSelector('[data-testid=flow-merge]', { timeout: 5000 })
      t.check('Merge the run\'s changes and Discard are both offered', (await text(win.locator('[data-testid=flow-merge]'))) === "Merge the run's changes" && (await win.locator('[data-testid=flow-discard]').count()) === 1)
      t.check('nothing is merged yet: no DONE.txt in the user\'s folder', !existsSync(join(repoDir, 'DONE.txt')))
      t.check('the card says it is not merged yet', (await text(latestRun())).includes('Not merged yet'))

      // What the agent delivered can be read: the first step's saved output opens under it.
      const firstStep = latestRun().locator('[data-testid=flow-run-step]').first()
      t.check('a finished step keeps its output closed', (await firstStep.locator('[data-testid=flow-run-step-detail]').count()) === 0)
      await firstStep.locator('[data-testid=flow-run-step-toggle]').click()
      t.check('Show output opens what the Test Agent printed', (await text(firstStep.locator('[data-testid=flow-run-step-detail]'))).includes('Reading the project'))

      await win.click('[data-testid=flow-delete]')
      await win.waitForSelector('[data-testid=flow-delete-dialog]', { timeout: 5000 })
      t.check('a flow with an unmerged worktree cannot be deleted', (await text(win.locator('[data-testid=flow-delete-dialog]'))).includes('still has its own worktree and branch'))
      await win.click('[data-testid=flow-confirm-cancel]')
      await win.waitForSelector('[data-testid=flow-delete-dialog]', { state: 'detached', timeout: 5000 })
      await shot('07-done')
    })

    await t.step('merge: a refusal keeps the buttons and says why, then the change lands in the project', async () => {
      // An edit the user has not committed: the engine will not merge into a folder with unsaved work.
      const edited = '# flows e2e\nan edit nobody committed\n'
      writeFileSync(join(repoDir, 'README.md'), edited)
      await win.click('[data-testid=flow-merge]')
      await win.waitForSelector('[data-testid=flow-run-error]', { timeout: 30000 })
      const refusal = await text(win.locator('[data-testid=flow-run-error]'))
      t.check('the refusal is the engine\'s sentence, word for word', refusal === 'Commit or stash your changes first. Merging needs a clean folder.', refusal)
      t.check('Merge and Discard are still there to try again', (await win.locator('[data-testid=flow-merge]').count()) === 1 && (await win.locator('[data-testid=flow-discard]').count()) === 1 && (await win.locator('[data-testid=flow-merge]').isEnabled()))
      t.check('nothing was merged and the user\'s edit is untouched', !existsSync(join(repoDir, 'DONE.txt')) && readFileSync(join(repoDir, 'README.md'), 'utf8') === edited)
      t.check('the run still has its worktree folder', worktreeFolders().length === 1)
      await shot('08-merge-refused')

      writeFileSync(join(repoDir, 'README.md'), '# flows e2e\n')
      await win.click('[data-testid=flow-merge]')
      await win.waitForSelector('[data-testid=flow-merge-summary]', { timeout: 30000 })
      t.check('the refusal is gone once the merge goes through', (await win.locator('[data-testid=flow-run-error]').count()) === 0)
      const summary = await text(win.locator('[data-testid=flow-merge-summary]'))
      t.check('the card shows the engine\'s merge summary', /^Fast-forwarded main by 1 commit \(\+\d+ -0 in 2 files\)\. Removed 1 worktree and 0 branches\. Kept: Moved its worktree to Regatta's trash \(/.test(summary), summary)
      t.check('DONE.txt is in the project folder and carries the brief', existsSync(join(repoDir, 'DONE.txt')) && readFileSync(join(repoDir, 'DONE.txt'), 'utf8') === `done: ${BRIEF}`)
      t.check('the last commit on main is the flow\'s', new RegExp(`^Flow run [a-z0-9]{4}: ${FLOW_NAME}$`).test(git(['log', '-1', '--format=%s'], repoDir).trim()))
      t.check('the project is clean after the merge', git(['status', '--porcelain'], repoDir).trim() === '')
      t.check('the run branch stays while its worktree is in trash', git(['branch', '--list', 'regatta/*'], repoDir).trim() !== '')
      t.check('the run worktree folder moved to .regatta-trash', worktreeFolders().length === 0 && readdirSync(join(t.world, 'worktrees', '.regatta-trash')).length === 1, worktreeFolders().join())
      t.check('Merge and Discard are gone', (await win.locator('[data-testid=flow-merge]').count()) === 0 && (await win.locator('[data-testid=flow-discard]').count()) === 0)
      t.check('the card says Merged', (await latestRun().getAttribute('data-merged')) === 'true' && (await text(latestRun())).includes('Merged'))
      // Whatever the notes of the merged run say was kept, it is really there.
      const named = (await latestRun().locator('[data-testid=flow-note]').allInnerTexts()).flatMap((note) => note.match(/refs\/regatta\/discarded\/[^\s()]+/g) ?? [])
      t.check('every kept copy the notes of the merged run name exists in the repository', named.every(refExists), named.join())
      await shot('09-merged')
    })

    await t.step('discard: it asks first, Cancel keeps the run, Discard keeps a copy and says where', async () => {
      await win.click('[data-testid=flow-run]')
      await win.waitForSelector('[data-testid=flow-approve]', { timeout: 60000 })
      await win.click('[data-testid=flow-approve]')
      await waitForRun('done')
      const runId = await latestRun().getAttribute('data-run-id')
      t.check('the second run is the latest, the merged one moved down to the history', (await win.locator('[data-testid=flow-run-card]').count()) === 2 && (await win.locator('[data-testid=flow-run-card][data-merged=true][data-latest=false]').count()) === 1)

      await win.click('[data-testid=flow-discard]')
      await win.waitForSelector('[data-testid=flow-discard-dialog]', { timeout: 5000 })
      t.check('the question is the one the engine facts give', (await text(win.locator('[data-testid=flow-discard-dialog]'))).startsWith(DISCARD_QUESTION), await text(win.locator('[data-testid=flow-discard-dialog]')))
      await shot('10-discard-confirm')
      await win.click('[data-testid=flow-confirm-cancel]')
      await win.waitForSelector('[data-testid=flow-discard-dialog]', { state: 'detached', timeout: 5000 })
      t.check('Cancel keeps the run: Merge and Discard are still there', (await win.locator('[data-testid=flow-merge]').count()) === 1 && (await win.locator('[data-testid=flow-discard]').count()) === 1)
      t.check('and its worktree folder', worktreeFolders().length === 1)

      await win.click('[data-testid=flow-discard]')
      await win.waitForSelector('[data-testid=flow-discard-dialog]', { timeout: 5000 })
      await win.click('[data-testid=flow-confirm-yes]')
      await win.waitForSelector('[data-testid=flow-run-card][data-latest=true][data-discarded=true]', { timeout: 30000 })
      t.check('the card says Discarded and offers neither button', (await text(latestRun())).includes('Discarded') && (await win.locator('[data-testid=flow-merge]').count()) === 0 && (await win.locator('[data-testid=flow-discard]').count()) === 0)
      t.check('the worktree folder moved to .regatta-trash', worktreeFolders().length === 0 && readdirSync(join(t.world, 'worktrees', '.regatta-trash')).length === 2)
      t.check('nothing was merged: still two commits and one line from the agent', git(['rev-list', '--count', 'main'], repoDir).trim() === '2' && readFileSync(join(repoDir, 'src', 'app.js'), 'utf8').split('\n').filter(Boolean).length === 1)

      const note = latestRun().locator('[data-testid=flow-note]').filter({ hasText: 'refs/regatta/discarded/' })
      await note.first().waitFor({ timeout: 5000 })
      const noteText = await text(note.first())
      const ref = /refs\/regatta\/discarded\/[^\s()]+/.exec(noteText)?.[0]
      t.check('the notes say where the copy is, with the engine\'s words', noteText.startsWith("Kept a copy of the run's work at refs/regatta/discarded/") && /\(restore [^)]*git branch flow-[a-z0-9]+-restored /.test(noteText), noteText)
      t.check('that copy is in the repository and its history holds the run\'s work', ref !== undefined && refExists(ref) && subjectsReachable(ref).includes(subjectOf(runId)), ref)
      t.check('and it is listed with the other kept copies', ref !== undefined && keepRefs().includes(ref), keepRefs().join())

      // The command the engine wrote into the note: the button copies it as it is.
      const fromNote = /git branch [^\s()]+ [^\s()]+/.exec(noteText)?.[0]
      const copy = note.first().locator('[data-testid=flow-note-copy]')
      const command = await copy.getAttribute('data-command')
      t.check('the note has a Copy command button for the git command only', command !== null && command === fromNote, `${command} | ${fromNote}`)
      await shot('11-discarded-notes')

      // A stand-in for the clipboard: the test sees what the window asks to be copied and never touches the real clipboard.
      await win.evaluate(() => {
        window.__copied = []
        navigator.clipboard.writeText = (copied) => {
          window.__copied.push(copied)
          return Promise.resolve()
        }
      })
      await copy.click()
      await win.waitForFunction(() => window.__copied.length === 1, null, { timeout: 5000 })
      const copied = await win.evaluate(() => window.__copied)
      t.check('the window copies the command and nothing else', copied.length === 1 && copied[0] === command, copied.join(' | '))
      await win.waitForFunction(() => document.querySelector('[data-testid=flow-note-copy]')?.textContent?.includes('Copied'), null, { timeout: 5000 })
      await win.waitForFunction(() => document.querySelector('[data-testid=flow-note-copy]')?.textContent?.includes('Copy command'), null, { timeout: 8000 })
      t.check('the Copied note goes away again', true)

      // Do what the note says, as the user would. The command has a real branch name, so it runs as it was copied.
      t.check('the command has a real branch name, not a placeholder', copied[0] === `git branch flow-${runId}-restored ${ref}^1`, copied[0])
      const [, ...args] = copied[0].split(' ')
      git([...args], repoDir)
      const restored = subjectsReachable(`flow-${runId}-restored`)
      t.check('the command in the note makes a branch that holds the run\'s work', restored.includes(subjectOf(runId)), restored.slice(0, 3).join(' | '))
    })

    await t.step('a check that changes a tracked file fails the run, with the engine\'s sentence', async () => {
      await card(1).click()
      await win.fill('[data-testid=flow-step-command]', 'echo changed >> README.md')
      // No wait for the save: Run flow has to save the edit first, or the engine would run the old command.
      await win.click('[data-testid=flow-run]')
      await waitForRun('failed')
      const runId = await latestRun().getAttribute('data-run-id')
      const states = await stepStates()
      t.check('the agent is done, the check failed, the approval was skipped', states.join() === 'done,failed,skipped', states.join())
      t.check('the failed card shows the sentence', (await text(card(1).locator('[data-testid=flow-step-detail]'))).includes(CHECK_SENTENCE))
      t.check('the run card names the step that failed', (await text(latestRun().locator('[data-testid=flow-run-headline]'))) === 'Failed at step 2: DONE.txt exists')
      t.check('the run card shows the sentence too, open at once', (await text(latestRun().locator('[data-testid=flow-run-step-detail]'))).includes(CHECK_SENTENCE))
      t.check('a failed run offers Discard and no Merge', (await win.locator('[data-testid=flow-discard]').count()) === 1 && (await win.locator('[data-testid=flow-merge]').count()) === 0)
      await shot('12-failed-check')

      await win.click('[data-testid=flow-discard]')
      await win.click('[data-testid=flow-confirm-yes]')
      await win.waitForSelector('[data-testid=flow-run-card][data-latest=true][data-discarded=true]', { timeout: 30000 })
      const noteText = await text(latestRun().locator('[data-testid=flow-note]').filter({ hasText: 'refs/regatta/discarded/' }).first())
      const ref = /refs\/regatta\/discarded\/[^\s()]+/.exec(noteText)?.[0]
      t.check('a copy of its work is kept too, and the note names it', ref !== undefined && refExists(ref) && subjectsReachable(ref).includes(subjectOf(runId)), ref)
      t.check('README.md in the project is untouched by the check', readFileSync(join(repoDir, 'README.md'), 'utf8') === '# flows e2e\n')
    })

    await t.step('Stop ends a run that is working, and a plain run touches nothing it did not finish', async () => {
      await card(1).click()
      await win.fill('[data-testid=flow-step-command]', 'test -f DONE.txt')
      await win.click('[data-testid=flow-isolate]')
      t.check('the worktree switch is off again', (await win.locator('[data-testid=flow-isolate]').getAttribute('aria-checked')) === 'false')
      await win.click('[data-testid=flow-run]')
      // Stop is only meant for a run whose agent is at work, so wait for the agent's card to say so.
      await win.waitForSelector('[data-testid=flow-step][data-status=running]', { timeout: 15000 })
      await win.locator('[data-testid=flow-run-stop]').click()
      await waitForRun('stopped')
      const states = await stepStates()
      t.check('the step that was working and the ones after it are skipped', states.join() === 'skipped,skipped,skipped', states.join())
      t.check('the run card says where it stopped', (await text(latestRun().locator('[data-testid=flow-run-headline]'))) === 'Stopped at step 1: Create the file')
      t.check('a plain run has no merge or discard', (await win.locator('[data-testid=flow-merge]').count()) === 0 && (await win.locator('[data-testid=flow-discard]').count()) === 0)
      t.check('the stopped agent left the project as it was', git(['status', '--porcelain'], repoDir).trim() === '')
      t.check('Run flow is available again', await win.locator('[data-testid=flow-run]').isEnabled())
      await shot('13-stopped-working')
    })

    await t.step('Stop on the approval card ends the run after the steps that finished, in the project folder itself', async () => {
      await runToApproval()
      await win.click('[data-testid=flow-stop]')
      await waitForRun('stopped')
      const states = await stepStates()
      t.check('the agent and the check are done, the approval is skipped', states.join() === 'done,done,skipped', states.join())
      t.check('the run card says where it stopped', (await text(latestRun().locator('[data-testid=flow-run-headline]'))) === 'Stopped at step 3: Looks good?')
      t.check('Approve and Stop are gone', (await win.locator('[data-testid=flow-approve]').count()) === 0 && (await win.locator('[data-testid=flow-stop]').count()) === 0)
      // A flow that does not use its own worktree works in the project folder, so its edit is right there.
      t.check('the agent wrote into the project folder itself', git(['status', '--porcelain'], repoDir).includes('src/app.js') && readFileSync(join(repoDir, 'src', 'app.js'), 'utf8').split('\n').filter(Boolean).length === 2)
      await shot('14-stopped-at-approval')
    })

    await t.step('a run whose waiting step was removed can still be approved from its own card', async () => {
      await runToApproval()
      await card(2).click()
      await win.click('[data-testid=flow-step-remove]')
      await win.waitForFunction(() => document.querySelectorAll('[data-testid=flow-step]').length === 2, null, { timeout: 5000 })
      t.check('the card that had Approve is gone', (await win.locator('[data-testid=flow-approve]').count()) === 0)
      await win.waitForSelector('[data-testid=flow-run-approve]', { timeout: 5000 })
      t.check('the run card offers Approve and Stop instead', (await win.locator('[data-testid=flow-run-approve]').count()) === 1 && (await win.locator('[data-testid=flow-run-stop]').count()) === 1)
      t.check('and says the step is no longer in the flow', (await text(latestRun())).includes('a step that was removed'))
      await shot('15-waiting-step-removed')
      await win.click('[data-testid=flow-run-approve]')
      await waitForRun('done')
      t.check('approving there finishes the run', (await text(latestRun().locator('[data-testid=flow-run-headline]'))) === 'All 3 steps passed')
      t.check('and the buttons go with it', (await win.locator('[data-testid=flow-run-approve]').count()) === 0)
      await saved('two steps', (all) => all.some((f) => f.name === FLOW_NAME && f.steps.length === 2))
    })

    await t.step('a recipe fills the steps, and asks before it replaces them', async () => {
      await win.click('[data-testid=flow-new]')
      await win.waitForFunction(() => document.querySelectorAll('[data-testid=flow-row]').length === 2, null, { timeout: 5000 })
      t.check('the new flow has no steps', (await win.locator('[data-testid=flow-step]').count()) === 0)
      await win.locator('[data-testid=flow-recipe][data-recipe=bug]').click()
      await win.waitForFunction(() => document.querySelectorAll('[data-testid=flow-step]').length === 3, null, { timeout: 5000 })
      t.check('a recipe on an empty flow asks nothing', (await win.locator('[data-testid=flow-recipe-dialog]').count()) === 0)
      const kinds = await win.locator('[data-testid=flow-step]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
      t.check('"Fix a bug" gives agent, agent, check', kinds.join() === 'agent,agent,check', kinds.join())
      t.check('the cursor goes to the empty brief', await win.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'flow-brief'))
      t.check('the list row says 3 steps', (await text(win.locator('[data-testid=flow-row][data-selected=true]'))).includes('3 steps'))

      await win.locator('[data-testid=flow-recipe][data-recipe=release]').click()
      await win.waitForSelector('[data-testid=flow-recipe-dialog]', { timeout: 5000 })
      await shot('16-recipe-confirm')
      await win.click('[data-testid=flow-confirm-cancel]')
      await win.waitForSelector('[data-testid=flow-recipe-dialog]', { state: 'detached', timeout: 5000 })
      t.check('Cancel keeps the three steps', (await win.locator('[data-testid=flow-step]').count()) === 3)
      await win.locator('[data-testid=flow-recipe][data-recipe=release]').click()
      await win.click('[data-testid=flow-confirm-yes]')
      await win.waitForFunction(() => document.querySelectorAll('[data-testid=flow-step]').length === 2, null, { timeout: 5000 })
      const replaced = await win.locator('[data-testid=flow-step]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
      t.check('"Review a release" replaced them with agent and approval', replaced.join() === 'agent,approval', replaced.join())
      await saved('both flows', (all) => all.length === 2 && all.some((f) => f.name === 'Untitled flow' && f.steps.map((s) => s.kind).join() === 'agent,approval') && all.some((f) => f.name === FLOW_NAME))
      t.check('the engine has both flows, the recipe flow with two steps', savedFlows().length === 2)
    })

    await t.step('picking a flow in the list shows its own steps and its latest run', async () => {
      await win.locator('[data-testid=flow-row]', { hasText: FLOW_NAME }).click()
      await win.waitForFunction(() => document.querySelectorAll('[data-testid=flow-step]').length === 2, null, { timeout: 5000 })
      t.check('the header and the pipeline switch to the first flow', (await text(win.locator('[data-testid=flow-name]'))) === FLOW_NAME)
      const states = await stepStates()
      t.check('its cards show the latest run, which finished', states.join() === 'done,done', states.join())
      t.check('its history lists all six runs', (await win.locator('[data-testid=flow-run-card]').count()) === 6)
      t.check('the first step is selected', (await inspectorStep()) === (await card(0).getAttribute('data-step-id')))
      await shot('17-runs-history')
    })

    await t.step('the plus stops at 16 steps, the pipeline scrolls, and a flow can be deleted', async () => {
      await win.locator('[data-testid=flow-row]', { hasText: 'Untitled flow' }).click()
      await win.waitForFunction(() => document.querySelectorAll('[data-testid=flow-step]').length === 2, null, { timeout: 5000 })
      for (let i = 0; i < 14; i++) await addStep()
      t.check('16 cards', (await win.locator('[data-testid=flow-step]').count()) === 16)
      t.check('the end plus is off and says why', (await win.locator('[data-testid=flow-add-step]').isDisabled()) && (await text(win.locator('[data-testid=flow-add-step]'))).includes('Step limit reached'))
      t.check('so are the plus buttons between the cards', await win.locator('[data-testid=flow-insert-step]').evaluateAll((els) => els.every((e) => e.disabled)))
      const scroll = await win.locator('[data-testid=flow-pipeline] > div').first().evaluate((el) => ({ scroll: el.scrollWidth, shown: el.clientWidth }))
      t.check('the pipeline scrolls sideways', scroll.scroll > scroll.shown, `${scroll.scroll} > ${scroll.shown}`)
      const lastInView = () =>
        win.locator('[data-testid=flow-step]').last().evaluate((el) => {
          const box = el.getBoundingClientRect()
          const view = el.closest('[data-testid=flow-pipeline]').getBoundingClientRect()
          return box.left >= view.left && box.right <= view.right
        })
      t.check('the new last card was scrolled into view', await until('the last card in view', lastInView, 5000))
      await shot('18-sixteen-steps')

      await win.click('[data-testid=flow-delete]')
      await win.waitForSelector('[data-testid=flow-delete-dialog]', { timeout: 5000 })
      t.check('delete asks first, with the flow\'s name', (await text(win.locator('[data-testid=flow-delete-dialog]'))).includes('"Untitled flow" and its steps will be removed'))
      await win.click('[data-testid=flow-confirm-yes]')
      await win.waitForFunction(() => document.querySelectorAll('[data-testid=flow-row]').length === 1, null, { timeout: 5000 })
      t.check('the flow is gone from the list and the first flow is selected', (await text(win.locator('[data-testid=flow-name]'))) === FLOW_NAME)
      t.check('and from the engine\'s file', (await until('flows.json', () => savedFlows().length === 1)) === true)
    })

    await t.step('a narrow window puts the inspector under the pipeline', async () => {
      await t.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 700))
      await win.waitForFunction(() => window.innerWidth <= 960, null, { timeout: 5000 })
      const header = await win.locator('[data-testid=flow-header]').boundingBox()
      const pipeline = await win.locator('[data-testid=flow-pipeline]').boundingBox()
      const inspector = await win.locator('[data-testid=flow-inspector]').boundingBox()
      const runs = await win.locator('[data-testid=flow-runs]').boundingBox()
      t.check('the inspector sits right under the pipeline, in the same column', Math.abs(inspector.x - pipeline.x) < 2 && inspector.y >= pipeline.y + pipeline.height - 1 && inspector.y - (pipeline.y + pipeline.height) < 8, `pipeline ${pipeline.x},${pipeline.y}+${pipeline.height} inspector ${inspector.x},${inspector.y}`)
      t.check('and the runs follow it, after at most 380 px of inspector', runs.y > inspector.y && runs.y - inspector.y <= 381, `inspector ${inspector.y}, runs ${runs.y}`)
      t.check('the inspector is as wide as the studio, not a 320 px strip', inspector.width > 360 && inspector.width <= header.width)
      t.check('the pipeline is on screen without scrolling the studio', pipeline.y + pipeline.height <= (await win.evaluate(() => window.innerHeight)))
      await shot('19-narrow')
      await t.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
      await win.waitForFunction(() => window.innerWidth >= 1400, null, { timeout: 5000 })
    })
  } finally {
    if (t) results = await t.close()
    if (repoDir) rmSync(repoDir, { recursive: true, force: true })
  }
  return results
}
