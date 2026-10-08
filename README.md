# 栖页 · Lattira

画布式的个人知识库与文件管理工具：文本、文件和图片都是画布上的卡片，画布按项目归档，也能在日历中按编辑日期回溯。仅支持 Windows 桌面端。

产品设计文档：<https://claude.ai/code/artifact/5fb90891-2d57-4dd8-94c5-16a0d58158a9>

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面外壳 | Tauri 2（WebView2） |
| 界面 | React 19 + TypeScript + Vite，状态管理用 zustand |
| 画布引擎 | 自研，基于 DOM + CSS transform，连线用 SVG |
| 本地服务 | Rust：SQLite（rusqlite）、SHA-256 去重 |
| 画布文件格式 | 兼容 [JSON Canvas](https://jsoncanvas.org)，扩展字段放在 `lattira` 下 |

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
│  ├─ 收件箱/
│  └─ 竞品分析/竞品对比.canvas
└─ assets/2026-10/行业报告.pdf   导入时复制进来，内容相同的文件只存一份
```

## MVP 进度

已完成：

- [x] 工作区选择与初始化、欢迎画布
- [x] 无限画布：平移、缩放、框选、多选拖动、缩放卡片、撤销/重做
- [x] 文本卡片、图片卡片、文件卡片、分组框、连线、卡片颜色
- [x] 拖入 / 粘贴 / 选择文件导入，复制进工作区并按内容去重
- [x] 项目与收件箱：新建、重命名、归档；画布改名、移动、删除
- [x] 自动保存，记录每次保存的变化量
- [x] 日历月视图：画布出现在它被编辑过的每一天
- [x] 资源库：按类型筛选、引用计数、空间统计
- [x] 全局搜索（Ctrl+K）：画布名、卡片文字、文件名，点击跳到对应卡片

待完成：

- [ ] 画布导出 PNG
- [ ] 画布缩略图（项目页、日历）
- [ ] 文本卡片 Markdown 渲染
- [ ] 小地图
- [ ] 大画布性能：视口外元素裁剪，并用 1000 张卡片做性能验证
