import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Context } from '../../context-types.ts'
import { api, type SessionScope } from '../api.ts'
import type { SidebarDiffRef } from '../state.ts'
import { resolveSidebarPath } from '../paths.ts'
import { DiffPane, type ChangesPreview } from '../changes/DiffPane.tsx'
import { loadDiffReview } from './review-storage.ts'
import { Chip } from '../ui/index.ts'
import { t } from '../locales.ts'

/**
 * Worktree writes use the same guarded, undoable line review as session
 * edits. The diff itself is a lazy surface (opening it must not read the
 * document), so the review loads only when the reader asks for it: the
 * fallback diff renders first, with a "review changes" action above it.
 */
export function WorktreeReview({ ctx, scope, diff, fallback, auto = false }: {
  ctx: Context
  scope: SessionScope
  diff: Extract<SidebarDiffRef, { kind: 'worktree' }>
  fallback: ReactNode
  /** The dedicated diff tab opens to review; the bottom preview stays lazy. */
  auto?: boolean
}) {
  const [target, setTarget] = useState<ChangesPreview | null>(null)
  const [armed, setArmed] = useState(auto)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const root = diff.repoRoot ?? diff.worktree ?? scope.cwd
  const path = resolveSidebarPath(root, diff.path)
  const callId = `git-worktree:${path}`
  const gitScope = useMemo(() => ({ sessionId: scope.sessionId, cwd: scope.cwd, ...(diff.repoRoot ? { repoRoot: diff.repoRoot } : {}) }), [scope.sessionId, scope.cwd, diff.repoRoot])
  const reviewable = !diff.staged && !diff.untracked
  useEffect(() => {
    if (!armed || !reviewable) return
    let cancelled = false
    setTarget(null)
    setNotice(null)
    setLoading(true)
    void (async () => {
      try {
        const disk = await api.fsRead(gitScope, path)
        if (cancelled) return
        if (disk.kind !== 'text') {
          setNotice(t('changesReviewUnavailable'))
          return
        }
        const stored = loadDiffReview(scope.sessionId, `${path}:${callId}`, path, disk.content)
        const base = (await api.gitShow(gitScope, ':0', diff.path, diff.worktree)).content
        const saved = stored?.base === base ? stored : null
        if (cancelled || base === null) return
        setTarget({
          kind: 'op', path, prior: base, op: {
            callId, kind: 'write', path, time: 0, running: false, isError: false,
            content: saved?.target ?? disk.content,
          },
        })
      } catch (error) {
        if (!cancelled) setNotice(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [armed, reviewable, diff, path, callId, gitScope, scope.sessionId])
  if (target !== null) {
    return <DiffPane target={target} ctx={ctx} scope={gitScope} height={300} fill
      tabs={[{ id: 'diff', label: 'Diff' }]} onHeightCommit={() => {}} onClose={() => {}} onExpand={() => {}} />
  }
  return (
    <>
      {reviewable && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 8px' }}>
          <Chip active={false} disabled={loading} onClick={() => { setArmed(true) }}>
            {loading ? t('loading') : t('changesReview')}
          </Chip>
        </div>
      )}
      {notice !== null && <div role="status" style={{ padding: '0 10px 4px' }}>{t('changesReviewUnavailable')}: {notice}</div>}
      {fallback}
    </>
  )
}
