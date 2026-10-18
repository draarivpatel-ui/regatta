// The brief, the recipes, the trigger and the worktree switch: everything about a flow that is not a step.
// Kept short so the pipeline and the runs stay in view.

import { useLayoutEffect, type RefObject } from 'react'
import type { Flow } from '@shared/flows'
import { RECIPES } from '@shared/flows'
import { Button } from '../../components/ui'
import { Toggle } from '../../overlays/settings/Toggle'

interface FlowBriefProps {
  flow: Flow
  briefRef: RefObject<HTMLTextAreaElement | null>
  onBrief: (brief: string) => void
  onRecipe: (recipeId: string) => void
  onIsolate: (isolate: boolean) => void
}

/** The tallest the brief box grows before it scrolls. */
const BRIEF_MAX_HEIGHT = 200

export function FlowBrief({ flow, briefRef, onBrief, onRecipe, onIsolate }: FlowBriefProps): React.JSX.Element {
  // Starts two lines tall and grows with the text, so a long brief is not read through a slot.
  useLayoutEffect(() => {
    const box = briefRef.current
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${Math.min(box.scrollHeight + 2, BRIEF_MAX_HEIGHT)}px`
  }, [flow.brief, flow.id, briefRef])

  return (
    <section data-testid="flow-brief-section" className="px-6 pb-4 pt-4">
      <label htmlFor="flow-brief" className="block text-[12.5px] font-medium text-fg">
        The brief
      </label>
      <textarea
        id="flow-brief"
        ref={briefRef}
        data-testid="flow-brief"
        value={flow.brief}
        onChange={(e) => onBrief(e.target.value)}
        rows={2}
        placeholder={'Say what this flow should get done. Steps can refer to it as {{brief}}.'}
        className="mt-1.5 w-full resize-none rounded-lg border border-line bg-panel px-3 py-2 text-[13px] leading-relaxed text-fg outline-none transition-colors placeholder:text-faint focus:border-accent/50 focus:ring-2 focus:ring-accent/30"
      />

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="mr-1 text-[12.5px] font-medium text-fg">Start from a recipe</span>
        {RECIPES.map((recipe) => (
          <Button
            key={recipe.id}
            variant="outline"
            size="sm"
            className="!h-6 text-[11.5px]"
            data-testid="flow-recipe"
            data-recipe={recipe.id}
            onClick={() => onRecipe(recipe.id)}
          >
            {recipe.name}
          </Button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-start gap-x-6 gap-y-3">
        <label className="block w-[200px] shrink-0">
          <span className="text-[12.5px] font-medium text-fg">Trigger</span>
          <select
            data-testid="flow-trigger"
            value={flow.trigger}
            onChange={() => undefined}
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent/60"
          >
            <option value="manual">Manual run</option>
          </select>
        </label>
        <label className="flex min-w-[250px] flex-1 cursor-pointer items-start gap-3">
          <Toggle checked={flow.isolate} onChange={onIsolate} testId="flow-isolate" label="Run in its own worktree" />
          <span className="min-w-0">
            <span className="block text-[12.5px] font-medium leading-5 text-fg">Run in its own worktree</span>
            <span className="mt-0.5 block text-[11.5px] leading-relaxed text-faint">
              Works in a separate copy of the project. Your files stay as they are until you merge its changes.
            </span>
          </span>
        </label>
      </div>
    </section>
  )
}
