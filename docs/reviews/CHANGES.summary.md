# 改动清单：0.28.0-cursorlike.1 → 0.28.0-cursorlike.4-beta.1

- 基线：`dsh-cursorlike-sidebar-0.28.0-cursorlike.1.tgz` 的 `package/src`
- 当前：工作区 `src/`、根清单、审阅文档与相关测试
- 构建产物 `lib/` 不参与 diff（由 `npm run build` 生成）

- 变更文件：81（+7042 / −605 行）

| 文件 | 状态 | +行 | −行 |
| --- | --- | ---: | ---: |
| `README.md` | modified | 225 | 102 |
| `README_ZH.md` | modified | 5 | 1 |
| `docs/reviews/2026-10-18-diff-review-beta.md` | added | 127 | 0 |
| `docs/reviews/2026-10-18-diff-review-test-log.md` | added | 58 | 0 |
| `dsh.plugin.json` | added | 16 | 0 |
| `package.json` | modified | 1 | 1 |
| `src/client/DiffTab.tsx` | modified | 7 | 3 |
| `src/client/EditorHost.tsx` | modified | 48 | 12 |
| `src/client/FileColumns.tsx` | modified | 51 | 136 |
| `src/client/FileGrid.tsx` | modified | 85 | 69 |
| `src/client/FileTree.tsx` | modified | 71 | 10 |
| `src/client/TabBar.tsx` | modified | 7 | 1 |
| `src/client/TextEditor.tsx` | modified | 714 | 172 |
| `src/client/TreePanel.tsx` | modified | 261 | 11 |
| `src/client/api.ts` | modified | 26 | 7 |
| `src/client/builtins/tabs.tsx` | modified | 1 | 1 |
| `src/client/changes/ChangesTab.tsx` | modified | 52 | 3 |
| `src/client/changes/DiffPane.tsx` | modified | 588 | 13 |
| `src/client/changes/changes.module.css` | modified | 36 | 0 |
| `src/client/changes/op-review.ts` | added | 49 | 0 |
| `src/client/conversation-draft.ts` | modified | 9 | 4 |
| `src/client/cursorlike-interactions.ts` | modified | 7 | 1 |
| `src/client/diff-actions-bridge.ts` | added | 97 | 0 |
| `src/client/diff/DiffRows.tsx` | modified | 57 | 7 |
| `src/client/diff/WorktreeReview.tsx` | added | 83 | 0 |
| `src/client/diff/diff.module.css` | modified | 37 | 0 |
| `src/client/diff/review-model.ts` | added | 547 | 0 |
| `src/client/diff/review-storage.ts` | added | 38 | 0 |
| `src/client/diff/use-git-diff.ts` | modified | 3 | 1 |
| `src/client/editor-dirty.ts` | modified | 10 | 0 |
| `src/client/file-browser-actions.tsx` | added | 315 | 0 |
| `src/client/file-clipboard.ts` | added | 21 | 0 |
| `src/client/icons.tsx` | modified | 9 | 0 |
| `src/client/ignore-file.ts` | modified | 15 | 0 |
| `src/client/index.tsx` | modified | 9 | 0 |
| `src/client/locales-ar.ts` | modified | 25 | 0 |
| `src/client/locales-de.ts` | modified | 25 | 0 |
| `src/client/locales-fr.ts` | modified | 25 | 0 |
| `src/client/locales-hi.ts` | modified | 25 | 0 |
| `src/client/locales-id.ts` | modified | 25 | 0 |
| `src/client/locales-it.ts` | modified | 25 | 0 |
| `src/client/locales-ja.ts` | modified | 25 | 0 |
| `src/client/locales-ko.ts` | modified | 25 | 0 |
| `src/client/locales-nl.ts` | modified | 25 | 0 |
| `src/client/locales-pl.ts` | modified | 25 | 0 |
| `src/client/locales-pt.ts` | modified | 25 | 0 |
| `src/client/locales-ru.ts` | modified | 25 | 0 |
| `src/client/locales-sv.ts` | modified | 25 | 0 |
| `src/client/locales-th.ts` | modified | 25 | 0 |
| `src/client/locales-tr.ts` | modified | 25 | 0 |
| `src/client/locales-vi.ts` | modified | 25 | 0 |
| `src/client/locales-zh-HK.ts` | modified | 25 | 0 |
| `src/client/locales-zh-MO.ts` | modified | 25 | 0 |
| `src/client/locales-zh-TW.ts` | modified | 25 | 0 |
| `src/client/locales.ts` | modified | 50 | 0 |
| `src/client/native-review-actions.tsx` | added | 225 | 0 |
| `src/client/native-review-rows.ts` | added | 55 | 0 |
| `src/client/native-review.module.css` | added | 22 | 0 |
| `src/client/selection-payload.ts` | modified | 102 | 10 |
| `src/client/selection-popup.ts` | modified | 12 | 2 |
| `src/client/selection-reference.ts` | modified | 16 | 0 |
| `src/client/service.ts` | modified | 1 | 1 |
| `src/client/sidebar.module.css` | modified | 200 | 11 |
| `src/client/split-pane.tsx` | modified | 4 | 2 |
| `src/client/state.ts` | modified | 17 | 2 |
| `src/client/use-file-history.tsx` | added | 145 | 0 |
| `src/file-history-types.ts` | added | 25 | 0 |
| `src/file-history.ts` | added | 244 | 0 |
| `src/fs-operations.ts` | modified | 55 | 2 |
| `src/fs-tree.ts` | modified | 2 | 3 |
| `src/index.ts` | modified | 29 | 17 |
| `src/search-engines.ts` | modified | 1 | 0 |
| `tests/api-surface.spec.ts` | added | 69 | 0 |
| `tests/changes-op-review.spec.tsx` | added | 338 | 0 |
| `tests/diff-git-target.spec.tsx` | added | 214 | 0 |
| `tests/editor-review-e2e.spec.tsx` | added | 213 | 0 |
| `tests/native-review-actions.spec.tsx` | added | 35 | 0 |
| `tests/review-model.spec.ts` | added | 246 | 0 |
| `tests/review-storage.spec.ts` | added | 55 | 0 |
| `tests/text-editor-review.spec.tsx` | added | 217 | 0 |
| `tests/theme.spec.ts` | added | 290 | 0 |

