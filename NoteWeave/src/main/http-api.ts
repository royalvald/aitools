import http from 'http'
import type { IncomingMessage, ServerResponse } from 'http'
import { BrowserWindow } from 'electron'
import { listKnowledgeBases, listKbDocs, getKbDoc, search, getSettings, createNote, saveNote } from './store'
import { matchRoute, tokenMatches, parseClipPayload } from '../shared/http-api-helpers'

// REQ-219 本地 HTTP API（只读 REST）。
// 默认监听 127.0.0.1，端口可配（0=随机），Token 认证。
// 接口：
//   GET /api/kbs                       列出知识库
//   GET /api/kbs/:kbId/docs            列出某知识库的文档
//   GET /api/docs/:kbId/:docId         获取文档内容
//   GET /api/search?q=...&type=...     搜索
//   GET /api/help                      API 文档（JSON）

let server: http.Server | null = null
let actualPort = 0

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type'
  })
  res.end(body)
}

function authenticate(req: IncomingMessage, token: string): boolean {
  const auth = req.headers['authorization']
  const url = new URL(req.url ?? '/', 'http://localhost')
  return tokenMatches(auth, url.searchParams.get('token'), token)
}

function buildRouter(token: string): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type'
      })
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = matchRoute(url.pathname)
    // 仅 /api/clip 允许 POST（REQ-216 剪藏写入），其余仅 GET
    const isClipPost = route.kind === 'clip' && req.method === 'POST'
    if (req.method !== 'GET' && !isClipPost) {
      sendJson(res, 405, { error: '仅支持 GET（/api/clip 支持 POST 剪藏）' })
      return
    }
    if (!authenticate(req, token)) {
      sendJson(res, 401, { error: '未认证：请在 Authorization 头携带 Bearer <token>，或查询参数 ?token=<token>' })
      return
    }

    // REQ-216 剪藏：读取 body → 解析 → 创建 Note
    if (route.kind === 'clip') {
      try {
        const body = await readBody(req)
        const payload = parseClipPayload(body)
        if (!payload) {
          sendJson(res, 400, { error: '剪藏内容格式无效（需 JSON，含 title/url）' })
          return
        }
        const settings = await getSettings()
        if (!settings.webClip?.enabled) {
          sendJson(res, 403, { error: 'Web 剪藏未在设置中开启' })
          return
        }
        const groupId = settings.webClip.defaultGroupId ?? null
        const note = await createNote(groupId)
        const capturedAt = payload.capturedAt ?? new Date().toISOString()
        const md = `# ${payload.title}\n\n> 来源：${payload.url}\n> 抓取时间：${capturedAt}\n\n${payload.content}\n`
        const saved = await saveNote({
          ...note,
          title: payload.title || '剪藏',
          content: md,
          tags: ['剪藏']
        })
        // 通知主窗口刷新
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send('menu:import-complete')
        }
        sendJson(res, 201, { ok: true, noteId: saved.id, title: saved.title })
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    try {
      switch (route.kind) {
        case 'help':
          sendJson(res, 200, API_DOC)
          return
        case 'kbs':
          listKnowledgeBases().then((kbs) => sendJson(res, 200, { kbs }))
          return
        case 'kbDocs':
          listKbDocs(route.kbId).then((docs) => sendJson(res, 200, { kbId: route.kbId, docs }))
          return
        case 'doc':
          getKbDoc(route.kbId, route.docId).then((doc) => {
            if (!doc) sendJson(res, 404, { error: '文档不存在' })
            else sendJson(res, 200, doc)
          })
          return
        case 'search': {
          const q = url.searchParams.get('q') ?? ''
          const type = url.searchParams.get('type')
          const filters = type ? (type.split(',').filter(Boolean) as never) : undefined
          search(q, filters ? { filters } : undefined)
            .then((results) => sendJson(res, 200, { query: q, results }))
            .catch((e) => sendJson(res, 500, { error: String(e) }))
          return
        }
        default:
          sendJson(res, 404, { error: '未知接口', path: route.path })
      }
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }
}

// 读取请求体（上限 1MB）
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大（>1MB）'))
        req.destroy()
        return
      }
      data += chunk.toString('utf-8')
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

const API_DOC = {
  name: '织记本地 HTTP API',
  version: 1,
  auth: '在 Authorization 头携带 Bearer <token>，或查询参数 ?token=<token>',
  readOnly: true,
  note: '仅 /api/clip 允许 POST（剪藏写入，需在设置中开启 Web 剪藏），其余接口均为只读 GET',
  endpoints: [
    { method: 'GET', path: '/api/kbs', desc: '列出全部知识库' },
    { method: 'GET', path: '/api/kbs/:kbId/docs', desc: '列出某知识库的文档' },
    { method: 'GET', path: '/api/docs/:kbId/:docId', desc: '获取文档内容（Markdown）' },
    { method: 'GET', path: '/api/search?q=<kw>&type=note,kbDoc', desc: '全文搜索（type 可选，逗号分隔）' },
    { method: 'POST', path: '/api/clip', desc: 'Web 剪藏：提交 {title,url,content} 创建为 Note（需开启剪藏）' },
    { method: 'GET', path: '/api/help', desc: '本 API 文档' }
  ]
}

export async function startLocalApi(port: number, token: string): Promise<number> {
  if (server) {
    await stopLocalApi()
  }
  return new Promise((resolve, reject) => {
    const s = http.createServer(buildRouter(token))
    s.on('error', reject)
    s.listen(port, '127.0.0.1', () => {
      const addr = s.address()
      actualPort = typeof addr === 'object' && addr ? addr.port : port
      server = s
      resolve(actualPort)
    })
  })
}

export async function stopLocalApi(): Promise<void> {
  if (!server) return
  return new Promise((resolve) => {
    server!.close(() => {
      server = null
      actualPort = 0
      resolve()
    })
  })
}

export function getLocalApiStatus(): { running: boolean; port: number; baseUrl: string } {
  return {
    running: !!server,
    port: actualPort,
    baseUrl: actualPort ? `http://127.0.0.1:${actualPort}` : ''
  }
}
