# 验证、环境与发布问题

更新：2026-10-18。入口：[分类索引](requirements-zh.md)。

## 本轮验证

- [x] 后悔机制：新增持久化撤销/重做、恢复删除、批次回放、冲突重试与草稿保护；相关回归累计 246 项通过（18 文件）、8 项跳过，见[后悔机制](requirements-undo-recovery-zh.md)。
- [x] 此轮最终类型检查、声明生成、本轮源文件与测试 ESLint 通过；tsdown 独立目录构建通过并原子更新 lib。

- [x] 已运行新增文件搬运与网格/多列交互测试，以及相关既有回归；首组 9 个测试文件、81 项通过；扩展覆盖 23 个文件，修正标签测试的 center 合并预期后，最终相关回归合计 193 项通过。新增/修改的 4 个测试文件单独复跑 43 项全部通过。
- [x] 新增剪切/粘贴文案写入 zh/en 与 19 份扩展词典，locale 一致性回归通过。
- [x] 本轮修改的文件单独 ESLint 已通过；全源码 lint 的外部变化见下方。
- [x] 最终 `tsc --noEmit` 与声明生成通过；本轮源文件和新增/修改测试的 ESLint 通过。
- [x] tsdown 插件打包通过；此前 pack 测试清理的 lib 已重新生成。
- [ ] 全量测试全部通过；真实宿主验收尚未执行。
- [ ] 真实 DSH mount/browser 验收，覆盖三种视图、菜单边缘定位、系统文件拖入、内部移动/复制、上传取消和跨窗口状态。
- [ ] Linux/macOS/Windows 的复制、符号链接与跨设备失败提示验证。

## 已观察到的问题，不能混同为本轮功能通过

- [ ] 全量单测运行结果：230 个测试文件中 217 通过、9 失败、4 跳过；2738 项中 2691 通过、17 失败、30 跳过。这次运行与共享工作区其他编辑交叠，不视为稳定提交的基线。
- [ ] Windows 上部分测试直接创建符号链接触发 EPERM：`fs-operations`、`fs-mkdir`、`archive-tools`、`file-stream-route` 等；需要权限或平台分支，不能简单删断言。
- [ ] `fs-operations` 的并发上传用例失败，需单独复测以区分实现竞争与平台文件锁影响。
- [ ] `smoke` 图片响应测试遇到 `fetch failed / bad port`，需固定安全端口或改进临时端口分配。
- [ ] `plugin-meta`、`market-manifest` 的 pnpm pack 测试失败；它们触发 prepack 构建并会清理 lib，不能与其他构建同时运行。
- [ ] `service.spec.ts` 观察到服务版本 `0.28.0-cursorlike.1` 与当时 package.json 的 `.2` 不一致；本轮结束前其他工作将 package.json 更新为 `.3`，此项仍需对应统一后复测。
- [ ] 共享工作区其他改动：`diff/review-model`、`TextEditor` 与其测试在本轮执行过程中持续变化；先后出现 review 测试类型错误、未加入词典的 review 文案、undoCount 未定义及不规则空白。随后最终 `tsc --noEmit` 和声明生成已通过，上述中间态错误未再阻止本轮检查；review 的功能验收仍由对应工作完成，不覆盖其实现。
- [ ] pnpm 自动依赖检查会尝试写沙箱外缓存并创建链接；本轮改用现有 `.bin` 工具运行，Vite 缓存写入需要环境授权。

## 发布

- [ ] 构建产物与源码同步，核对包内入口、惰性 chunk、声明和 locale。
- [ ] 安装包在干净 profile 中加载，禁用/重载不遗留监听、覆盖或重复标签。
- [ ] 发布前检查 npm 登录/目标版本/变更日志/安装说明；本轮不执行发布。

## 手动操作验收顺序

1. 每种视图：普通点击、Ctrl 多选、Shift 范围、右键选区内外、空白右键、键盘菜单。
2. 新建、F2、Delete 取消/确认、打开文件后的路径跟随、错误输入与权限失败。
3. 文件/文件夹复制、同目录副本、剪切粘贴、重名移动拒绝、自身子树拒绝、会话切换。
4. 拖到目录、面包屑、列头、空白区、聊天、忽略入口；外部文件夹上传与取消。
5. 刷新、排序、隐藏/重新显示页签、窗口聚焦、重启偏好恢复。
6. 标签拖动排序/分屏、中键释放取消、拖非标签不显示标签拖动区域。

完成某项后只在对应类别文档打勾，不用一句“整体完成”覆盖尚未验证的条目。

## 本轮 Windows 产物占用处理

- [x] 上述统一审阅版本已在 `.test-data/review-polish-build` 构建，7 个 JS 产物已原子安装并逐个比对；更新后的测试包核对双客户端入口、工具栏与重新审阅标记，SHA256 已同步。

- [x] 审阅完成态与默认单栏：7 个相关测试文件、113 项通过。Chrome 复验浅色/深色 × 单栏/换行分栏/普通分栏，确认同意后普通底色、Ctrl+Z 恢复、无文字重叠；480px 工具栏不越界。使用宿主实际 Diff CSS 的本地复现页面，真实宿主运行仍单独验收。

- [x] 连续块审阅、防止文字/按钮重叠与快捷键提示：6 个测试文件、82 项通过，声明生成与 ESLint 通过。Chrome 使用宿主实际 Diff CSS，检查统一/换行分栏/普通分栏的长文本区域与操作列不相交；测试包与 SHA256 已更新。

