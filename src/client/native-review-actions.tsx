import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api.ts'
import { hostRouteUrl } from './host-route-url.ts'
import { t } from './locales.ts'
import { activeHunkOf, buildPendingReview, keepAllReviewHunks, keepReviewHunk, nextPending, previousPending, rejectAllPendingHunks, rejectReviewHunk, reviewSummary, reviewText, setReviewDecision, REVIEW_UNDO_LIMIT, type PendingReview } from './diff/review-model.ts'
import { loadDiffReview, saveDiffReview, loadDiffReviewUndo, saveDiffReviewUndo } from './diff/review-storage.ts'
import { applyNativeDecisionStyles, attachNativeReviewRows, type NativeReviewRow } from './native-review-rows.ts'
import css from './native-review.module.css'

const initializedReviews = new WeakSet<HTMLElement>()

interface Hunk { newStart: number; lines: string[] }

/** The live file moved past the reviewed hunk: undo would clobber that edit. */
class ReviewConflictError extends Error {}

/** Reverse only matching changed ranges, preserving the rest of the live file. */
export function reverseReviewText(content: string, hunks: Hunk[]): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)
  // Reverse from the bottom up so an earlier splice cannot shift a later
  // hunk's coordinates. The official payload is ascending; sorting also
  // tolerates a caller that hands the hunks over in another order.
  for (const hunk of [...hunks].sort((a, b) => b.newStart - a.newStart)) {
    if (!Number.isInteger(hunk.newStart) || !Array.isArray(hunk.lines)) throw new Error('改动数据不可用')
    // `\ No newline at end of file` markers are metadata, not content lines.
    const body = hunk.lines.filter(line => !line.startsWith('\\'))
    if (body.some(line => line[0] !== ' ' && line[0] !== '+' && line[0] !== '-')) {
      throw new Error('改动数据不可用')
    }
    const after = body.filter(line => line[0] !== '-').map(line => line.slice(1))
    const before = body.filter(line => line[0] !== '+').map(line => line.slice(1))
    const start = after.length === 0 ? hunk.newStart : Math.max(0, hunk.newStart - 1)
    if (after.some((line, index) => lines[start + index] !== line)) {
      throw new ReviewConflictError('文件已有后续修改，无法安全撤销这轮改动。')
    }
    lines.splice(start, after.length, ...before)
  }
  return lines.join(newline)
}

/** Official deliverables.review.file.actions slot, independent of diff-approval. */
export function NativeReviewActions({ actionUrl }: { actionUrl: string }) {
  // Keyed child resets the decision when the selected file/turn changes.
  return <ReviewActions key={actionUrl} actionUrl={actionUrl} />
}

