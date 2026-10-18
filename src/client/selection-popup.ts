/**
 * The floating "add selection to conversation" popup shared by the text
 * viewers (markdown preview + the catch-all code viewer): a viewport-anchored
 * button portaled to `document.body`, kept alive across the selection gesture
 * and committed on click.
 *
 * Dismissal contract (fixes upstream issue #425): the popup must never
 * outlive its editor surface. The sidebar keeps every tab MOUNTED — switching
 * tabs only flips the pane cell to `display:none` and collapsing the panel
 * translates it off-screen — while the portaled `position:fixed` button stays
 * pinned to its viewport anchor, ignoring both. The caller already hides on
 * surface scrolls, selection collapse and mode flips; this hook adds the
 * global dismissal that covers everything else:
 *
 * - any `mousedown` outside the button (tab bar, composer, another pane,
 *   the collapse toggle, …) closes it;
 * - `Escape` closes it;
 * - the document going hidden (`visibilitychange`) or the window losing
 *   focus closes it;
 * - an `IntersectionObserver` on the editor surface closes it as soon as the
 *   surface leaves the viewport — the tab-switch (`display:none`) and
 *   panel-collapse (translated off-screen) paths have no DOM events of their
 *   own, so the geometry signal is the only reliable one.
 *
 * The button's own `mousedown` is never treated as an outside click: the
 * caller preventDefaults it to keep the selection/caret alive until the
 * click commits (the hook's capture-phase listener runs first and must not
 * hide for it).
 *
 * The payload is generic: the code editor commits a `SelectionReference`
 * (file + line span), while the popup tests use plain strings. The hook only
 * renders a `label` and hands the payload to the caller's commit/drag
 * callbacks.
 */
import { useEffect, useRef, useState, type RefObject } from 'react'

/** The floating "add to conversation" action: payload + viewport anchor. */
export interface SelectionPopup<T> {
  payload: T
  /** Button text shown to the user. */
  label: string
  left: number
  top: number
}

export interface SelectionPopupOptions<T> {
  placement?: 'selection' | 'surface-bottom-right'
  sessionId?: string
  /** Commit the payload into the composer draft (button click / Ctrl+L). */
  onCommit(payload: T): void
  /**
   * The DOM surface that must stay on screen for the popup to live: the
   * markdown preview container in preview mode, the CodeMirror host
   * otherwise. Called lazily (refs are null until the content loads).
   */
  getSurface(): HTMLElement | null
  /**
   * Build the payload from the surface's LIVE selection at key time. This is
   * what makes Ctrl/Cmd+L independent of the floating button: the popup is
   * deliberately dismissed by scrolling, outside mousedown and window blur,
   * yet the selection itself survives those gestures. Returning null (no
   * selection, a whitespace-only one, or an unavailable surface) leaves the
   * key unhandled.
   */
  resolve?(): T | null
  /** Button text for one payload (defaults to `String(payload)`). */
  label?(payload: T): string
  /** Serialize the payload when the user drags the floating button. */
  onDrag?(transfer: DataTransfer, payload: T): void
}

export interface SelectionPopupControls<T> {
  drag(transfer: DataTransfer): void
  /** The current popup (null = hidden). */
  popup: SelectionPopup<T> | null
  /** Attach to the portaled button element. */
  buttonRef: RefObject<HTMLButtonElement>
  /** Anchor the popup above a selection (viewport-clamped). */
  show(payload: T, left: number, top: number): void
  /** Hide the popup (idempotent). */
  hide(): void
  /** The button's click: commit the stored payload, then hide. */
  commit(): void
}