## 两个 diff 文件

| 文件 | 范围 | 规模 |
| --- | --- | --- |
| `release/dsh-cursorlike-0.28.0-cursorlike.1..0.28.0-cursorlike.4-beta.1.diff` | 工作区全部变更（含同期文件浏览/历史等改动） | 81 文件，+7042 / −605 |
| `release/dsh-cursorlike-0.28.0-cursorlike.4-beta.1-review-feature.diff` | 只含 diff 审阅功能相关文件（模型/编辑器/更改页/worktree/官方审阅/文案/测试/文档） | 47 文件，+5046 / −210 |

审核 diff 功能建议先看第二份；第一份用于完整回归。

## 审核重点

1. `src/client/diff/review-model.ts`：块/行决策模型、文本重建、撤销、持久化。
2. `src/client/changes/DiffPane.tsx`：行级 ✓/✕、写盘、跨文件跳转、快捷键。
3. `src/client/changes/ChangesTab.tsx`：审阅完成后的文件队列。
4. `src/client/diff/WorktreeReview.tsx`：worktree diff 的按需逐行审阅。
5. `src/client/TextEditor.tsx`：编辑器内联块审阅、自动跳转、快捷键。
6. `src/client/native-review-actions.tsx`：官方审阅 Keep/Revert 与反向应用。
7. `src/client/diff/DiffRows.tsx` / `diff.module.css`：行按钮与状态样式。

## 说明

- 本次 diff 以仓库内保留的上一版 tarball 为基线；不是 git 提交历史。
- 测试文件在基线 tarball 中不存在，因此按新增文件展示。
