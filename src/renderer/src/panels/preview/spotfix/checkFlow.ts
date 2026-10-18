// Pure helpers behind the Spot fix card: which files every round touched, which of them define the
// checks, and which rounds cannot be undone. Unit tested in checkFlow.test.ts.

import type { CheckSpec } from '@shared/heats'
import type { SpotFix } from '@shared/spotfix'
import type { StepFile } from '@shared/checkpoints'

/**
 * Every file any round touched, for the card list and the undo confirmation. When several rounds touch the
 * same path the newest round's numbers win (they describe the file as it stands now).
 */
export function changedFilesAcrossRounds(fix: SpotFix): StepFile[] {
  const byPath = new Map<string, StepFile>()
  for (const round of fix.rounds) {
    for (const f of round.files) byPath.set(f.path, f)
  }
  return [...byPath.values()]
}

/** 1-based numbers of the launched rounds that never got through checkpoints.end, so Undo cannot reach past them. */
export function unfinishedRounds(fix: SpotFix): number[] {
  const out: number[] = []
  fix.rounds.forEach((round, i) => {
    if (round.launched !== false && !round.completed) out.push(i + 1)
  })
  return out
}

/**
 * True when any round of this Spot fix changed at least one file. Checks run code out of the user's own
 * project, and any changed file can be reached from that code, so the card always asks for a second click
 * in this case: it never relies on spotting which files define the checks (finding 2, round 2).
 */
export function runsChangedCode(fix: SpotFix): boolean {
  return changedFilesAcrossRounds(fix).length > 0
}

/**
 * Tracks the one pick that may still land in the note box. A pick is started, then its page may navigate
 * away or the user may cancel; whatever resolves afterwards belongs to a page that is gone (finding 7,
 * round 2), so the panel asks this whether the result is still current.
 */
export class PickSequence {
  private token = 0

  /** Begins a pick and returns the token that alone may deliver a result. */
  start(): number {
    this.token += 1
    return this.token
  }

  /** Ends the outstanding pick: a navigation, a cancel, or a Stop of the same button. */
  cancel(): void {
    this.token += 1
  }

  /** True when this token is still the pick the page on screen is waiting for. */
  current(token: number): boolean {
    return token === this.token
  }
}

/** Manifests whose content defines which checks exist; a round that edits one makes running checks unsafe to skim. */
const MANIFESTS = new Set(['package.json', 'Makefile', 'makefile', 'GNUmakefile', 'pyproject.toml', 'pytest.ini', 'go.mod', 'Cargo.toml', 'tsconfig.json'])

/** Config files read or executed by test runners, typecheckers, linters and bundlers. */
const CONFIG_RE =
  /(^|\/)(vitest\.config|vitest\.workspace|jest\.config|test\.config|playwright\.config|karma\.conf|cypress\.config|conftest\.py|setup\.cfg|tox\.ini|phpunit\.xml|\.eslintrc|eslint\.config|\.prettierrc|prettier\.config|biome\.json|stylelint\.config|\.stylelintrc|tsconfig\..*\.json|jsconfig.*\.json|vite\.config|next\.config|postcss\.config|tailwind\.config|svelte\.config|astro\.config|webpack\.config|rollup\.config|tsup\.config|babel\.config)/

/** Test files themselves, when the command runs a test runner. */
const TEST_FILE_RE = /(\.|\/)(test|spec)\.[cm]?[jt]sx?$/

/** True when the command string looks like one that runs tests. */
function testRunner(command: string): boolean {
  return /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?test|(^|\s)(pytest|vitest|jest|mocha|go\s+test|cargo\s+test|make\s+test)(\s|$)/.test(command)
}

/**
 * The round's files that define (or are read by) the checks about to run: manifests, check/linter/typecheck/bundler
 * config files, test files when running tests, and any file or folder the check command names directly.
 */
export function checkDefinitionConflicts(specs: CheckSpec[], touched: string[]): string[] {
  if (specs.length === 0) return []
  const tokens = specs.flatMap((s) => s.command.split(/\s+/))
  const named = new Set(
    tokens
      .filter((t) => t.includes('/') || /\.(json|toml|ini|ya?ml|js|mjs|cjs|ts)$/.test(t))
      .map((t) => t.replace(/^\.\//, ''))
  )
  const runsTests = specs.some((s) => testRunner(s.command))
  const hits = new Set<string>()
  for (const path of touched) {
    if (MANIFESTS.has(path)) {
      hits.add(path)
      continue
    }
    if (named.has(path)) {
      hits.add(path)
      continue
    }
    if (CONFIG_RE.test(path)) {
      hits.add(path)
      continue
    }
    if (runsTests && TEST_FILE_RE.test(path)) {
      hits.add(path)
      continue
    }
  }
  return [...hits].sort()
}

/** True when the card's Stop button should be visible and active (while an agent round or check pass runs). */
export function canStopSpotFix(status: SpotFix['status']): boolean {
  return status === 'running' || status === 'checking'
}

/** The check specs detected for `fix.cwd` on the record itself, never from a different workspace root. */
export function detectedChecksFor(fix: SpotFix, latest?: SpotFix[]): CheckSpec[] {
  const match = latest?.find((f) => f.id === fix.id)
  return match?.detectedChecks ?? fix.detectedChecks ?? []
}

/** The exact commands the card lists before anything runs. */
export function checkCommandsOf(specs: CheckSpec[]): string[] {
  return specs.map((s) => `${s.name}: ${s.command}`)
}

/**
 * The URL the preview page is actually on: the trail follows every navigation (a link, a redirect,
 * Back, Forward), so "Spot fix works on localhost" is judged on the current page, not the first src.
 */
export function currentPreviewUrl(src: string, urls: string[], at: number): string {
  return urls[at] ?? src
}