function ReviewActions({ actionUrl }: { actionUrl: string }) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const focusAfterDecision = useRef<Element | null>(null)
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null)
  const live = useRef(true)
  const lock = useRef(false)
  const reviewRef = useRef<PendingReview | null>(null)
  const undoRef = useRef<PendingReview[]>([])
  const [review, setReview] = useState<PendingReview | null>(null)
  const [rows, setRows] = useState<NativeReviewRow[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const root = anchorRef.current?.closest<HTMLElement>('[data-changes-review]')
    if (!root) return
    // New review tabs start unified. A manual split choice remains in force
    // while the user switches files inside that same tab.
    const initializeView = (): void => {
      if (initializedReviews.has(root)) { viewObserver.disconnect(); return }
      const toggle = root.querySelector<HTMLButtonElement>('[data-review-tool="split"]')
      // The host seeds its tab state asynchronously. Wait for actual diff
      // material so an early "false" does not get overwritten by that seed.
      if (!toggle || toggle.getAttribute('aria-pressed') !== 'true' || !root.querySelector('[data-review-view], [data-diff-line]')) return
      initializedReviews.add(root)
      viewObserver.disconnect()
      toggle.click()
    }
    const viewObserver = new MutationObserver(initializeView)
    viewObserver.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-pressed'] })
    const manualViewChoice = (event: Event): void => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-review-tool="split"]')) return
      if (event instanceof KeyboardEvent && !['Enter', ' '].includes(event.key)) return
      initializedReviews.add(root)
      viewObserver.disconnect()
    }
    root.addEventListener('pointerdown', manualViewChoice, true)
    root.addEventListener('keydown', manualViewChoice, true)
    initializeView()
    const bar = document.createElement('div')
    bar.className = css.toolbar ?? ''
    bar.setAttribute('data-cursorlike-review-toolbar', '')
    root.insertBefore(bar, root.children[1] ?? null)
    setToolbar(bar)
    return () => {
      viewObserver.disconnect()
      root.removeEventListener('pointerdown', manualViewChoice, true)
      root.removeEventListener('keydown', manualViewChoice, true)
      bar.remove()
    }
  }, [])
  const coordinates = new URL(actionUrl, document.baseURI).searchParams
  const sessionId = coordinates.get('sessionId') ?? ''
  const identity = `native:${actionUrl}`
  const publish = (value: PendingReview): void => {
    reviewRef.current = value
    saveDiffReview(sessionId, identity, value)
    setReview(value)
  }

  useEffect(() => {
    live.current = true
    const controller = new AbortController()
    setBusy(true)
    setError('')
    void (async () => {
      try {
        if (!sessionId) throw new Error('missing session')
        const params = new URL(actionUrl, document.baseURI).searchParams
        const response = await fetch(hostRouteUrl(`api/changes.diff?${params}`), { signal: controller.signal })
        if (!response.ok) throw new Error('comparison unavailable')
        const diff = await response.json()
        if (diff.kind !== 'text' || diff.before !== true || diff.after !== true || diff.coarse || typeof diff.path !== 'string' || !Array.isArray(diff.hunks)) {
          throw new Error('unsupported comparison')
        }
        const disk = await api.fsRead({ sessionId }, diff.path)
        if (controller.signal.aborted) return
        if (disk.kind !== 'text' || typeof disk.mtimeMs !== 'number') throw new Error('file unavailable')
        const stored = loadDiffReview(sessionId, identity, diff.path, disk.content)
        const normalized = (text: string): string => text.replace(/\r\n?/g, '\n')
        // Older builds saved one decision per line. Regroup their remaining
        // live changes without changing bytes already accepted/rejected.
        const value = stored?.splitLines === true
          ? buildPendingReview(stored.base, normalized(disk.content), diff.path)
          : stored ?? buildPendingReview(normalized(reverseReviewText(disk.content, diff.hunks)), normalized(disk.content), diff.path)
        reviewRef.current = value
        saveDiffReview(sessionId, identity, value)
        // The host may remount this card (refresh/view switch). Recover the
        // last decisions so "undo" keeps working instead of silently vanishing.
        if (stored === null) {
          undoRef.current = []
          saveDiffReviewUndo(sessionId, identity, [])
        } else {
          undoRef.current = loadDiffReviewUndo(sessionId, identity, diff.path)
        }
        setReview(value)
      } catch (cause) {
        if (controller.signal.aborted) return
        console.error('[dsh-cursorlike-sidebar] native line review:', cause)
        setError(cause instanceof ReviewConflictError ? t('saveConflict') : t('changesReviewUnavailable'))
      } finally {
        if (!controller.signal.aborted) setBusy(false)
      }
    })()
    return () => { live.current = false; controller.abort() }
  }, [actionUrl, sessionId, identity, retry])

  // Keep the host's own renderer and split/wrap controls. Portals add actions
  // to its public line elements, scoped to this particular review tab.
  const base = review?.base
  const target = review?.target
  useEffect(() => {
    const root = anchorRef.current?.closest<HTMLElement>('[data-changes-review]')
    const value = reviewRef.current
    if (!root || !value) return
    root.setAttribute('data-cursorlike-native-review', '')
    let attached = attachNativeReviewRows(root, value)
    let observed = [...root.querySelectorAll('[data-diff-line]')]
    setRows(attached.rows)
    const observer = new MutationObserver(() => {
      // Native view changes replace line elements. Portal updates do not.
      const current = [...root.querySelectorAll('[data-diff-line]')]
      const changed = current.length !== observed.length || current.some((row, index) => row !== observed[index])
      if (!changed) return
      observed = current
      observer.disconnect()
      attached.dispose()
      attached = attachNativeReviewRows(root, value)
      setRows(attached.rows)
      observer.observe(root, { childList: true, subtree: true })
    })
    observer.observe(root, { childList: true, subtree: true })
    return () => { observer.disconnect(); attached.dispose(); root.removeAttribute('data-cursorlike-native-review') }
  }, [base, target])

  const active = review === null ? null : activeHunkOf(review)
  useEffect(() => {
    for (const row of rows) {
      const decision = review?.hunks.find(hunk => hunk.id === row.id)?.decision ?? 'pending'
      row.element.dataset.cursorlikeNativeActive = row.id === active ? 'true' : 'false'
      row.element.dataset.cursorlikeNativeDecision = decision
      // Paint the resolved look inline too: the host's own diff CSS may be
      // more specific (or set on a descendant) than our stylesheet override.
      applyNativeDecisionStyles(row.element, decision)
    }
    // Keep one block action mount on a line that survives the decision.
    // Moving the mount preserves the React portal and the native renderer.
    for (const tail of rows.filter(row => row.showActions)) {
      const decision = review?.hunks.find(hunk => hunk.id === tail.id)?.decision ?? 'pending'
      const candidates = rows.filter(row => row.id === tail.id && !(decision === 'keep' && row.element.dataset.diffLine === 'del') && !(decision === 'reject' && row.element.dataset.diffLine === 'add'))
      const destination = candidates.at(-1) ?? tail
      if (tail.mount.parentElement !== destination.element) destination.element.append(tail.mount)
    }
    rows.find(row => row.id === active)?.element.scrollIntoView?.({ block: 'nearest' })
  }, [review, rows, active])

  useEffect(() => {
    const previous = focusAfterDecision.current
    if (!previous) return
    focusAfterDecision.current = null
    if (!previous.isConnected && document.activeElement === document.body) {
      const root = anchorRef.current?.closest('[data-changes-review]')
      root?.querySelector<HTMLButtonElement>('[data-native-current-keep], [aria-keyshortcuts="Control+Z"]')?.focus()
    }
  }, [review])

  const apply = async (next: PendingReview, undo = false): Promise<void> => {
    const before = reviewRef.current
    if (before === null || next === before || lock.current) return
    lock.current = true
    const focused = document.activeElement
    setBusy(true)
    setError('')
    try {
      const disk = await api.fsRead({ sessionId }, before.path)
      if (disk.kind !== 'text' || typeof disk.mtimeMs !== 'number') throw new Error('file unavailable')
      if (disk.content.replace(/\r\n?/g, '\n') !== reviewText(before)) throw new ReviewConflictError('file changed')
      const text = reviewText(next)
      if (text !== reviewText(before)) {
        const output = disk.content.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text
        await api.fsWrite({ sessionId }, before.path, output, disk.mtimeMs)
      }
      saveDiffReview(sessionId, identity, next)
      if (!live.current) return
      if (undo) undoRef.current.pop()
      else undoRef.current = [...undoRef.current, before].slice(-REVIEW_UNDO_LIMIT)
      saveDiffReviewUndo(sessionId, identity, undoRef.current)
      focusAfterDecision.current = focused
      publish(next)
    } catch (cause) {
      if (live.current) setError(cause instanceof ReviewConflictError ? t('saveConflict') : t('changesReviewUnavailable'))
    } finally {
      lock.current = false
      if (live.current) setBusy(false)
    }
  }
  const decide = (kind: 'keep' | 'reject', id?: number): void => {
    const current = reviewRef.current
    if (current === null) return
    const step = id === undefined
      ? kind === 'keep' ? keepAllReviewHunks(current) : rejectAllPendingHunks(current)
      : kind === 'keep' ? keepReviewHunk(current, id) : rejectReviewHunk(current, id)
    void apply(step.review)
  }
  const navigate = (direction: 'next' | 'previous'): void => {
    const current = reviewRef.current
    if (current === null || lock.current) return
    const id = activeHunkOf(current)
    if (id === null) return
    const selected = direction === 'next' ? nextPending(id, current.hunks) : previousPending(id, current.hunks)
    if (selected !== null) publish({ ...current, active: selected })
  }
  useEffect(() => {
    const root = anchorRef.current?.closest<HTMLElement>('[data-changes-review]') ?? null
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.shiftKey || !(event.ctrlKey || event.metaKey)) return
      const focused = document.activeElement
      const inRoot = focused instanceof Element && root !== null && root.contains(focused)
      // A hidden review tab must not answer the page's Ctrl+Z.
      const visible = root === null || typeof root.checkVisibility !== 'function' || root.checkVisibility()
      // After a host remount or a click on the diff text, focus rests on the
      // body; the review page is still the active surface, so Ctrl+Z should
      // undo there too. Text fields keep their own undo.
      if (!inRoot && (!visible || focused !== document.body)) return
      if (focused instanceof HTMLElement && focused.closest('input, textarea, [contenteditable="true"]')) return
      const current = reviewRef.current
      if (current === null || lock.current) return
      const key = event.key.toLowerCase()
      const id = activeHunkOf(current)
      if ((key === 'k' || key === 'j') && (event.altKey || id !== null)) {
        event.preventDefault()
        event.stopPropagation()
        decide(key === 'k' ? 'keep' : 'reject', event.altKey ? undefined : id!)
      } else if (key === 'z' && !event.altKey && undoRef.current.length > 0) {
        event.preventDefault()
        event.stopPropagation()
        void apply(undoRef.current[undoRef.current.length - 1]!, true)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  })
  const summary = review === null ? null : reviewSummary(review)
  const controls = <span className={css.actions} data-cursorlike-native-review-actions>
      {summary !== null && <>
        <span className={css.status} role="status">{summary.pending > 0 ? t('reviewHunkProgress', { index: active === null ? summary.total : active + 1, total: summary.total, remaining: summary.pending }) : `${t('reviewKept')} ${summary.kept} · ${t('reviewRejected')} ${summary.rejected}`}</span>
        {summary.pending > 0 && <>
        <button type="button" disabled={busy || summary.pending < 2} title={t('reviewPrevious')} aria-label={t('reviewPrevious')} onClick={() => navigate('previous')}>↑</button>
        <button type="button" disabled={busy || summary.pending < 2} title={t('reviewNext')} aria-label={t('reviewNext')} onClick={() => navigate('next')}>↓</button>
        <button type="button" className={css.keep} data-native-current-keep disabled={busy || active === null} title="Ctrl+K" aria-keyshortcuts="Control+K" onClick={() => { if (active !== null) decide('keep', active) }}>{t('reviewKeep')} <kbd>Ctrl+K</kbd></button>
        <button type="button" className={css.reject} data-native-current-reject disabled={busy || active === null} title="Ctrl+J" aria-keyshortcuts="Control+J" onClick={() => { if (active !== null) decide('reject', active) }}>{t('reviewReject')} <kbd>Ctrl+J</kbd></button>
        <button type="button" className={css.keep} disabled={busy || summary.pending === 0} onClick={() => decide('keep')}>{t('reviewKeepAll')}</button>
        <button type="button" className={css.reject} disabled={busy || summary.pending === 0} onClick={() => decide('reject')}>{t('reviewRejectAll')}</button>
        </>}
        <button type="button" disabled={busy || undoRef.current.length === 0} title="Ctrl+Z" aria-keyshortcuts="Control+Z" onClick={() => { const previous = undoRef.current.at(-1); if (previous) void apply(previous, true) }}>{t('reviewUndo')} <kbd>Ctrl+Z</kbd></button>
      </>}
      {review === null && busy && <span role="status">{t('loading')}</span>}
      {error && <span role="alert" className={css.error}>{error}</span>}
      {!busy && (review === null || error !== '') && <button type="button" onClick={() => setRetry(value => value + 1)}>{t('refresh')}</button>}
    </span>
  return <>
    <span ref={anchorRef} hidden data-cursorlike-review-anchor="" />
    {toolbar !== null && createPortal(controls, toolbar)}
    {rows.filter(row => row.showActions).map((row, index) => createPortal(<span className={css.lineActions}>
      {review?.hunks.find(hunk => hunk.id === row.id)?.decision !== 'pending'
        ? <><span className={css.resolved}>{review?.hunks.find(hunk => hunk.id === row.id)?.decision === 'keep' ? t('reviewKept') : t('reviewRejected')}</span><button type="button" disabled={busy} data-native-reopen={row.id} title={t('reviewUndo')} aria-label={t('reviewUndo')} onClick={() => { const current = reviewRef.current; if (current) void apply(setReviewDecision(current, row.id, 'pending')) }}>↶</button></>
        : <>
      <button type="button" className={css.keep} disabled={busy} data-native-line-keep={row.id} aria-pressed={review?.hunks.find(hunk => hunk.id === row.id)?.decision === 'keep'} onClick={() => decide('keep', row.id)}>{t('reviewKeep')}</button>
      <button type="button" className={css.reject} disabled={busy} data-native-line-reject={row.id} aria-pressed={review?.hunks.find(hunk => hunk.id === row.id)?.decision === 'reject'} onClick={() => decide('reject', row.id)}>{t('reviewReject')}</button>
        </>}
    </span>, row.mount, `${row.id}:${index}`))}
  </>
}
