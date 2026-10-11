# 栖页开发说明

面向开发者：技术栈、本地开发、代码结构、发布流程与性能数据。产品介绍见 [README](../README.md)。

产品设计文档：<https://claude.ai/code/artifact/5fb90891-2d57-4dd8-94c5-16a0d58158a9>

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面外壳 | Tauri 2（WebView2） |
| 界面 | React 19 + TypeScript + Vite，状态管理用 zustand |
| 画布引擎 | 自研，基于 DOM + CSS transform，连线用 SVG |
| 本地服务 | Rust：SQLite（rusqlite）、SHA-256 去重、Windows 自带 OCR（Windows.Media.Ocr） |
| 画布文件格式 | 兼容 [JSON Canvas](https://jsoncanvas.org)，扩展字段放在 `lattira` 下 |
| 字体 | 内置 [Maple Mono NF CN](https://github.com/subframe7536/maple-font)（OFL-1.1，Regular / SemiBold，WOFF2） |

## 开发环境

- Node.js 22.13+（推荐 24 LTS；回归测试使用内置 TypeScript 类型剥离）
- Rust（stable，MSVC 工具链）
- Visual Studio 生成工具（勾选「使用 C++ 的桌面开发」）
- WebView2 运行时（Windows 11 自带）

```bash
npm install
npm run tauri dev     # 启动桌面端（会自动启动 Vite）
npm run dev           # 只在浏览器里调界面：元数据在 localStorage，文件在 IndexedDB
npm test              # 保存、命名、格式兼容、资源完整路径与浏览器存储回归测试
npm run typecheck     # 前端类型检查
npm run i18n:check    # 检查英文翻译是否齐全
npm run build && npx vite preview --port 5480   # 生产构建，浏览器打开 http://localhost:5480/?perf 可做性能测试
cd src-tauri && cargo test   # 后端单元测试
npm run tauri build   # 打包 NSIS 安装程序
```

本地调试桌面端时注意：

- 开发者工具：窗口里按 `Ctrl+Shift+I`（应用屏蔽了网页自带的右键菜单）
- 调试版与安装版共用应用设置，会打开上次用的工作区，也就是真实数据；需要时在「设置 → 工作区」切到一个测试文件夹
- 应用是单实例的：安装版（0.4.0 起）在托盘中运行时，启动调试版只会调出安装版的窗口，先从托盘退出安装版
- 托盘、全局快捷键、窗口主题、在线更新只在桌面端可用，`npm run dev` 的浏览器预览里测不到

## 目录结构

```text
src/
├─ types/model.ts          数据模型（与 Rust 端字段一一对应）
├─ lib/                    几何计算、日期、JSON Canvas 读写、UUID v7
├─ services/
│  ├─ backend.ts           前端访问存储层的唯一接口
│  ├─ tauriBackend.ts      桌面端实现：调用 Rust 命令
│  ├─ browserBackend.ts    浏览器预览实现：localStorage + IndexedDB
│  ├─ desktop.ts           托盘、全局快捷键、窗口主题（仅桌面端）
│  └─ updater.ts           在线更新
├─ store/
│  ├─ appStore.ts          工作区、项目、画布列表、导航、标签页
│  ├─ canvasStore.ts       当前画布：编辑、撤销/重做、自动保存、变化统计；后台标签页的画布缓存
│  └─ settingsStore.ts     设置：主题、快捷键、关闭窗口时的行为、侧栏宽度
└─ features/               canvas / calendar / project / assets / search / trash / settings / layout / workspace

src-tauri/src/
├─ commands.rs             前端命令：项目、画布、资源导入、日历、搜索
├─ trash.rs                回收站：列出、恢复、永久删除
├─ desktop.rs              托盘、关闭时最小化到托盘、呼出主界面的全局快捷键
├─ transfer.rs             画布导出为画布包（.zip）与导入（画布包或 .canvas）
├─ journal.rs              文件修改撤销日志与 SQLite 提交标记，启动时恢复中断的事务
├─ thumbnails.rs           Windows 图像解码器生成 512 像素缩略图并缓存
├─ ocr.rs                  图片文字识别（后台线程，结果用于搜索）
├─ shellnew.rs             读取 Windows 右键菜单「新建」的文件类型与模板（注册表 ShellNew）
├─ workspace.rs            工作区的打开与初始化、应用设置
├─ db.rs                   SQLite 表结构与迁移
└─ files.rs                文件名清理、去重命名、原子写入
```

## 工作区在磁盘上的样子

```text
我的工作区/
├─ .lattira/
│  ├─ lattira.db           元数据、搜索索引、编辑记录（日历数据）
│  ├─ trash/               回收站：删除的画布（<id>.canvas）与文件（assets/）
│  ├─ transactions/        未完成操作的持久化撤销日志（打开工作区时自动恢复）
│  ├─ thumbnails/          按内容指纹缓存的缩略图，可重新生成
│  └─ links/               网页预览图与图标，画布包会一并携带
├─ projects/
│  ├─ 未分类/
│  └─ 竞品分析/竞品对比.canvas
└─ assets/2026-10/行业报告.pdf   导入时复制进来，内容相同的文件只存一份
```

## 发布

在线更新从 GitHub Release 的 `latest.json` 读取新版本（地址见 `src-tauri/tauri.conf.json` 的 `plugins.updater`），
安装包必须用更新签名私钥签名，否则客户端会拒绝安装。私钥在 `%USERPROFILE%\.tauri\lattira.key`，**不要提交到仓库，并备份好**：
丢失后已安装的客户端将无法再在线更新（只能重新生成密钥、更换 `pubkey`，再让用户手动安装一次）。

```powershell
# 1. 改版本号：package.json、src-tauri/Cargo.toml、src-tauri/tauri.conf.json
# 2. 带私钥构建，会额外生成 .sig 签名文件
$env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauri\lattira.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm run tauri build
# 3. 生成 latest.json（可选：附上更新说明文件，会显示在「关于」的更新提示里）
npm run release:manifest -- notes.md
# 4. 新建 Release vX.Y.Z，上传 src-tauri/target/release/bundle/nsis/ 下的安装包和 latest.json
```

客户端请求的是「最新 Release」里的 `latest.json`，所以每个版本都要上传它；早于 0.4.0 的版本没有在线更新，需要手动安装一次。

## 性能验证

测试方法：生产构建，浏览器窗口 1600×1000，在控制台运行 `await __lattiraPerf.runWork(n)`（见 `src/dev/perf.ts`）。
画布为网格排列的文本卡片，每 4 张一条连线，每 50 张一个文件夹。指标为每次平移的主线程耗时
（更新视口 → React 渲染 → 样式与布局），不含 GPU 合成；低于 16.7 ms 即可在一帧内完成。

| 卡片数 | 打开画布 | 100% 平移 p95 | 25% 平移 p95 | 10% 平移 p95 | 最慢一帧 |
| --- | --- | --- | --- | --- | --- |
| 1,000 | 24 ms | 0.7 ms | 1.6 ms | 2.0 ms | 36 ms |
| 5,000 | 158 ms | 0.6 ms | 2.7 ms | 7.3 ms | 119 ms |

最慢一帧出现在平移越过预渲染区域、需要挂载一批新卡片时，5,000 张卡片缩小到 10% 时会有可感知的卡顿，
后续可改为分批挂载。1,000 张卡片的主线程耗时在 60 fps 的帧预算内；实际帧率还要在桌面端用真实窗口复测（测试环境的浏览器窗格在后台时会限制刷新率，无法直接测 fps）。

## 待完成

（也列在 README 的「接下来」中）

- [ ] 文件卡片的内置预览（PDF 等）
- [ ] 大画布：越过预渲染区域时分批挂载

## 可靠性与兼容性

v0.8.0 的修复范围和验证记录见 [代码审视修复清单](REVIEW-FIXES-v0.8.0.md)。

资源库完整路径从引用画布的 JSON Canvas 内容计算，与画布视图共用解析和文件夹父级链规则。每张文件或图片卡片记录独立的元素 ID，点击路径按该 ID 定位到直接父文件夹；同一资源的不同位置分别列出。读取按画布去重，最多四个并发任务，离开页面或切换工作区后停止调度并丢弃过期结果。深层目录、旧版分组和取消读取的回归覆盖见 `scripts/regression.test.mjs`，v0.8.1 验证记录见 [发布说明](RELEASE-v0.8.1.md)。
保存失败会保留草稿并阻止切换画布、工作区或退出；界面提供重试，以及另存恢复副本后重新打开的操作。
磁盘画布被外部程序改过时不会直接覆盖，会留下 `.conflict.canvas` 副本以供合并。
删除画布时为引用的资源创建独立快照，回收站画布不受资源库改名、编辑或清理影响；恢复同内容文件仍保留原 ID。

工作区数据库升级到第 6 版，新增全文搜索索引、OCR 重试状态、回收站快照标记和导入预留记录。
首次打开旧工作区会为仍可读取的回收站资源创建快照；旧版本中已经丢失的文件无法凭空恢复。
网页预览和缩略图缓存可以重建，`transactions` 的恢复日志则在操作完成前承担文件回滚用途。
