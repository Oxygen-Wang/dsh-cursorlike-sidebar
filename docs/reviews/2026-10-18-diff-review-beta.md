# 测试版说明：Cursor 式按块改动审阅（0.28.0-cursorlike.4-beta.1）

> 本文档用于把本轮改动交给外部审核（GPT）与真实 DSH 环境试用。
> 审核重点是「改动审阅」相关行为；仓库里同时存在的 file-history、原生文件操作等改动不在本轮验收范围内。

> 后续补修：官方“第 N 轮改动”页现已直接增加逐行保留/撤销、跳转、动作撤销与决定恢复，并补齐新增绿字/删除红字。下文“官方仅逐文件”的描述是本次补修前的状态，当前范围以 [Diff 需求](../requirements-diff-zh.md) 为准。本次 137 项相关回归通过，另有本地 Chrome 行布局复现验证；真实宿主验收仍待进行。

## 产物

| 产物 | 路径 |
| --- | --- |
| 插件 tarball | `release/dsh-cursorlike-sidebar-0.28.0-cursorlike.4-beta.1.tgz` |
| 校验和 | `release/SHA256SUMS.txt` |
| 源码 | 仓库根目录（`src/`、`lib/` 已重新构建） |

安装/试用：

```powershell
# 1) 停用原版 dsh-better-sidebar；2) 安装测试包；3) 完全退出并重启 DSH
dsh plugin --profile desktop add .\release\dsh-cursorlike-sidebar-0.28.0-cursorlike.4-beta.1.tgz
```

本地 `link:` 开发安装不需要重装：`npm run build` 后刷新 DSH 页面即可。

## 需求对照

| 需求 | 实现 | 入口 |
| --- | --- | --- |
| 类似 Cursor 的红/绿 diff，标出改了什么 | 新增/改写行绿色底色，删除行与改写前的旧行用红色删除块（带删除线） | 编辑器内联审阅；「更改」页 diff |
| 保留后自动跳转下一个 diff | 编辑器：保留/撤销当前改动块后自动选中并滚动到下一块；「更改」页：按块处理后自动定位下一块，整个文件处理完自动切到下一个改动文件 | 两处 |
| `Ctrl+Alt+K` / `Ctrl+Alt+J` 全部保留 / 全部撤销 | 两处审阅面板均支持；`Ctrl+Z` 撤回上一步 | 两处 |
| 官方审阅没有「确认/不确认」 | 官方 `deliverables.review.file.actions` 槽位注入 Keep/Revert（逐文件）；保留/撤销不依赖 dsh-diff-approval | 官方改动审阅卡片 |
| 具体改动块的保留 / 不保留 | 「更改」页、官方审阅页与 worktree diff 的每个改动块都带同意/不同意 | 三处审阅面 |

## 交互速查

### 编辑器（Agent 改动当前打开的文件）

- 内联显示：绿色行 = 保留的改动；红色块 = 被删除/替换的旧内容。
- 操作条：`Change 2 of 5 · 3 left`、上一处/下一处、保留本块、撤销本块、全部保留、全部撤销。
- 快捷键：`Ctrl+K` 保留、`Ctrl+J` 撤销、`Ctrl+Alt+K` 全部保留、`Ctrl+Alt+J` 全部撤销、`Ctrl+Z` 撤销上一步。
- 保存（`Ctrl+S`）会视为接受当前文档并结束审阅。

### 「更改」页（本轮文件）

- 「本轮文件」选择一个 write/edit 操作；能安全重建完整旧内容时，diff 每一行出现 ✓ / ✕。
- 当前行高亮；处理完自动滚到下一行；文件全部处理完后自动选中下一个改动文件。
- 撤销立即写盘；已撤销行变灰加删除线；同一行再点 ✓ 会恢复 Agent 版本并重新写盘。
- 快捷键同上，作用范围限定在「更改」页（不会抢聊天输入框的键）。

### 官方改动审阅

- 官方 file review 的 actions 槽位出现「保留 / 撤销」。
- 撤销按官方 diff 的 hunk 反向应用；若文件已有后续修改则拒绝覆盖并报错。
- 决策仅本地记录，不回写宿主状态。

## 安全门槛（为什么有时看不到撤销按钮）

「更改」页/ worktree 的逐块审阅只在以下条件全部满足时启用：

1. 会话或 git 能提供**完整的旧内容**（不是片段）；
2. 磁盘当前内容仍等于该改动的**新内容**；
3. 未开启会命中该文件的脱敏（脱敏时只读，避免把掩码写回）。

不满足时保留原始只读 diff，并显示原因（旧内容未知 / 文件已被其他来源修改 / 脱敏 / 读不到文件）。
新建、未跟踪、二进制、超大文件不走写回。

## 本轮小修（相对上一个 beta）

