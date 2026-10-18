# CursorLike Sidebar 分类需求索引

更新：2026-10-18。核对来源为当前代码、现有测试及本轮新增回归。

## 本轮范围

- 保留现有树形、图标网格和 Miller 多列的展示方式与默认布局。
- 优先补齐左键、右键、多选、键盘、文件搬运和拖放等日常操作。
- Tab AI 补全、完整语言服务、调试器、内联 AI 改写不进入本轮基础操作范围。
- 不再把新增列表/详细信息视图列为 P0；用户已经明确满意现有展示方式。
- `[x]` 表示对应能力已有实现和回归依据；`[ ]` 表示未完成、覆盖不全或仍待实际环境验收，不能因代码里出现相关函数就打勾。

## 按类型维护

- [撤销、恢复、重做与动作反馈](requirements-undo-recovery-zh.md)

- [文件浏览：选择、鼠标、右键、快捷键、文件操作、拖放](requirements-file-browser-zh.md)
- [编辑器：保存、查找替换、快速打开、差异处理](requirements-editor-zh.md)
- [Diff：逐行审阅、跳转与重启恢复](requirements-diff-zh.md)
- [标签与布局：点击、关闭、排序、分屏、焦点](requirements-tabs-layout-zh.md)
- [聊天引用与忽略规则](requirements-chat-ignore-zh.md)
- [终端与 Git 基础操作](requirements-terminal-git-zh.md)
- [质量、环境、构建与发布验证](requirements-quality-release-zh.md)

## 本轮已解决

- [x] Markdown 预览引用修复，右下角显示「Ctrl+L 添加到对话」，见[聊天引用](requirements-chat-ignore-zh.md)。
- [x] Diff 补齐逐行审阅、跳转与重启恢复，见[Diff 专项](requirements-diff-zh.md)中的适用范围和剩余项。
- [x] 新建文件、撤销删除不再自动打开编辑器。

- [x] 文件移动/重命名/复制/新建/删除支持持久化撤销与重做，批量操作可合成一步，见[后悔机制](requirements-undo-recovery-zh.md)。

- [x] 网格/多列共享选择、基础右键菜单、新建、重命名、删除与上传逻辑。
- [x] 工具栏刷新和排序传到网格/多列，多列增加独立刷新入口。
- [x] 三种视图接通文件复制、剪切、粘贴及内部拖动移动/复制。
- [x] 新增 Host `fs.transfer`，复制重名保留两者，移动重名拒绝。
- [x] 文件区快捷键不截获文本输入框，删除仍先确认，文件移动/重命名继续通知标签页重定向。
- [x] 标签条和分屏区域只接收标签拖动，不再把其他拖动显示成标签分屏。
- [x] 完成项和未完成项分开记录，旧需求中的混合验收项拆到各分类文档。

## 仍需补齐的高频操作

- [ ] 三视图的“打开方式”、系统文件管理器定位、打包下载完全对齐。
- [ ] 拖动目标高亮、悬停展开、边缘自动滚动、批量结果汇总。
- [ ] 工作区级视图/排序记忆，以及网格/多列的目录实时监听。
- [ ] 真实 DSH 浏览器验收与最终全量测试通过。

历史讨论已保存在 [原总需求](requirements-zh-history-2026-10-18.md) 与 [原文件浏览规格](requirements-file-browser-zh-history-2026-10-18.md)，其中未确认的问题和四视图方案不再作为当前执行范围。

## 对照依据

Cursor 官方把 VS Code 键位作为基础，并支持拖文件到聊天作为上下文。本轮借鉴的是这些基础操作习惯；没有要求复制完整 IDE。

- [Cursor 快捷键](https://docs.cursor.com/advanced/keyboard-shortcuts)
- [Cursor 文件与文件夹引用](https://docs.cursor.com/context/%40-symbols/%40-files-and-folders)
- [VS Code Explorer 基础文件操作](https://code.visualstudio.com/docs/editing/getting-started/userinterface)
