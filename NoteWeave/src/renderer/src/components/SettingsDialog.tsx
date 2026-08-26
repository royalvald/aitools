import { useEffect, useState } from 'react'
import { Download, FileInput, FolderOpen, Info, Upload } from 'lucide-react'
import { Modal } from './Modal'
import { useSettings } from '../hooks/useSettings'
import type { ThemeSummary } from '../types'

// REQ-111/113/114/118 等：应用设置面板（开关项 + 主题选择 + 自定义主题入口）。

/** 与 package.json version 保持同步（渲染进程无法直接读取包信息）。 */
const APP_VERSION = '1.0.0'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  /** UE-18「数据」分区：导出全量 ZIP 备份 */
  onExport?: () => void
  /** UE-18「数据」分区：导入 ZIP 还原备份 */
  onImport?: () => void
  /** UE-18「数据」分区：导入外部文件（.docx/.html/.md/Notion ZIP） */
  onImportExternal?: () => void
}

export function SettingsDialog({ open, onClose, onExport, onImport, onImportExternal }: SettingsDialogProps) {
  const { settings, update } = useSettings()
  const [themes, setThemes] = useState<ThemeSummary[]>([])
  const [java, setJava] = useState<{ available: boolean; version?: string } | null>(null)
  const [graphviz, setGraphviz] = useState<{ available: boolean } | null>(null)
  // UE-18「数据」分区：数据目录路径展示
  const [dataDir, setDataDir] = useState('')
  // REQ-208 应用锁屏
  const [lockEnabled, setLockEnabled] = useState<boolean>(!!settings.appLock?.enabled)
  const [pwd, setPwd] = useState('')
  const [pwdConfirm, setPwdConfirm] = useState('')
  const [lockMsg, setLockMsg] = useState('')
  // REQ-205 图片 OCR
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrMsg, setOcrMsg] = useState('')

  useEffect(() => {
    if (!open) return
    window.electronAPI.listThemes().then(setThemes)
    // REQ-115：检测本地渲染后端可用性，给用户明确反馈
    window.electronAPI.checkJava().then(setJava)
    window.electronAPI.checkGraphviz().then(setGraphviz)
    // UE-18 数据分区：展示数据目录
    window.electronAPI.getDataDir().then(setDataDir).catch(() => {})
  }, [open])

  if (!open) return null

  const Toggle = ({
    label,
    desc,
    value,
    onChange
  }: {
    label: string
    desc?: string
    value: boolean
    onChange: (v: boolean) => void
  }) => (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <div>
        <div className="text-sm">{label}</div>
        {desc && <div className="text-xs text-[var(--color-muted-foreground)]">{desc}</div>}
      </div>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
      />
    </label>
  )

  return (
    <Modal title="设置" onClose={onClose}>
      <div className="space-y-4">
        <section>
          <div className="mb-1 text-sm font-medium">主题</div>
          <div className="flex flex-wrap gap-2">
            {themes.map((t) => (
              <button
                key={t.id}
                onClick={() => update({ theme: t.id })}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  settings.theme === t.id
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                    : 'border-[var(--color-border)] text-[var(--color-foreground)]'
                }`}
              >
                {t.name}
              </button>
            ))}
          </div>
          <div className="mt-1 text-xs text-[var(--color-muted-foreground)]">
            自定义主题 CSS 文件请放入应用数据目录 themes/ 文件夹（.json 格式，含 name/css 字段）。
          </div>
        </section>

        <section className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          <Toggle
            label="拼写检查"
            desc="编辑器启用系统拼写检查（主要对英文生效）"
            value={settings.enableSpellCheck}
            onChange={(v) => update({ enableSpellCheck: v })}
          />
          <Toggle
            label="自动配对"
            desc="输入括号/引号自动补全，选中文字后输入符号包裹"
            value={settings.enableAutoPair}
            onChange={(v) => update({ enableAutoPair: v })}
          />
          <Toggle
            label="Focus 模式"
            desc="淡化非当前段落，专注写作"
            value={settings.enableFocusMode}
            onChange={(v) => update({ enableFocusMode: v })}
          />
          <Toggle
            label="打字机模式"
            desc="当前编辑行保持在视口中部"
            value={settings.enableTypewriterMode}
            onChange={(v) => update({ enableTypewriterMode: v })}
          />
          <Toggle
            label="Markdown Lint"
            desc="检查标题层级、行尾空格等常见问题"
            value={settings.enableLint}
            onChange={(v) => update({ enableLint: v })}
          />
          <Toggle
            label="本地 PlantUML 服务"
            desc="需要系统已安装 Java；启用后可本地渲染 PlantUML 图"
            value={settings.enablePlantUMLServer}
            onChange={(v) => update({ enablePlantUMLServer: v })}
          />
          {/* REQ-115：本地渲染后端检测状态 */}
          <div className="py-1 pl-1 text-xs text-[var(--color-muted-foreground)]">
            <div>
              Graphviz（纯 WASM 本地）：{graphviz?.available ? '✅ 可用' : '⏳ 检测中…'}
            </div>
            <div>
              PlantUML：✅ 内置纯 JS 本地渲染器已启用（序列图/类图等常用子集，无需 Java/jar）
            </div>
            <div>
              Java（完整 PlantUML 后端，可选）：
              {java === null ? '⏳ 检测中…' : java.available ? `✅ 可用（${java.version ?? '未知版本'}）` : '— 未检测到（可选）'}
            </div>
            <div className="mt-1">
              内置渲染器覆盖序列图/类图等常用类型，无需任何外部配置即可本地渲染。如需完整 PlantUML 语法支持，可在上方开启本地 Java 服务（需系统 Java + plantuml.jar）。
            </div>
          </div>
          <Toggle
            label="代码块显示行号"
            value={settings.enableLineNumbers}
            onChange={(v) => update({ enableLineNumbers: v })}
          />
        </section>

        <section>
          <div className="mb-1 text-sm font-medium">图片 OCR 搜索</div>
          <div className="text-xs text-[var(--color-muted-foreground)]">
            开启后，导入/粘贴的图片会异步进行本地 OCR（tesseract.js，中英文），识别文字纳入全局搜索，结果标记为「图片」。OCR 引擎首次运行需下载语言数据，可能联网；资源开销较大，默认关闭。
          </div>
          <div className="mt-2 space-y-2">
            <Toggle
              label="启用图片 OCR"
              value={!!settings.ocrEnabled}
              onChange={(v) => update({ ocrEnabled: v })}
            />
            <button
              onClick={async () => {
                setOcrBusy(true)
                setOcrMsg('')
                try {
                  const r = await window.electronAPI.ocrBatch()
                  setOcrMsg(`完成：新处理 ${r.processed} 张，失败 ${r.failed} 张`)
                } catch (err) {
                  setOcrMsg(`批量 OCR 失败：${err instanceof Error ? err.message : String(err)}`)
                } finally {
                  setOcrBusy(false)
                }
              }}
              disabled={ocrBusy}
              className="btn-secondary disabled:opacity-50"
            >
              {ocrBusy ? 'OCR 处理中…' : '批量 OCR 已有图片'}
            </button>
            {ocrMsg && <div className="text-xs text-[var(--color-muted-foreground)]">{ocrMsg}</div>}
          </div>
        </section>

        <section>
          <div className="mb-1 text-sm font-medium">系统托盘快捷记录</div>
          <div className="text-xs text-[var(--color-muted-foreground)]">
            应用最小化到系统托盘；全局快捷键唤起极简输入浮窗，输入内容保存为一条笔记。
          </div>
          <div className="mt-2 space-y-2">
            <Toggle
              label="启用托盘与全局快捷键"
              value={settings.quickNote?.enabled ?? true}
              onChange={(v) => update({ quickNote: { ...(settings.quickNote ?? { enabled: true, shortcut: 'Ctrl+Shift+N', defaultGroupId: null }), enabled: v } })}
            />
            <label className="flex items-center gap-2 text-sm">
              <span className="w-28 text-[var(--color-muted-foreground)]">全局快捷键</span>
              <input
                value={settings.quickNote?.shortcut ?? 'Ctrl+Shift+N'}
                onChange={(e) => {
                  const sc = e.target.value
                  update({ quickNote: { enabled: settings.quickNote?.enabled ?? true, shortcut: sc, defaultGroupId: settings.quickNote?.defaultGroupId ?? null } })
                }}
                onBlur={(e) => {
                  const sc = e.target.value.trim() || 'Ctrl+Shift+N'
                  window.electronAPI.setQuickNoteShortcut(sc)
                }}
                placeholder="如 Ctrl+Shift+N"
                className="flex-1 rounded-md border border-[var(--color-border)] bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
            <div className="text-xs text-[var(--color-muted-foreground)]">
              小记默认保存为「未分类」笔记（可在主界面再整理到分组）。
            </div>
          </div>
        </section>

        <section>
          <div className="mb-1 text-sm font-medium">本地 HTTP API</div>
          <div className="text-xs text-[var(--color-muted-foreground)]">
            开启后在 127.0.0.1 监听，提供只读 REST 接口（列出知识库/列出文档/获取文档/搜索），需 Token 认证。供本地脚本或其它应用读取数据。
          </div>
          <div className="mt-2 space-y-2">
            <Toggle
              label="启用本地 API"
              value={settings.localApi?.enabled ?? false}
              onChange={(v) => {
                update({ localApi: { ...(settings.localApi ?? { enabled: false, port: 0, token: '' }), enabled: v } })
                setTimeout(() => window.electronAPI.notifyLocalApiChanged(), 100)
              }}
            />
            <label className="flex items-center gap-2 text-sm">
              <span className="w-28 text-[var(--color-muted-foreground)]">端口（0=随机）</span>
              <input
                type="number"
                min={0}
                max={65535}
                value={settings.localApi?.port ?? 0}
                onChange={(e) => {
                  update({ localApi: { ...(settings.localApi ?? { enabled: false, port: 0, token: '' }), port: Number(e.target.value) } })
                }}
                onBlur={() => window.electronAPI.notifyLocalApiChanged()}
                className="w-32 rounded-md border border-[var(--color-border)] bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
            <div className="flex items-center gap-2 text-sm">
              <span className="w-28 text-[var(--color-muted-foreground)]">Token</span>
              <code className="flex-1 truncate rounded bg-[var(--color-ghost)] px-2 py-1 text-xs">
                {settings.localApi?.token || '（未生成）'}
              </code>
              <button
                onClick={async () => {
                  const t = await window.electronAPI.regenerateLocalApiToken()
                  update({ localApi: { ...(settings.localApi ?? { enabled: false, port: 0, token: '' }), token: t } })
                }}
                className="btn-secondary text-xs"
              >
                重新生成
              </button>
            </div>
            <LocalApiStatus />
          </div>
        </section>

        <section>
          <div className="mb-1 text-sm font-medium">Web 剪藏</div>
          <div className="text-xs text-[var(--color-muted-foreground)]">
            复用本地 HTTP API：生成书签脚本，在浏览器中点击即可把当前网页（标题+URL+选中文本或正文摘要）剪藏为一条笔记。需先开启「本地 HTTP API」。
          </div>
          <div className="mt-2 space-y-2">
            <Toggle
              label="启用 Web 剪藏接收"
              value={settings.webClip?.enabled ?? false}
              onChange={(v) =>
                update({
                  webClip: { enabled: v, defaultGroupId: settings.webClip?.defaultGroupId ?? null }
                })
              }
            />
            <WebClipBookmarklet />
            <div className="text-xs text-[var(--color-muted-foreground)]">
              剪藏保存为笔记（含来源链接与抓取时间），可在主界面搜索或整理到分组。
            </div>
          </div>
        </section>

        <section>
          <div className="mb-1 text-sm font-medium">本地 AI / Ollama</div>
          <div className="text-xs text-[var(--color-muted-foreground)]">
            接入本地 Ollama 服务，在编辑器工具栏提供 AI 续写/摘要/翻译/解释/问答。所有调用仅在用户主动触发时发生，内容发送到本地 Ollama，不外传。
          </div>
          <div className="mt-2 space-y-2">
            <Toggle
              label="启用 AI"
              value={settings.ollama?.enabled ?? false}
              onChange={(v) =>
                update({
                  ollama: { ...(settings.ollama ?? { enabled: false, url: 'http://127.0.0.1:11434', model: '' }), enabled: v }
                })
              }
            />
            <OllamaConfigRow />
          </div>
        </section>

        <section>
          <div className="mb-1 text-sm font-medium">应用锁屏</div>
          <div className="text-xs text-[var(--color-muted-foreground)]">
            开启后，应用启动与「立即锁屏（Ctrl+L）」时需要输入密码才能进入。密码以 PBKDF2 哈希存储，不留明文。
          </div>
          <div className="mt-2 space-y-2">
            {!lockEnabled ? (
              <>
                <input
                  type="password"
                  value={pwd}
                  onChange={(e) => setPwd(e.target.value)}
                  placeholder="设置密码"
                  className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-1.5 text-sm outline-none"
                />
                <input
                  type="password"
                  value={pwdConfirm}
                  onChange={(e) => setPwdConfirm(e.target.value)}
                  placeholder="再次输入密码"
                  className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-1.5 text-sm outline-none"
                />
                <button
                  onClick={async () => {
                    if (!pwd.trim()) {
                      setLockMsg('密码不能为空')
                      return
                    }
                    if (pwd !== pwdConfirm) {
                      setLockMsg('两次输入不一致')
                      return
                    }
                    await window.electronAPI.setAppLock(pwd)
                    setLockEnabled(true)
                    setPwd('')
                    setPwdConfirm('')
                    setLockMsg('已开启应用锁屏')
                  }}
                  className="btn-primary"
                >
                  开启锁屏
                </button>
              </>
            ) : (
              <>
                <div className="text-xs text-[var(--color-success)]">应用锁屏已开启</div>
                <input
                  type="password"
                  value={pwd}
                  onChange={(e) => setPwd(e.target.value)}
                  placeholder="输入当前密码以关闭"
                  className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-1.5 text-sm outline-none"
                />
                <button
                  onClick={async () => {
                    const ok = await window.electronAPI.clearAppLock(pwd)
                    if (ok) {
                      setLockEnabled(false)
                      setPwd('')
                      setLockMsg('已关闭应用锁屏')
                    } else {
                      setLockMsg('密码错误')
                    }
                  }}
                  className="btn-secondary"
                >
                  关闭锁屏
                </button>
              </>
            )}
            {lockMsg && <div className="text-xs text-[var(--color-muted-foreground)]">{lockMsg}</div>}
          </div>
        </section>

        <section>
          <div className="text-xs text-[var(--color-muted-foreground)]">
            版本历史保留上限：{settings.maxHistoryVersions} 版
          </div>
        </section>

        {/* UE-18「数据」分区：NavRail 数据菜单按新 UE 收进设置对话框 */}
        <section className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
          <div className="py-2">
            <div className="mb-1 text-sm font-medium">数据</div>
            <div className="mb-2 break-all text-xs text-[var(--color-muted-foreground)]">
              数据目录：{dataDir || '…'}
            </div>
            <div className="flex flex-wrap gap-2">
              {onExport && (
                <button className="btn-secondary" onClick={onExport}>
                  <Download className="h-4 w-4" />
                  导出 ZIP
                </button>
              )}
              {onImport && (
                <button className="btn-secondary" onClick={onImport}>
                  <Upload className="h-4 w-4" />
                  导入 ZIP
                </button>
              )}
              {onImportExternal && (
                <button className="btn-secondary" onClick={onImportExternal}>
                  <FileInput className="h-4 w-4" />
                  导入外部文件
                </button>
              )}
              <button
                className="btn-secondary"
                onClick={() => void window.electronAPI.openDataDir()}
              >
                <FolderOpen className="h-4 w-4" />
                打开目录
              </button>
            </div>
            <div className="mt-1 text-xs text-[var(--color-muted-foreground)]">
              导入前会自动对当前数据做全量 ZIP 备份；所有数据仅保存在本机。
            </div>
          </div>
        </section>

        {/* UE-18「关于」分区 */}
        <section>
          <div className="flex items-center gap-2 py-1 text-sm">
            <Info className="h-4 w-4 text-[var(--color-muted-foreground)]" />
            <span>织记 NoteWeave</span>
            <span className="text-xs text-[var(--color-muted-foreground)]">版本 {APP_VERSION}</span>
          </div>
          <div className="text-xs text-[var(--color-muted-foreground)]">
            本地优先 · Markdown 原生 · 数据不出本机。
          </div>
        </section>
      </div>
    </Modal>
  )
}

// REQ-215 Ollama 连接配置与测试
function OllamaConfigRow() {
  const { settings, update } = useSettings()
  const [models, setModels] = useState<string[]>([])
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState('')
  const url = settings.ollama?.url ?? 'http://127.0.0.1:11434'
  const model = settings.ollama?.model ?? ''

  const test = async () => {
    setTesting(true)
    setTestMsg('')
    try {
      const r = await window.electronAPI.ollamaCheck(url)
      if (r.ok) {
        setModels(r.models ?? [])
        setTestMsg(`连接成功，可用模型 ${r.models?.length ?? 0} 个`)
      } else {
        setTestMsg(`连接失败：${r.error}`)
      }
    } finally {
      setTesting(false)
    }
  }
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <span className="w-20 text-[var(--color-muted-foreground)]">Ollama URL</span>
        <input
          value={url}
          onChange={(e) =>
            update({
              ollama: { enabled: settings.ollama?.enabled ?? false, url: e.target.value, model }
            })
          }
          className="input flex-1 bg-transparent"
        />
        <button onClick={test} disabled={testing} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs disabled:opacity-50">
          {testing ? '测试中…' : '测试连接'}
        </button>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <span className="w-20 text-[var(--color-muted-foreground)]">默认模型</span>
        {models.length > 0 ? (
          <select
            value={model}
            onChange={(e) =>
              update({ ollama: { enabled: settings.ollama?.enabled ?? false, url, model: e.target.value } })
            }
            className="input flex-1 bg-transparent"
          >
            <option value="">（使用第一个可用）</option>
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        ) : (
          <input
            value={model}
            onChange={(e) =>
              update({ ollama: { enabled: settings.ollama?.enabled ?? false, url, model: e.target.value } })
            }
            placeholder="如 llama3（测试连接后可选）"
            className="input flex-1 bg-transparent"
          />
        )}
      </label>
      {testMsg && <div className="text-xs text-[var(--color-muted-foreground)]">{testMsg}</div>}
    </div>
  )
}

// REQ-219 显示本地 API 实际运行状态（端口/URL）
function LocalApiStatus() {
  const [status, setStatus] = useState<{ running: boolean; port?: number; baseUrl?: string } | null>(null)
  useEffect(() => {
    window.electronAPI.getLocalApiStatus().then(setStatus)
    const t = setInterval(() => window.electronAPI.getLocalApiStatus().then(setStatus), 2000)
    return () => clearInterval(t)
  }, [])
  if (!status) return null
  return (
    <div className="rounded-md bg-[var(--color-ghost)] px-2 py-1 text-xs text-[var(--color-muted-foreground)]">
      {status.running ? (
        <>
          运行中 · <code>{status.baseUrl}</code>
          <span className="ml-2">（示例：{status.baseUrl}/api/help）</span>
        </>
      ) : (
        '未运行（开启后启动）'
      )}
    </div>
  )
}

// REQ-216 书签脚本生成与复制
function WebClipBookmarklet() {
  const [bookmarklet, setBookmarklet] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const generate = async () => {
    setError('')
    setCopied(false)
    try {
      const bl = await window.electronAPI.getWebClipBookmarklet()
      setBookmarklet(bl)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="space-y-1.5">
      <button onClick={generate} className="btn-secondary">
        生成书签脚本
      </button>
      {bookmarklet && (
        <div className="space-y-1">
          <div className="rounded-md bg-[var(--color-ghost)] p-2 text-[11px] text-[var(--color-muted-foreground)]">
            将下方链接拖到浏览器书签栏（或复制地址）。在任意网页点击该书签即可剪藏到织记。
          </div>
          <div className="flex items-center gap-2">
            <a
              href={bookmarklet}
              onClick={(e) => e.preventDefault()}
              className="flex-1 truncate rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-primary)] underline"
              title="拖到书签栏"
            >
              剪藏到织记
            </a>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(bookmarklet).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }}
              className="btn-secondary text-xs"
            >
              {copied ? '已复制' : '复制'}
            </button>
          </div>
        </div>
      )}
      {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
    </div>
  )
}