- 官方审阅：Keep/已保留/已撤销文案本地化；撤销失败按“冲突/不可用”显示本地化提示，详细原因写控制台。
- 官方审阅：撤销 hunk 先按 `newStart` 从下往上排序，兼容乱序数据；忽略 `\ No newline` 元数据行；拒绝非法行，避免错误 splice。
- 「更改」页审阅存储：磁盘内容按行尾规范化比较（CRLF/LF 不再误判为不同版本）。
- worktree 审阅：内联预览不再一打开就读文件（保留懒加载契约）；专用 diff tab 仍自动进入审阅。
- 审阅会话：无关的会话轮询不再重置进行中的审阅；快速连点不会丢决策；恢复的已完成审阅不会自动跳走。
- 快捷键作用域收窄到「更改」页/编辑器审阅上下文。
- 修复 `.selectionPopup` 的硬编码颜色，恢复皮肤契约（`theme.spec`）。
- 官方审阅页：同意/拒绝后行内写入普通内容外观（并保存宿主原始内联样式），`Ctrl+Z` 精确恢复红绿对比；撤销栈持久化，宿主重挂载或刷新后仍可撤回上一步；页面空白处获得焦点时 `Ctrl+Z` 也生效（隐藏标签页与非输入框除外）。

## 已知限制

- 编辑器内联审阅与「更改」页、worktree 审阅都按**连续改动块（hunk）**处理，不是逐行独立决定。
- 跨文件自动跳转只在「更改」页生效；编辑器处理完最后一个块后只关闭审阅，不换文件。
- 审阅完成后会立即跳到下一个文件，因此该文件的撤销条不可见；回到该文件可继续调整。
- 撤销栈保存在 localStorage（最多 12 步，按容量保留最新若干步）；超大文件可能只保留一步，清空浏览器存储后不可恢复。
- 超过 400KB 的文档不会写入 localStorage（审阅仍可用，只是刷新后不恢复）。
- 官方审阅页对历史/暂存/二进制等对比保持只读；错误显示随界面语言本地化，详细原因只写控制台。

## 验证

```powershell
npm run typecheck
node .\node_modules\eslint\bin\eslint.js src/client/...
npm run build
npx vitest run tests/changes-op-review.spec.tsx tests/review-storage.spec.ts tests/review-model.spec.ts `
  tests/text-editor-review.spec.tsx tests/editor-review-e2e.spec.tsx tests/changes-tab.spec.tsx `
  tests/native-review-actions.spec.tsx tests/locales.spec.ts tests/service.spec.ts
```

本轮结果（详见 `docs/reviews/2026-10-18-diff-review-test-log.md`）：

- `tsc --noEmit`：通过
- ESLint（改动文件）：通过
- 审阅相关 spec：通过（125 项，含撤销持久化/宿主重挂载/普通内容外观）
- 全量 vitest：**2768 passed / 96 failed / 19 skipped**；失败为本机环境（缺 git / pnpm、Windows 符号链接 EPERM）与既有 `editor-host` mock 陈旧，分类见测试日志
- 皮肤契约（`theme.spec`）：通过

## 审核清单建议

1. 「更改」页选一个多行改动：逐块同意/不同意、自动跳转、进度、全部同意/不同意、`Ctrl+Z`。
2. 同一行撤销后再保留：磁盘内容是否恢复、是否重复写。
3. 编辑未打开的文件后，「更改」页是否都能看到可审阅状态；旧内容未知时是否安全降级。
4. 文件在磁盘被外部修改后再点撤销：是否拒绝并提示。
5. 编辑器内联审阅：红绿标注、自动跳下一块、`Ctrl+Alt+K/J`、保存后审阅结束。
6. 官方改动卡片：Keep/Revert 是否出现、撤销后文件内容、冲突时是否拒绝。
7. 刷新/重启后：未处理审阅是否恢复；已处理的是否不再提示。

## 主要文件

- `src/client/diff/review-model.ts` — 审阅模型（块/行决策、文本重建、撤销、持久化）
- `src/client/diff/review-storage.ts` — 「更改」页审阅的本地存储
- `src/client/changes/DiffPane.tsx` — 「更改」页审阅状态、写盘、快捷键、跨文件跳转
- `src/client/changes/ChangesTab.tsx` — 审阅完成后的文件队列跳转
- `src/client/changes/op-review.ts` — 由会话操作重建完整 old/new 文档
- `src/client/diff/DiffRows.tsx`、`src/client/diff/diff.module.css` — 块操作按钮、当前块/已处理块样式
- `src/client/diff/WorktreeReview.tsx` — worktree diff 的按需逐块审阅
- `src/client/TextEditor.tsx`、`src/client/sidebar.module.css` — 编辑器内联审阅
- `src/client/native-review-actions.tsx`、`src/client/index.tsx` — 官方审阅 actions 槽位
- 测试：`tests/changes-op-review.spec.tsx`、`tests/review-storage.spec.ts`、`tests/review-model.spec.ts`、`tests/text-editor-review.spec.tsx`、`tests/editor-review-e2e.spec.tsx`、`tests/native-review-actions.spec.tsx`
