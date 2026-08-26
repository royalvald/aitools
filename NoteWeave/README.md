# 织记（NoteWeave）

一款 Windows 桌面笔记与知识库应用，支持便签与 Markdown 知识文档的双向关联。

## 功能特性

- 小记（Note）列表 + 分组管理，点击列表项进入详情，阅读优先、一键进入编辑
- 多知识库（KB），每库多篇 Markdown 文档，支持层级/子文档与文档树
- 小记与知识库文档双向关联；文档支持批注、评论、版本历史、反链、收藏、标签
- 编辑器支持富文本（Milkdown 所见即所得）与 Markdown 源码两档，含公式、Mermaid/PlantUML/Graphviz 图表
- 思维导图文档类型；待办（Todo）模块与工作台聚合视图
- 白板（无限画布）以仅浏览模式展示画布内容，支持平移/缩放、内容卡片跳转、框架演示与导出
- 全文搜索、命令面板、模板、主题、回收站、本地 HTTP API、Ollama 本地 AI 等
- 自动保存（500ms 防抖），本地 JSON / Markdown 文件持久化，数据与程序同目录

## 技术栈

- Electron 35.x
- React 19.x + TypeScript
- Vite 6.x + electron-vite
- Tailwind CSS 4.x
- @uiw/react-md-editor（Markdown 编辑器）
- Milkdown（所见即所得编辑器）
- react-markdown + remark-gfm（Markdown 渲染）

## 文档

- [技术设计文档](docs/DESIGN.md) — 架构、数据模型、组件设计、构建打包
- [UE 设计文档](docs/UE_DESIGN.md) — 信息架构、页面线框图、用户流程、交互规范（低保真原型见 `docs/ue/`）
- [用户使用手册](docs/USER_GUIDE.md) — 安装、小记/知识库/白板使用、Markdown 语法、备份迁移
- [IPC API 文档](docs/IPC_API.md) — 主进程与渲染进程通信接口

## 开发命令

```bash
# 安装依赖
npm install

# 开发模式（热更新）
npm run dev

# 构建生产版本
npm run build

# 打包 Windows 安装包与便携版
npm run package:win
```

## 数据存储位置

应用数据与程序同目录存放，便于备份、迁移和绿色化使用：

- **打包版（安装版 / 便携版）**：数据保存在可执行文件（`NoteWeave.exe`）所在目录下的 `data\` 子文件夹：

  ```
  <安装目录>\
  ├── NoteWeave.exe
  └── data\
      ├── notes\              # 小记（每条一个 {id}.json）
      └── knowledge-bases\    # 知识库及其文档、白板
  ```

- **开发模式（`npm run dev`）**：数据保存在项目根目录下的 `dev-data\`，避免污染系统目录；该目录已被 `.gitignore` 忽略。

## 项目结构

```
src/
├── main/          # Electron 主进程
├── preload/       # 预加载脚本（IPC 桥接）
└── renderer/      # React 渲染进程
```

## 打包产物

执行 `npm run package:win` 后，`dist/` 目录下会生成：

- `NoteWeave Setup 1.0.0.exe` — Windows 安装程序
- `NoteWeave-1.0.0-portable.exe` — 绿色便携版
- `win-unpacked/` — 解压后的文件

## 注意事项

- 首次安装依赖时若遇到 `spawn /bin/bash ENOENT` 错误，可尝试设置 npm 脚本解释器：
  ```bash
  npm config set script-shell bash
  ```
- 打包时若下载 Electron 超时，可配置国内镜像：
  ```bash
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run package:win
  ```
