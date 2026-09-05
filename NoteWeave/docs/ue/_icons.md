# 线框图图标片段库（lucide 内联 SVG）

> 用法：直接复制 SVG 代码到 HTML 中替换 emoji。`class="ic"` 为基础尺寸（16px），可加 `ic-sm`（13px）/ `ic-lg`（20px）。
> 颜色跟随 `currentColor`，无需改 fill。尺寸/颜色微调可加内联 `style`。
> 所有 SVG 均为 `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`，由 CSS `.ic` 统一兜底。

## emoji → 图标对照

| emoji | 含义 | 片段名 |
|-------|------|--------|
| 🧶 | 应用 logo | 用 `.logo` 块（绿色圆角方块 + 「织」字），不用 SVG |
| 🏠 | 工作台 | home |
| 📚 | 知识库 | library |
| 📗📘📙 | 库封面 | book（配 `.doc-ic g/b/a` 色变体） |
| 🔍 | 搜索 | search |
| 🗂 | 资源 | images |
| 🗑 | 回收站 | trash |
| 🌗 | 主题 | sun-moon |
| ⚙ | 设置 | settings |
| 📝 | 小记/编辑 | pen-line |
| 📄📃 | 文档 | file-text |
| 📁📂 | 文件夹 | folder |
| 🕘 | 最近/历史 | history |
| 💬 | 评论/讨论 | message-square |
| 🔗⛓ | 关联 | link |
| 🖼 | 图片/资源 | image |
| ☑ | 勾选框（已选） | square-check |
| ☐ | 勾选框（未选） | square |
| 🔒 | 锁定 | lock |
| ↩ | 回复/撤销 | undo 或 corner-up-left |
| ↶↷ | 撤销/重做 | undo / redo |
| ✨🧠 | AI | sparkles |
| ✏✎ | 编辑 | pencil |
| ▶▸ | 播放/展开 | play / chevron-right |
| ◀ | 上一帧 | chevron-left |
| ▾ | 下拉 | chevron-down |
| 🌐 | 公开/网络 | globe |
| 🔤 | 文本/格式 | type |
| 🤖 | AI 模型 | bot |
| 💾 | 保存 | save |
| 📊 | 图表 | bar-chart |
| 🧩 | 插件/组件 | puzzle |
| ⏱ | 计时器 | timer |
| ⛶▭ | 框架/全屏 | frame / maximize |
| ⚡ | 快捷 | zap |
| 📅 | 日期 | calendar |
| ⬇⇩ | 导出/下载 | download |
| ⇪ | 导入/上传 | upload |
| ⚠ | 警告 | alert |
| ❌ | 错误 | x-circle |
| ✕ | 关闭 | x |
| 🧹 | 清理 | brush（或 trash） |
| 📎 | 附件 | paperclip |
| 🔴 | 记录/录制点 | 用 CSS 圆点 |
| 📌 | 固定 | pin |
| ☆ | 收藏 | star |
| ▤ | 列表/密度 | list |
| ○●◉ | 单选 | CSS 圆点或 circle SVG |
| ✅🟡📐 | 状态徽标 | **保留 emoji**（文档徽标，不替换） |
| 👋 | 问候语 | **保留 emoji**（示例内容） |
| 🟡🟦 | 白板便签内容色 | **保留**（内容数据） |

## SVG 片段

home
```html
<svg class="ic" viewBox="0 0 24 24"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>
```

library
```html
<svg class="ic" viewBox="0 0 24 24"><path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/></svg>
```

search
```html
<svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
```

images
```html
<svg class="ic" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
```

trash
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
```

settings
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
```

sun-moon
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/></svg>
```

pen-line
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/></svg>
```

file-text
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>
```

folder
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
```

history
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>
```

message-square
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
```

link
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
```

image
```html
<svg class="ic" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
```

square-check
```html
<svg class="ic" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/></svg>
```

square
```html
<svg class="ic" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>
```

lock
```html
<svg class="ic" viewBox="0 0 24 24"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
```

undo
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/></svg>
```

redo
```html
<svg class="ic" viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13"/></svg>
```

corner-up-left（回复）
```html
<svg class="ic" viewBox="0 0 24 24"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>
```

sparkles
```html
<svg class="ic" viewBox="0 0 24 24"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275Z"/></svg>
```

pencil
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>
```

play
```html
<svg class="ic" viewBox="0 0 24 24"><polygon points="6 3 20 12 6 21 6 3"/></svg>
```

chevron-down
```html
<svg class="ic" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
```

chevron-right
```html
<svg class="ic" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
```

chevron-left
```html
<svg class="ic" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>
```

globe
```html
<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
```

type
```html
<svg class="ic" viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/></svg>
```

bot
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>
```

save
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>
```

bar-chart
```html
<svg class="ic" viewBox="0 0 24 24"><line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/></svg>
```

puzzle
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 0 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 0-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/></svg>
```

timer
```html
<svg class="ic" viewBox="0 0 24 24"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>
```

frame
```html
<svg class="ic" viewBox="0 0 24 24"><line x1="22" x2="2" y1="6" y2="6"/><line x1="22" x2="2" y1="18" y2="18"/><line x1="6" x2="6" y1="2" y2="22"/><line x1="18" x2="18" y1="2" y2="22"/></svg>
```

maximize
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
```

zap
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>
```

calendar
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>
```

download
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
```

upload
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
```

alert
```html
<svg class="ic" viewBox="0 0 24 24"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
```

x-circle
```html
<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>
```

x
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
```

paperclip
```html
<svg class="ic" viewBox="0 0 24 24"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
```

pin
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
```

star
```html
<svg class="ic" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
```

list
```html
<svg class="ic" viewBox="0 0 24 24"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg>
```

layout-grid
```html
<svg class="ic" viewBox="0 0 24 24"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>
```

book
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/></svg>
```

tag
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/></svg>
```

plus
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
```

check
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
```

more-horizontal
```html
<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/><circle cx="5" cy="12" r="1" fill="currentColor"/></svg>
```

arrow-left
```html
<svg class="ic" viewBox="0 0 24 24"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
```

sticky-note（白板便签标签）
```html
<svg class="ic" viewBox="0 0 24 24"><path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v6h6"/></svg>
```

## 补充规则

- 单选 ○●◉：选中用 `<span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:4px solid var(--wf-primary);vertical-align:-2px"></span>`，未选中把 border 改为 `2px solid var(--wf-border-strong)`。
- 状态圆点 🔴⚪：`<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--wf-danger)"></span>`（绿 `#31b97f` / 灰 `#cbd5e1` 同理）。
- 品牌 logo：`<div class="logo">织</div>`（仅 navrail 顶部）。
- 单选/复选控件统一 14~16px，颜色跟随上下文 `currentColor`。
