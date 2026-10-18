# 测试日志：diff 审阅测试版（0.28.0-cursorlike.4-beta.1）

日期：2026-10-18
环境：Windows 10（PowerShell），Node.js 24.21.0，无 Git、无 pnpm 可用

## 命令与结果

### 类型与构建

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过（exit 0） |
| ESLint（本轮改动文件） | 通过（exit 0） |
| `npm run build` | 通过（tsc + tsdown，lib 已更新） |
| `npm pack --pack-destination release` | 通过，见 `release/dsh-cursorlike-sidebar-0.28.0-cursorlike.4-beta.1.tgz` |

### 目标用例

```powershell
npx vitest run tests/changes-op-review.spec.tsx tests/review-storage.spec.ts tests/review-model.spec.ts `
  tests/text-editor-review.spec.tsx tests/editor-review-e2e.spec.tsx tests/changes-tab.spec.tsx `
  tests/diff-git-target.spec.tsx tests/native-review-actions.spec.tsx tests/api-surface.spec.ts `
  tests/locales.spec.ts tests/service.spec.ts tests/manifest-consistency.spec.ts tests/theme.spec.ts
```

结果：**125 项全部通过**（含按块审阅、撤销持久化、宿主重挂载、普通内容外观、快捷键作用域、官方审阅反向应用、worktree 审阅、皮肤契约）。

### 全量

```powershell
npx vitest run
```

结果：**2768 passed / 96 failed / 19 skipped（242 个文件）**。

失败全部来自本机环境或既有测试问题，与本轮审阅改动无关：

| 类别 | 文件 | 原因 |
| --- | --- | --- |
| 依赖 `git` 可执行文件 | `active-worktree`、`git`、`git-blame`、`git-graph`、`git-worktree`、`git-suggest-route`、`git-remote-actions`、`smoke`（git 段落） | 本机 PATH 没有 `git`，`spawnSync git` 报 ENOENT |
| 依赖 `pnpm` | `plugin-meta`、`market-manifest` | 本机没有 `pnpm`，打包用例无法执行 |
| Windows 符号链接权限 | `fs-operations`、`fs-mkdir`、`file-stream-route`、`archive-tools`（部分） | 创建 symlink 报 EPERM |
| 既有 mock 与源码不一致 | `editor-host` | 测试 mock 只有 `api.fsTrees`，`FileGrid` 调用 `api.fsTree`（与本轮无关） |

审阅相关 spec 在全量运行中同样通过。

## 产物校验

- tarball：`release/dsh-cursorlike-sidebar-0.28.0-cursorlike.4-beta.1.tgz`
- SHA-256：见 `release/SHA256SUMS.txt`
- 已确认 tarball 内含 `lib/client.js`、`lib/client-editor.js`、`lib/client-registry.js`、`lib/index.js`、`lib/types/**`、`locale/*.json`、`icon.svg`、`cordis.patch.yml`
- 已确认 `lib/` 包含：`data-changes-op-review`、`data-changes-tab`、`splitLines`、`data-cursorlike-native-review-actions`、`git-worktree:` 等新标记。

## 未做

- 未提交 git（本机没有 git）。
- 未发布 npm（需要账号与发布权限；本测试版以 tarball 交付）。
- 未在真实 DSH 桌面端做安装回归（当前会话无法驱动桌面窗口）；安装步骤见 beta 说明文档。
