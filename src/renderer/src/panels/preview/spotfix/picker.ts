// The picker that runs INSIDE the preview page. It is a fixed script (never built from page or user
// text), so nothing here interpolates anything from the app being inspected.
//
// Flow: the renderer calls executeJavaScript(PICKER_SOURCE) on the webview. The script returns a
// promise that resolves with the picked element, or null on Escape, while the user hovers and clicks.
// A click leaves a persistent outline on the picked element (the "before" capture is taken with that
// outline still on screen), then the renderer removes it with REMOVE_OUTLINE_SOURCE.

import type { SpotFixPick } from '@shared/spotfix'

/** What the injected script resolves with: the pick fields, minus the URL the renderer fills in. */
export type PickerResult = Omit<SpotFixPick, 'url'>

/**
 * Installs the hover outline and the click/Escape handlers and returns a promise resolving with
 * `{ selector, text, tag, rect }` (rect in CSS pixels) on a click, or null on Escape. A click also
 * leaves a persistent outline element behind (id rg-spotfix-outline) for the before capture.
 */
export const PICKER_SOURCE = `(() => {
  const HOVER = 'rg-spotfix-hover'
  const OUTLINE = 'rg-spotfix-outline'
  const stale = document.getElementById(HOVER)
  if (stale) stale.remove()
  const old = document.getElementById(OUTLINE)
  if (old) old.remove()
  if (window.__rgSpotfixCancel) window.__rgSpotfixCancel()

  const hover = document.createElement('div')
  hover.id = HOVER
  hover.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;display:none;border:2px solid #2dd4bf;background:rgba(45,212,191,0.14)'
  ;(document.documentElement || document.body).appendChild(hover)

  const draw = (boxEl, target) => {
    if (!target) { boxEl.style.display = 'none'; return }
    const r = target.getBoundingClientRect()
    boxEl.style.display = 'block'
    boxEl.style.left = r.left + 'px'
    boxEl.style.top = r.top + 'px'
    boxEl.style.width = r.width + 'px'
    boxEl.style.height = r.height + 'px'
  }

  const pathOf = (el) => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + el.id
    const parts = []
    let cur = el
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      const name = cur.tagName.toLowerCase()
      let n = 1
      let sib = cur.previousElementSibling
      while (sib) { if (sib.tagName === cur.tagName) n++; sib = sib.previousElementSibling }
      parts.unshift(name + ':nth-of-type(' + n + ')')
      cur = cur.parentElement
    }
    return parts.join(' > ')
  }

  const textOf = (el) => {
    const raw = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
    return raw.length > 120 ? raw.slice(0, 120) : raw
  }

  let resolveFn = null
  let current = null

  const teardownHover = () => {
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKey, true)
    if (hover.parentNode) hover.parentNode.removeChild(hover)
  }
  const settle = (value) => {
    delete window.__rgSpotfixCancel
    if (resolveFn) resolveFn(value)
  }

  function onMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY)
    current = el && el !== hover ? el : null
    draw(hover, current)
  }
  function onClick(e) {
    e.preventDefault()
    e.stopPropagation()
    const el = current && current !== hover ? current : document.elementFromPoint(e.clientX, e.clientY)
    if (!el || el === hover) return
    const r = el.getBoundingClientRect()
    const info = {
      selector: pathOf(el),
      text: textOf(el),
      tag: el.tagName.toLowerCase(),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    const outline = document.createElement('div')
    outline.id = OUTLINE
    outline.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;border:2px solid #2dd4bf;outline:3px solid rgba(45,212,191,0.35);background:rgba(45,212,191,0.10)'
    ;(document.documentElement || document.body).appendChild(outline)
    draw(outline, el)
    teardownHover()
    settle(info)
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      teardownHover()
      settle(null)
    }
  }

  window.__rgSpotfixCancel = () => {
    teardownHover()
    const o = document.getElementById(OUTLINE)
    if (o) o.remove()
    settle(null)
  }
  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKey, true)

  return new Promise((resolve) => { resolveFn = resolve })
})()`

/** Removes the persistent outline left after a pick (the hover overlay is already gone by then). */
export const REMOVE_OUTLINE_SOURCE = `(() => {
  const o = document.getElementById('rg-spotfix-outline')
  if (o) o.remove()
  return true
})()`

/**
 * Aborts picking without a click: resolves the pending promise with null and clears every overlay.
 * Used when the user toggles the Spot fix button off before choosing an element.
 */
export const CANCEL_PICKER_SOURCE = `(() => {
  if (window.__rgSpotfixCancel) window.__rgSpotfixCancel()
  const h = document.getElementById('rg-spotfix-hover')
  if (h) h.remove()
  const o = document.getElementById('rg-spotfix-outline')
  if (o) o.remove()
  return true
})()`