- [x] 本轮当前/批量同意按钮、父目录拖放、`.ignore` 自动创建：7 个相关文件、75 项回归通过，声明生成与 ESLint 通过；Chrome 检查按钮布局与交互。7 个构建产物已安装并校验，本地测试包与 SHA256 校验文件已更新。

- [x] 官方“第 N 轮改动”审阅页补修：7 个相关测试文件、137 项通过，声明生成与 ESLint 通过。本地 Chrome 使用官方公开 DOM 结构复现统一对比，验证 4 条改动行的按钮显示/点击、下一处状态和绿字/红字计算颜色；这项浏览器复现不代替运行中的宿主实测。
- [x] 本次官方逐行审阅产物在 `.test-data/native-line-build` 构建，已原子安装到 `lib`，7 个 JavaScript 产物哈希逐一匹配。

- [x] Markdown 引用、Diff 审阅/跳转/恢复、新建与撤销删除修复：13 个相关测试文件、215 项通过。TypeScript 声明生成与本轮 ESLint 通过。
- [x] 本轮产物在 `.test-data/reference-fixes-build` 打包，source map 路径重定位后原子安装到 `lib`，7 个 JavaScript 文件与构建结果逐一哈希一致。旧产物保留于 `.test-data/reference-installed-previous-*`。

- [x] 原地 tsdown 曾遇到 editor/mermaid chunk 被映射使用（Windows 1224）。改在 `.test-data/undo-build` 完整构建，重定位 source map 后用 File.Replace 原子安装到 lib，旧产物保留于忽略目录；7 个 JavaScript 产物逐一哈希核对通过。未结束占用文件的进程。

## 2026-10-19 门禁复查

- [x] 核对并验证现有修复：ESLint 排除 `.test-data/` 与 `release/`；全仓 `eslint .` 完成且无报错。
- [x] 核对并验证 FileGrid 无会话提示及 EditorHost 的 grid API mock；编辑器宿主测试通过。
- [x] 归档工具同步启动失败时正确尝试备用工具：新增测试先复现 `Cannot access 'timer' before initialization`，修复后通过；临时目录改为带重试的异步清理，避免 Windows 句柄占用导致探测无法结束。
- [x] `fs-mkdir` 的符号链接测试使用共享 `lstat` 能力探针；本机无法创建链接时明确跳过。
- [x] CSS Modules 导出键排序，避免哈希表遍历顺序污染构建差异；两次隔离构建的全部 7 个 JavaScript 产物 SHA256 一致。
- [x] `tsc --noEmit` 通过；归档、mkdir、编辑器宿主定向回归共 44 通过、1 跳过。
- [ ] 在支持符号链接的环境执行被跳过的用例；本机跳过不代表对应功能已验收。
- [x] 串行主测试（排除两份打包 spec）运行 310.89 秒：237 文件通过、2 文件跳过、1 文件失败；2850 项通过、21 项跳过、1 项失败。唯一失败是进程启动时已收集的旧 `fs-mkdir` 无守卫链接用例；补守卫后的定向复验见上，未再次运行完整主套件，因此不将此记录写成“全量全绿”。本轮未复现 Git/e2e 并发超时。
- [x] 两份打包 spec 单独运行：2 文件、12 项通过。使用当前已有 pnpm，本次测试进程设置 `npm_config_ignore_scripts=true`，验证包内容与市场清单而不触发 prepack 清空 `lib`；声明生成和隔离构建另行通过，不替代发布生命周期验收。
- [ ] 在干净环境验证完整发布生命周期及宿主安装。本轮未发布、未替换安装包；保留用户已有 `lib` 改动与未跟踪文件，未执行全局 corepack 配置。

## 2026-10-19 npm 发布准备

- [x] `@deepseek-ai/schemastery` 从 dependencies 移至 peerDependencies（`~3.18.5`），开发依赖固定为 `3.18.5`，同步 pnpm 锁文件；官方运行时包不再作为直接 dependencies 发布。
- [x] 类型检查、声明生成和隔离构建通过；市场/包元数据测试 13 项通过，配置偏好测试 18 项通过。
- [x] 生成 `.test-data/npm-ready/dsh-cursorlike-sidebar-0.28.0-cursorlike.4-beta.1.tgz`；511 文件、4,961,370 字节；包内 7 个 JS 入口/chunk、声明及 bundle patch 与本地逐字节一致，清单无安装生命周期脚本。
- [x] 待发布包 SHA256：`f4c0c01cf473ee0a27ac62c1e724012568476c392122bd57dfeeefa481a95455`。
- [x] 查询 GitHub Release：仅有旧版 `v0.28.0-cursorlike.1` 附件，投稿不填当前版本不存在的 tarball URL。
- [x] npm 账号所有者完成官方网页登录，`npm whoami` 确认为 `anyon12138`；未接触密码、token 或验证码。
- [ ] npm 发布认证：实际 publish 返回 E403，registry 要求双重认证或有发布权限且允许绕过 2FA 的 granular token。登录成功不代表已满足发布认证；需要账号所有者在 npm 安全设置中完成配置。发布尚未成功，registry 查询仍为 404。
- [ ] 登录后发布预构建包：`npm publish .test-data/npm-ready/dsh-cursorlike-sidebar-0.28.0-cursorlike.4-beta.1.tgz --access public --tag beta --ignore-scripts --registry=https://registry.npmjs.org`；发布后核对 registry 版本、beta 标签及 dist integrity。当前未发布。
