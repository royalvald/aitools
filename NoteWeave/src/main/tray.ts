import { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, ipcMain, screen } from 'electron'
import path from 'path'
import { createNote } from './store'

// REQ-220 系统托盘快捷记录。
// - 托盘图标 + 右键菜单（新建小记 / 打开主窗口 / 退出）。
// - 全局快捷键唤起极简输入浮窗，输入内容保存为一条 Note。
// - 关闭主窗口时最小化到托盘（而非退出）。

let tray: Tray | null = null
let quickNoteWindow: BrowserWindow | null = null

// 用一个 1x1 透明图标的 base64 作为托盘图标兜底（避免无图标文件时报错）。
// 生产/开发均可工作；如需真实图标可后续放入 buildResources/。
function buildTrayImage() {
  const iconPath = path.join(process.resourcesPath ?? '', 'icon.png')
  try {
    const img = nativeImage.createFromPath(iconPath)
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 })
  } catch {
    // ignore
  }
  // 兜底：构造一个 16x16 的简易图标（深蓝实心）
  return nativeImage.createFromBuffer(Buffer.from(APP_ICON_PNG))
}

const APP_ICON_PNG = Buffer.alloc(0) // 占位；createFromBuffer 空时为透明图标，仍可点击

export function setupTray(getMainWindow: () => BrowserWindow | null): void {
  if (tray) return
  tray = new Tray(buildTrayImage())
  tray.setToolTip('织记')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '新建小记',
      click: () => showQuickNoteWindow()
    },
    {
      label: '打开主窗口',
      click: () => {
        const win = getMainWindow()
        if (win) {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        cleanup()
        app.quit()
      }
    }
  ])
  tray.setContextMenu(contextMenu)

  // 单击托盘图标：切换主窗口显示
  tray.on('click', () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isVisible() && win.isFocused()) {
      win.hide()
    } else {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  // 全局快捷键 Ctrl+Shift+N（注册在 ready 后）
  registerQuickNoteShortcut(getMainWindow)

  // 快速小记窗口的 IPC：保存小记
  ipcMain.handle('quickNote:save', async (_, text: string) => {
    const content = (text || '').trim()
    if (!content) return { ok: false, reason: 'empty' }
    try {
      const { getSettings } = await import('./store')
      const settings = await getSettings()
      const groupId = settings.quickNote?.defaultGroupId ?? null
      const note = await createNote(groupId)
      // 把内容写入 note（标题取首行，其余作正文）
      const lines = content.split('\n')
      const title = lines[0].slice(0, 60) || '小记'
      const body = lines.length > 1 ? lines.slice(1).join('\n').trim() : ''
      const full = body ? `${title}\n\n${body}` : title
      const { saveNote } = await import('./store')
      await saveNote({ ...note, title, content: full })
      // 通知主窗口刷新（如有）
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('menu:import-complete')
      }
      return { ok: true, noteId: note.id }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.on('quickNote:hide', () => {
    if (quickNoteWindow) quickNoteWindow.hide()
  })
}

let currentAccelerator = 'Ctrl+Shift+N'

function registerQuickNoteShortcut(getMainWindow: () => BrowserWindow | null): void {
  try {
    globalShortcut.register(currentAccelerator, () => {
      showQuickNoteWindow()
    })
  } catch {
    // 注册失败忽略（可能被占用）
  }
  void getMainWindow
}

export function reregisterQuickNoteShortcut(accelerator: string): boolean {
  if (accelerator === currentAccelerator) return true
  try {
    globalShortcut.unregister(currentAccelerator)
  } catch {
    // ignore
  }
  currentAccelerator = accelerator
  try {
    globalShortcut.register(currentAccelerator, () => showQuickNoteWindow())
    return true
  } catch {
    return false
  }
}

// 极简输入浮窗：无边框、置顶、小尺寸，居中显示。
function showQuickNoteWindow(): void {
  if (quickNoteWindow && !quickNoteWindow.isDestroyed()) {
    quickNoteWindow.show()
    quickNoteWindow.focus()
    return
  }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const w = 480
  const h = 200
  quickNoteWindow = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round((width - w) / 2),
    y: Math.round((height - h) / 2),
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const isDev = process.env.NODE_ENV === 'development'
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    const u = new URL(process.env.ELECTRON_RENDERER_URL)
    u.searchParams.set('quicknote', '1')
    quickNoteWindow.loadURL(u.toString())
  } else {
    quickNoteWindow.loadFile(path.join(__dirname, '../renderer/index.html'), {
      search: 'quicknote=1'
    })
  }

  quickNoteWindow.on('blur', () => {
    // 失焦自动隐藏（极简浮窗语义）
    if (quickNoteWindow && !quickNoteWindow.isDestroyed()) {
      quickNoteWindow.hide()
    }
  })
  // 阻止关闭，改为隐藏
  quickNoteWindow.on('close', (e) => {
    e.preventDefault()
    quickNoteWindow?.hide()
  })
}

export function cleanup(): void {
  try {
    globalShortcut.unregisterAll()
  } catch {
    // ignore
  }
  if (quickNoteWindow && !quickNoteWindow.isDestroyed()) {
    quickNoteWindow.destroy()
  }
  if (tray) {
    tray.destroy()
    tray = null
  }
}

// 主窗口「关闭到托盘」拦截：调用方在主窗口 close 事件中调用此函数。
// 返回 true 表示已拦截（隐藏而非关闭）。
export function interceptCloseToTray(win: BrowserWindow): boolean {
  win.hide()
  return true
}
