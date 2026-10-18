# CursorLike Sidebar

DSH 桌面端内嵌侧边栏，包名 **`dsh-cursorlike-sidebar`**，项目目录 **`dsh-cursorlike`**。
基于 [Better Sidebar v0.28.0](https://github.com/omdsh-dev/DSH-better-sidebar) 修改，保留 MIT 许可证。
本插件是独立的 DeepSeek Harness 插件，与 Cursor / Anysphere 无隶属关系。

提供文件树、代码编辑、搜索、Git 差异视图、原生终端、侧边对话和分屏，主题跟随 DSH。
增加文件树选中文件后 Ctrl+L 添加引用、编辑器选中代码后 Ctrl+L 添加到对话；编辑器里没有选中时 Ctrl+L 添加当前行（与 Cursor 一致），Markdown 预览里选中文本后同样可用。插入格式是 **`@文件 line 12-18`**：原生 `@file` chip + 行号后缀，不再默认塞入整段代码。支持拖动文件引用或选中代码到聊天输入区，拖动文件引用到文件面板打开。
Agent 修改当前打开的文件后，**最后一个改动行后面**出现“保留 / 撤销”操作条：`Ctrl+K` 保留、`Ctrl+J` 撤销、`Ctrl+Z` 撤销上一步；保留后条消失。
支持工作区根目录 `.ignore`（gitignore 风格 glob，隐藏文件/文件夹；第一版只读根文件，暂不支持 `!` 反向选择，编辑后点一次刷新）。
文件树工具栏可切换 **树形 / 桌面图标网格 / Miller 多列**：图标网格第一格是“返回”，文件夹单击进入，文件单击打开，右键可打开 / 新 Tab / 侧边 / 引用 / 复制路径，拖拽可引用；多列模式点文件夹会在右侧追加一列，多级目录并排。
已安装 `dsh-diff-approval` 时，本插件会把它从旧的浮层默认**一次性迁到 DSH 原生右侧栏 dock**，并把 Keep 动作显示为绿色、Revert 显示为红色；之后你在它的菜单里显式改回 float 会保留你的选择。
文件树上按 `Ctrl+滚轮` 可放大/缩小图标（10–32px，本地记住），类似桌面浏览器的缩放手势。
保留 DSH 原有 Ctrl+B 行为。不需要额外桌面软件或 Python 运行时，不包含 PDF 依赖。

## 安装

适配 DSH 0.2.1-rc.1 及兼容版本。

### 从 npm 安装（发布后，自动更新推荐）

插件发布到 npm 后可安装包名：

```powershell
dsh plugin --profile desktop add dsh-cursorlike-sidebar
```

只有 npm / GitHub 来源能被 DSH Plugin Market 检查更新；本地 `link:` 安装和固定 tag 的 tarball 不会自动更新。

### 从 Release 安装（不需要 Git）

直接使用 release 里的 tarball：

```powershell
dsh plugin --profile desktop add https://github.com/Oxygen-Wang/dsh-cursorlike-sidebar/releases/download/v0.28.0-cursorlike.1/dsh-cursorlike-sidebar-0.28.0-cursorlike.1.tgz
```

### 从 GitHub 源码安装

需要本机 `git` 在 PATH 上（pnpm 解析 `github:` 规格会调用 git）：

```powershell
dsh plugin --profile desktop add github:Oxygen-Wang/dsh-cursorlike-sidebar
```

也可以在 DSH 的「添加插件」里填入上面的 GitHub 规格，安装后重启 DSH。
仓库已提交构建好的 `lib/`（不含 source map），因此 GitHub 安装不需要本地构建。

### 本地开发安装

插件已经以 `link:` 方式安装时，不需要每次重装。依赖只需装一次：

```powershell
npm install
```

启动监听（`tsdown --watch`，不需要 pnpm 在 PATH 上）：

```powershell
npm run dev
# 或： pwsh -File scripts/dev.ps1
```

- 改客户端代码：保存后按 `Ctrl+R` 刷新 DSH 页面；
- 改 Host 代码（`src/index.ts`、`src/*.ts`）：需要完全重启 DSH；
- 一次性构建：`npm run build`
- 类型检查：`npm run typecheck`

在 DSH「添加插件」里选择本地目录 `dsh-cursorlike`。
先停用原版 `dsh-better-sidebar`：本分支保留其内部服务和路由，二者不能同时启用。
安装或更新后需要重启 DSH，插件才会在原生右侧栏中挂载。
通过 DSH 原生右侧栏入口使用。

## 自动更新

DSH 的 **Plugin Market** 会为已安装插件做更新检查：

- **npm 安装**：比较已安装版本与 npm `latest`，有一键 Update / Update all；
- **GitHub 安装**：比较 git HEAD 与版本；只有版本前进（发版/改版本号）才提供更新，普通 commit 只显示“有新提交（未发版）”；
- **本地 `link:`**：不会自动更新——它始终使用目录里的 `lib`，改完执行 `npm run build` 后刷新页面即可；
- **固定 tag 的 tarball**：不会自动更新，需要重新安装新 tarball。

所以给最终用户用时，推荐发布到 npm：

```powershell
npm login
npm publish --access public --tag latest
```

发布后在 DSH「设置 → Plugin Market → 已安装」里检查更新；市场只自动**检查**，应用更新需要点一次 Update（不会静默替换代码）。

## 开发与来源

```powershell
pnpm typecheck
pnpm test:windows
pnpm pack
```

`reference/` 为研究源码，`.prototype/` 为早期原型，两者不进入安装包。
另参考 [dsh-diff-approval v0.35.0](https://github.com/9087/dsh-diff-approval) 的改动审查交互；其逐块保留/回退实现尚未合并，当前使用上游的 Git 差异视图。
构建和自动化测试不能替代真实 DSH 桌面端的安装、拖放验证。
