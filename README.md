# CursorLike Sidebar

DSH 桌面端内嵌侧边栏，包名 **`dsh-cursorlike-sidebar`**，项目目录 **`dsh-cursorlike`**。
基于 [Better Sidebar v0.28.0](https://github.com/omdsh-dev/DSH-better-sidebar) 修改，保留 MIT 许可证。
本插件是独立的 DeepSeek Harness 插件，与 Cursor / Anysphere 无隶属关系。

提供文件树、代码编辑、搜索、Git 差异视图、原生终端、侧边对话和分屏，主题跟随 DSH。
增加文件树选中文件后 Ctrl+L 添加引用、编辑器选中代码后 Ctrl+L 添加到对话；编辑器里没有选中时 Ctrl+L 添加当前行（与 Cursor 一致），Markdown 预览里选中文本后同样可用。支持拖动文件引用或选中代码到聊天输入区，拖动文件引用到文件面板打开。
支持工作区根目录 `.ignore`（gitignore 风格 glob，隐藏文件/文件夹；第一版只读根文件，暂不支持 `!` 反向选择，编辑后点一次刷新）。
文件树上按 `Ctrl+滚轮` 可放大/缩小图标（10–32px，本地记住），类似桌面浏览器的缩放手势。
保留 DSH 原有 Ctrl+B 行为。不需要额外桌面软件或 Python 运行时，不包含 PDF 依赖。

## 安装

适配 DSH 0.2.1-rc.1 及兼容版本。

### 从 Release 安装（推荐，不需要 Git）

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

```powershell
pnpm install --ignore-scripts --frozen-lockfile
pnpm build
```

在 DSH「添加插件」里选择本地目录 `dsh-cursorlike`。
先停用原版 `dsh-better-sidebar`：本分支保留其内部服务和路由，二者不能同时启用。
安装或更新后需要重启 DSH，插件才会在原生右侧栏中挂载。
通过 DSH 原生右侧栏入口使用。

## 开发与来源

```powershell
pnpm typecheck
pnpm test:windows
pnpm pack
```

`reference/` 为研究源码，`.prototype/` 为早期原型，两者不进入安装包。
另参考 [dsh-diff-approval v0.35.0](https://github.com/9087/dsh-diff-approval) 的改动审查交互；其逐块保留/回退实现尚未合并，当前使用上游的 Git 差异视图。
构建和自动化测试不能替代真实 DSH 桌面端的安装、拖放验证。