export function useSelectionPopup<T>(options: SelectionPopupOptions<T>): SelectionPopupControls<T> {
  // Latest-callback refs: the dismissal listeners live for the mount's
  // lifetime, so they must not capture stale closures across renders.
  const onCommitRef = useRef(options.onCommit)
  const getSurfaceRef = useRef(options.getSurface)
  const resolveRef = useRef(options.resolve)
  const labelRef = useRef(options.label)
  const onDragRef = useRef(options.onDrag)
  const placementRef = useRef(options.placement)
  placementRef.current = options.placement
  const sessionRef = useRef(options.sessionId)
  sessionRef.current = options.sessionId
  onCommitRef.current = options.onCommit
  getSurfaceRef.current = options.getSurface
  resolveRef.current = options.resolve
  labelRef.current = options.label
  onDragRef.current = options.onDrag

  const [popup, setPopup] = useState<SelectionPopup<T> | null>(null)
  /** Live mirror for click/event-time reads (no re-render race). */
  const popupRef = useRef<SelectionPopup<T> | null>(null)
  /** The portaled button itself (for the outside-click guard). */
  const buttonRef = useRef<HTMLButtonElement>(null)
  /** The surface visibility observer (created lazily on open). */
  const observerRef = useRef<IntersectionObserver | null>(null)

  const show = (payload: T, left: number, top: number): void => {
    if (placementRef.current === 'surface-bottom-right') {
      const bounds = getSurfaceRef.current()?.getBoundingClientRect()
      if (bounds !== undefined) {
        left = Math.min(bounds.right, window.innerWidth) - 16
        top = Math.min(bounds.bottom, window.innerHeight) - 16
      }
    }
    const next: SelectionPopup<T> = {
      payload,
      label: labelRef.current?.(payload) ?? String(payload),
      left: placementRef.current === 'surface-bottom-right' ? Math.max(16, left) : Math.min(Math.max(left, 80), window.innerWidth - 80),
      top: Math.max(48, top),
    }
    popupRef.current = next
    setPopup(next)
  }

  const hide = (): void => {
    popupRef.current = null
    setPopup(null)
  }

  const commit = (): void => {
    const current = popupRef.current
    if (current === null) return
    onCommitRef.current(current.payload)
    hide()
  }

  const drag = (transfer: DataTransfer): void => {
    const current = popupRef.current
    if (current === null) return
    onDragRef.current?.(transfer, current.payload)
  }

  // Global dismissal listeners, registered once; every handler reads the
  // live popup ref so it no-ops while no popup is open.
  useEffect(() => {
    const onMouseDown = (event: MouseEvent): void => {
      if (popupRef.current === null) return
      const button = buttonRef.current
      if (button !== null && (button === event.target || button.contains(event.target as Node))) return
      hide()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && popupRef.current !== null) hide()
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'l') return
      const surface = getSurfaceRef.current()
      if (surface === null) return
      // Accept the key when EITHER end of the gesture lives on this surface:
      // CodeMirror keydowns target the focused editor, while a preview
      // selection can leave focus on the document with the anchor inside the
      // preview container.
      const target = event.target instanceof Node ? event.target : null
      const anchor = window.getSelection()?.anchorNode ?? null
      const targetInside = target !== null && surface.contains(target)
      if (!targetInside) {
        if (anchor === null || !surface.contains(anchor)) return
        // The anchor-only path belongs to a DOM-selection surface (the
        // markdown preview): the selection survives while focus sits on the
        // document, but NOT while another focusable surface owns the
        // keyboard. Without this guard a keyboard-focused explorer row would
        // re-insert the preview's stale selection instead of its @-reference.
        const active = document.activeElement
        if (active !== null && active !== document.body && !surface.contains(active)) return
      }
      let payload: T | null = popupRef.current?.payload ?? null
      if (payload === null) {
        try {
          payload = resolveRef.current?.() ?? null
        } catch {
          payload = null
        }
      }
      if (payload === null || (typeof payload === 'string' && payload.trim() === '')) return
      event.preventDefault()
      event.stopPropagation()
      onCommitRef.current(payload)
      hide()
    }
    const onDragStart = (event: DragEvent): void => {
      if (event.dataTransfer && popupRef.current && getSurfaceRef.current()?.contains(event.target as Node)) drag(event.dataTransfer)
    }
    const onVisibilityChange = (): void => {
      if (document.hidden && popupRef.current !== null) hide()
    }
    const onWindowBlur = (): void => {
      if (popupRef.current !== null) hide()
    }
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('dragstart', onDragStart, true)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('dragstart', onDragStart, true)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('blur', onWindowBlur)
      observerRef.current?.disconnect()
      observerRef.current = null
    }
  }, [])

  // Re-target the visibility observer whenever a popup opens: the surface
  // refs may have been null at mount (content loads async, mode flips swap
  // the preview container for the CodeMirror host), so the surface is only
  // trustworthy at open time. The boolean flip is the only thing that must
  // re-run this; an anchor move while open keeps the same surface.
  const popupOpen = popup !== null
  useEffect(() => {
    if (!popupOpen) return
    observerRef.current?.disconnect()
    observerRef.current = null
    if (typeof IntersectionObserver === 'undefined') return
    const surface = getSurfaceRef.current()
    if (surface === null) return
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) hide()
      }
    }, { threshold: 0 })
    observerRef.current = observer
    observer.observe(surface)
  }, [popupOpen])

  return { popup, buttonRef, show, hide, commit, drag }
}
