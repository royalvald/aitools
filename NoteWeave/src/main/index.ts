import { app, BrowserWindow, ipcMain, Menu, net, protocol, screen, shell, dialog } from 'electron'
import path from 'path'
import crypto from 'crypto'
import { registerIpcHandlers } from './ipc-handlers'
import { exportAllData, importData } from './export-import'
import { getNotesDir, getAssetsDir, getSettings } from './store'
import {
  registerExternalKbBridge,
  startWatchingExternalKb,
  stopWatchingExternalKb
} from './external-kb'
import { mountExternalKb } from './external-kb'
import { setupTray, interceptCloseToTray, reregisterQuickNoteShortcut, cleanup as cleanupTray } from './tray'
import { startLocalApi, stopLocalApi, getLocalApiStatus } from './http-api'
import { saveSettings } from './store'

const isDev = process.env.NODE_ENV === 'development'

// REQ-004/016：声明 noteweave-asset 为受信 scheme，允许在渲染进程通过 <img>/<a> 加载，
// 并绕过 CSP（须在 app ready 前调用）。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'noteweave-asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true
    }
  }
])

// 数据目录解析：数据与程序同目录，便于备份、迁移和绿色化使用。
// - 开发模式：写入项目根目录下的 dev-data/，避免污染 electron 安装目录或系统 AppData。
// - 生产模式：写入可执行文件（exe）所在目录下的 data/，实现便携化、卸载不丢数据。
function resolveUserDataPath(): string {
  if (isDev) {
    return path.join(process.cwd(), 'dev-data')
  }
  const installDir = path.dirname(process.execPath)
  return path.join(installDir, 'data')
}

// 必须在 app ready 之前设置 userData，使 store.ts 中所有基于 app.getPath('userData')
// 的惰性路径解析（notes/、knowledge-bases/）指向新的安装目录下 data/。
app.setPath('userData', resolveUserDataPath())
// 打印数据目录绝对路径，便于便携版升级/迁移时确认数据落点（升级时勿覆盖此目录）。
// eslint-disable-next-line no-console
console.log(`[NoteWeave] 数据目录：${app.getPath('userData')}`)

// 按主显示器工作区大小的 80% 计算窗口初始尺寸，下限不小于 minW/minH。
function computeWindowSize(minW: number, minH: number, ratio = 0.8): { width: number; height: number } {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  return {
    width: Math.max(minW, Math.round(width * ratio)),
    height: Math.max(minH, Math.round(height * ratio))
  }
}

function createWindow(target?: { kind: 'note' | 'kbDoc'; id: string; kbId?: string }): BrowserWindow {
  const size = computeWindowSize(1024, 700)
  const mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: 1024,
    minHeight: 700,
    center: true,
    resizable: true,
    show: false,
    title: '织记',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // REQ-220 关闭主窗口时最小化到托盘（而非退出），托盘已建立时生效
  mainWindow.on('close', (e) => {
    if (trayActive && !mainWindow.isDestroyed()) {
      e.preventDefault()
      interceptCloseToTray(mainWindow)
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    if (isDev) {
      mainWindow.webContents.openDevTools()
    }
  })

  // 通过 URL query 传入「打开目标」，使新窗口可独立定位到某 Note / KB Doc。
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    const u = new URL(process.env.ELECTRON_RENDERER_URL)
    if (target) {
      u.searchParams.set('openKind', target.kind)
      u.searchParams.set('openId', target.id)
      if (target.kbId) u.searchParams.set('openKbId', target.kbId)
    }
    mainWindow.loadURL(u.toString())
  } else if (target) {
    const search = `openKind=${target.kind}&openId=${encodeURIComponent(target.id)}${
      target.kbId ? `&openKbId=${encodeURIComponent(target.kbId)}` : ''
    }`
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { search })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}

let trayActive = false
let mainInstance: BrowserWindow | null = null

