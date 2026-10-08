# 栖页 · Lattira

By z00613494

画布式的个人知识库与文件管理工具：文本、文件和图片都是画布上的卡片，画布按项目归档，也能在日历中按编辑日期回溯。仅支持 Windows 桌面端。

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

- Node.js 20+
- Rust（stable，MSVC 工具链）
- Visual Studio 生成工具（勾选「使用 C++ 的桌面开发」）
- WebView2 运行时（Windows 11 自带）

```bash
npm install
npm run tauri dev     # 启动桌面端（会自动启动 Vite）
npm run dev           # 只在浏览器里调界面，数据存在 localStorage
npm run typecheck     # 前端类型检查
npm run i18n:check    # 检查英文翻译是否齐全
npm run build && npx vite preview --port 5480   # 生产构建，浏览器打开 http://localhost:5480/?perf 可做性能测试
cd src-tauri && cargo test   # 后端单元测试
npm run tauri build   # 打包 NSIS 安装程序
```

## 目录结构

```text
src/
├─ types/model.ts          数据模型（与 Rust 端字段一一对应）
├─ lib/                    几何计算、日期、JSON Canvas 读写、UUID v7
├─ services/
│  ├─ backend.ts           前端访问存储层的唯一接口
│  ├─ tauriBackend.ts      桌面端实现：调用 Rust 命令
│  └─ browserBackend.ts    浏览器预览实现：localStorage
├─ store/
│  ├─ appStore.ts          工作区、项目、画布列表、导航
│  └─ canvasStore.ts       当前画布：编辑、撤销/重做、自动保存、变化统计
└─ features/               canvas / calendar / project / assets / search / layout / workspace

src-tauri/src/
├─ commands.rs             全部前端命令：项目、画布、资源导入、日历、搜索
├─ ocr.rs                  图片文字识别（后台线程，结果用于搜索）
├─ workspace.rs            工作区的打开与初始化、应用设置
├─ db.rs                   SQLite 表结构与迁移
└─ files.rs                文件名清理、去重命名、原子写入
```

## 工作区在磁盘上的样子

```text
我的工作区/
├─ .lattira/
│  ├─ lattira.db           元数据、搜索索引、编辑记录（日历数据）
│  └─ trash/               删除的画布
├─ projects/
│  ├─ 未分类/
│  └─ 竞品分析/竞品对比.canvas
└─ assets/2026-10/行业报告.pdf   导入时复制进来，内容相同的文件只存一份
```

## MVP 进度

已完成：

- [x] 工作区选择与初始化、欢迎画布
- [x] 无限画布：平移、缩放、框选、多选拖动、缩放卡片、撤销/重做、小地图
- [x] 文本卡片、图片卡片、文件卡片、文件夹（画布上带标题的框，拖动时带着里面的卡片）、连线、卡片颜色；双击文件卡片用默认程序打开
- [x] 拖入 / 粘贴 / 选择文件导入，复制进工作区并按内容去重
- [x] 最近（按编辑时间倒序）、未分类、项目：新建、重命名、归档
- [x] 画布改名、删除；把画布卡片（或画布顶栏的拖动手柄）拖到侧栏项目上即可移动
- [x] 画布缩略图（项目页、最近页）
- [x] 自动保存，记录每次保存的变化量
- [x] 日历月视图：画布出现在它被编辑过的每一天
- [x] 资源库：按类型筛选、引用计数、空间统计
- [x] 全局搜索（Ctrl+E）：画布名、卡片文字、文件名、图片中的文字（OCR），点击跳到对应卡片
- [x] 画布内查找（Ctrl+F）：当前画布中的卡片文字、文件夹名、文件名和图片中的文字，Enter / Shift+Enter 在结果间跳转
- [x] 大画布性能：视口外元素不渲染、平移不经过 React、缩小时简化绘制
- [x] 复制粘贴卡片（Ctrl+C / Ctrl+V）：文件与图片以文件形式复制，可直接粘贴到微信、资源管理器；文本卡片复制为文字；粘贴回画布时保留布局与连线
- [x] 右键菜单：卡片（打开、在资源管理器中显示、复制图片 / 文字 / 路径、另存为、对齐、分布、颜色、叠放次序、创建副本）、画布空白处、连线、画布卡片、项目、资源
- [x] 文本卡片双击打开大窗口编辑
- [x] 按类型显示文件图标（来自 vscode-icons，MIT）
- [x] 未选中卡片时，检查器列出画布中的全部文件
- [x] 资源库列表视图（类似资源管理器「详细信息」，可按列排序）
- [x] 资源库：独立搜索框（文件名与图片中的文字，Ctrl+E / Ctrl+F 聚焦）、多选（Ctrl / Shift + 单击、Ctrl+A）删除
- [x] 项目图标与颜色：28 种图标、16 种预设颜色和自定义取色
- [x] 文件夹：工具栏一个按钮即可新建空文件夹、把选中的卡片放进文件夹（Ctrl+G），或从电脑导入；导入时文件按网格紧凑排列（列数让宽高比接近 2:1），子文件夹成为嵌套文件夹
- [x] 重命名文件（磁盘上的文件一起改名）
- [x] 中英文界面切换、关于界面（版本、工作区信息、更新内容）

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

- [ ] 回收站界面（删除的画布已保存在 `.lattira/trash/`）
- [ ] 文件卡片的内置预览（PDF 等）
- [ ] 大画布：越过预渲染区域时分批挂载
