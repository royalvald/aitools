// REQ-219 本地 HTTP API 纯函数：路由匹配与 token 认证判定（无 Electron 依赖，便于单测）。

export type ApiRoute =
  | { kind: 'help' }
  | { kind: 'kbs' }
  | { kind: 'kbDocs'; kbId: string }
  | { kind: 'doc'; kbId: string; docId: string }
  | { kind: 'search'; q: string; type?: string[] }
  | { kind: 'clip' } // REQ-216 POST /api/clip
  | { kind: 'notFound'; path: string }

// 解析 URL 路径为路由信息
export function matchRoute(urlPath: string): ApiRoute {
  const path = urlPath.replace(/\/+$/, '')
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'help') return { kind: 'help' }
  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'kbs') return { kind: 'kbs' }
  if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'kbs' && parts[3] === 'docs') {
    return { kind: 'kbDocs', kbId: decodeURIComponent(parts[2]) }
  }
  if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'docs') {
    return { kind: 'doc', kbId: decodeURIComponent(parts[2]), docId: decodeURIComponent(parts[3]) }
  }
  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'search') {
    return { kind: 'search', q: '', type: undefined }
  }
  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'clip') {
    return { kind: 'clip' }
  }
  return { kind: 'notFound', path }
}

// REQ-216 剪藏请求体（由 bookmarklet 发送）
export interface ClipPayload {
  title: string
  url: string
  content: string // 正文摘要（Markdown 或纯文本）
  capturedAt?: string
}

export function parseClipPayload(raw: string): ClipPayload | null {
  try {
    const obj = JSON.parse(raw) as Partial<ClipPayload>
    if (typeof obj.title !== 'string' || typeof obj.url !== 'string') return null
    return {
      title: obj.title.slice(0, 200),
      url: obj.url,
      content: typeof obj.content === 'string' ? obj.content : '',
      capturedAt: typeof obj.capturedAt === 'string' ? obj.capturedAt : undefined
    }
  } catch {
    return null
  }
}

// 判定 Authorization 头或查询 token 是否匹配
export function tokenMatches(authHeader: string | undefined, queryToken: string | null, expected: string): boolean {
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim() === expected
  }
  return queryToken === expected
}