app.whenReady().then(() => {
  registerIpcHandlers()
  registerExternalKbBridge()
  buildApplicationMenu()
  registerAssetProtocol()
  mainInstance = createWindow()

  // REQ-220 系统托盘 + 全局快捷键小记（ready 后建立）
  setupTray(() => mainInstance)
  trayActive = true
  // 根据设置应用快捷键
  void getSettings().then((s) => {
    if (s.quickNote?.shortcut && s.quickNote.shortcut !== 'Ctrl+Shift+N') {
      reregisterQuickNoteShortcut(s.quickNote.shortcut)
    }
  })

  // 设置变更：更新小记快捷键
  ipcMain.on('settings:quickNoteShortcut', (_, acc: string) => {
    reregisterQuickNoteShortcut(acc)
  })

  // REQ-219 本地 HTTP API：根据设置启动/停止
  void getSettings().then((s) => {
    if (s.localApi?.enabled && s.localApi.token) {
      void startLocalApi(s.localApi.port ?? 0, s.localApi.token).catch(() => {})
    }
  })
  // 设置变更：重启本地 API（port/token/enabled 改变时）
  ipcMain.on('settings:localApiChanged', async () => {
    const s = await getSettings()
    if (s.localApi?.enabled && s.localApi.token) {
      try {
        await startLocalApi(s.localApi.port ?? 0, s.localApi.token)
      } catch {
        // 端口占用等错误忽略
      }
    } else {
      await stopLocalApi()
    }
  })
  ipcMain.handle('localApi:status', () => getLocalApiStatus())
  // REQ-216 Web 剪藏书签脚本
  ipcMain.handle('webClip:bookmarklet', async () => {
    const status = getLocalApiStatus()
    const s = await getSettings()
    if (!status.running || !status.baseUrl) {
      throw new Error('本地 API 未运行，请先在设置中开启本地 HTTP API')
    }
    const { buildBookmarklet } = await import('../shared/webclip-helpers')
    return buildBookmarklet(status.baseUrl, s.localApi?.token ?? '')
  })
  ipcMain.handle('localApi:regenToken', async () => {
    const s = await getSettings()
    const newToken = crypto.randomBytes(16).toString('hex')
    await saveSettings({ ...s, localApi: { ...(s.localApi ?? { enabled: false, port: 0, token: '' }), token: newToken } })
    // 重启以应用新 token
    if (s.localApi?.enabled) {
      try {
        await startLocalApi(s.localApi.port ?? 0, newToken)
      } catch {
        // ignore
      }
    }
    return newToken
  })

  // REQ-117 多窗口：在新应用窗口打开指定 Note / KB Doc。
  ipcMain.on(
    'window:open-target',
    async (_, target: { kind: 'note' | 'kbDoc'; id: string; kbId?: string }) => {
      createWindow(target)
    }
  )

  // REQ-117 新建空窗口
  ipcMain.on('window:new', () => {
    createWindow()
  })

  // REQ-120：通过菜单触发「打开本地文件夹作为知识库」
  ipcMain.on('menu:open-external-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return
    const folderPath = result.filePaths[0]
    try {
      const summary = await mountExternalKb(folderPath, false)
      startWatchingExternalKb(summary.id, folderPath)
      // 广播给所有窗口刷新知识库列表
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('externalKb:changed', summary.id)
      }
    } catch {
      // ignore
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// REQ-004/016 自定义协议 noteweave-asset://：将资源 URL（assets/ 下的相对路径）
// 解析为本地文件，供预览/编辑态加载图片与附件。仅允许访问 userData/assets 目录，
// 防止任意文件读取。使用 net.fetch 流式返回，兼容 file: 路径与中文文件名。
function registerAssetProtocol(): void {
  protocol.handle('noteweave-asset', (request) => {
    try {
      // URL 形如 noteweave-asset:///notes/<id>/xxx.png
      const url = new URL(request.url)
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      // 兼容部分写入带 assets/ 前缀的情况
      if (rel.startsWith('assets/')) rel = rel.slice('assets/'.length)
      const base = getAssetsDir()
      const resolved = path.resolve(base, rel)
      // 安全校验：必须在 assets 目录内
      if (!resolved.startsWith(base + path.sep) && resolved !== base) {
        return new Response('Forbidden', { status: 403 })
      }
      return net.fetch('file://' + resolved.replace(/\\/g, '/'))
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function buildApplicationMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开数据文件夹',
          accelerator: 'Ctrl+Shift+O',
          click: async () => {
            await shell.openPath(getNotesDir())
          }
        },
        {
          label: '打开本地文件夹作为知识库…',
          click: async () => {
            const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
            if (result.canceled || result.filePaths.length === 0) return
            const folderPath = result.filePaths[0]
            try {
              const summary = await mountExternalKb(folderPath, false)
              startWatchingExternalKb(summary.id, folderPath)
              for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) win.webContents.send('externalKb:changed', summary.id)
              }
            } catch {
              // ignore
            }
          }
        },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            const focusedWindow = BrowserWindow.getFocusedWindow()
            if (focusedWindow) {
              focusedWindow.webContents.send('menu:save')
            }
          }
        },
        {
          label: '快速打开…',
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            const focusedWindow = BrowserWindow.getFocusedWindow()
            focusedWindow?.webContents.send('menu:quick-open')
          }
        },
        {
          label: '命令面板…',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => {
            const focusedWindow = BrowserWindow.getFocusedWindow()
            focusedWindow?.webContents.send('menu:command-palette')
          }
        },
        { type: 'separator' },
        {
          label: '导出所有数据...',
          accelerator: 'Ctrl+Shift+E',
          click: async () => {
            await exportAllData()
          }
        },
        {
          label: '导入数据...',
          accelerator: 'Ctrl+Shift+I',
          click: async () => {
            const result = await importData()
            if (result.success) {
              const focusedWindow = BrowserWindow.getFocusedWindow()
              if (focusedWindow) {
                focusedWindow.webContents.send('menu:import-complete')
              }
            }
          }
        },
        {
          label: '导入外部文件...',
          click: () => {
            // REQ-209：通知渲染进程触发外部文件导入（目标知识库由渲染进程决定）
            const focusedWindow = BrowserWindow.getFocusedWindow()
            if (focusedWindow) {
              focusedWindow.webContents.send('menu:import-external')
            }
          }
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: isMac ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => {
            app.quit()
          }
        }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '切换 Focus 模式',
          accelerator: 'F11',
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send('menu:toggle-focus')
        },
        {
          label: '切换打字机模式',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send('menu:toggle-typewriter')
        },
        {
          label: '进入演示模式',
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send('menu:present')
        },
        { type: 'separator' },
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '切换开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '重置缩放', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '切换全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        {
          label: '新建窗口',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createWindow()
        },
        { label: '最小化', role: 'minimize' },
        { label: '关闭', role: 'close' }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

app.on('window-all-closed', () => {
  // REQ-220 托盘激活时，所有窗口关闭不退出应用（保留托盘）
  if (trayActive) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  cleanupTray()
  void stopLocalApi()
})
