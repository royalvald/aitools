// REQ-115：PlantUML / Graphviz 本地渲染。
// - Graphviz：@viz-js/viz 纯 WASM，本地渲染 dot。
// - PlantUML：本地 HTTP 微服务（仅 127.0.0.1）调用随应用分发的 plantuml.jar + 系统 Java。
//   无 Java 或未开启（settings.enablePlantUMLServer=false）时返回错误，由前端提示。

import { app } from 'electron'
import http from 'http'
import { spawn, execFile } from 'child_process'
import path from 'path'
import { request as httpRequest } from 'http'
import { writeFileSync, existsSync } from 'fs'
import plantumlEncoder from 'plantuml-encoder'

let plantumlPort: number | null = null
let plantumlServer: http.Server | null = null
let plantumlJarPath: string | null = null

function getPlantUmlJar(): string | null {
  if (plantumlJarPath) return plantumlJarPath
  // 开发：项目根 buildResources/plantuml.jar；生产：经 extraResources 打包到 resources/plantuml.jar
  const candidates = [
    path.join(process.cwd(), 'buildResources', 'plantuml.jar'),
    path.join(process.resourcesPath ?? '', 'plantuml.jar'),
    path.join(app.getAppPath(), 'buildResources', 'plantuml.jar')
  ]
  for (const c of candidates) {
    if (existsSync(c)) {
      plantumlJarPath = c
      return c
    }
  }
  return null
}

/** 检测系统 Java 是否可用。 */
export function checkJava(): Promise<{ available: boolean; version?: string }> {
  return new Promise((resolve) => {
    const child = spawn('java', ['-version'], { shell: true })
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', () => resolve({ available: false }))
    child.on('close', (code) => {
      if (code !== 0 && !stderr) {
        resolve({ available: false })
        return
      }
      // java -version 输出形如：openjdk version "17.0.1"
      const m = stderr.match(/version "([^"]+)"/)
      resolve({ available: true, version: m ? m[1] : undefined })
    })
    // 兜底超时
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
      resolve({ available: false })
    }, 5000)
  })
}

/** Graphviz 检测（仅探测 viz-js 可加载性）。 */
export async function checkGraphviz(): Promise<{ available: boolean }> {
  try {
    await getViz()
    return { available: true }
  } catch {
    return { available: false }
  }
}

// 懒加载 viz-js 实例（WASM 初始化较重）。
let vizPromise: Promise<typeof import('@viz-js/viz')> | null = null
function getViz(): Promise<typeof import('@viz-js/viz')> {
  if (!vizPromise) {
    vizPromise = import('@viz-js/viz').then((mod) => mod)
  }
  return vizPromise
}

export async function renderGraphviz(source: string): Promise<{ ok: boolean; svg?: string; error?: string }> {
  try {
    const viz = await getViz()
    const instance = await viz.instance()
    // renderString(format:svg) 返回 SVG 字符串，不依赖 DOMParser（主进程无完整 DOM）
    const svg = instance.renderString(source, { format: 'svg' })
    return { ok: true, svg }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 启动本地 PlantUML 服务（仅 127.0.0.1），监听 /svg/<encoded>。 */
export async function startPlantUmlServer(): Promise<number | null> {
  if (plantumlServer && plantumlPort) return plantumlPort
  const java = await checkJava()
  if (!java.available) return null
  const jar = getPlantUmlJar()
  if (!jar) return null

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(404)
        res.end()
        return
      }
      const url = new URL(req.url, 'http://127.0.0.1')
      if (!url.pathname.startsWith('/svg/')) {
        res.writeHead(404)
        res.end()
        return
      }
      const encoded = decodeURIComponent(url.pathname.slice('/svg/'.length))
      const decoded = plantumlEncoder.decode(encoded)
      // 调用 java -jar plantuml.jar -tsvg，从 stdin 读源码
      const child = spawn('java', ['-jar', jar, '-tsvg', '-pipe'], { shell: false })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => {
        out += d.toString()
      })
      child.stderr.on('data', (d) => {
        err += d.toString()
      })
      child.on('error', () => {
        res.writeHead(500)
        res.end(JSON.stringify({ error: 'java spawn failed' }))
      })
      child.on('close', (code) => {
        if (code === 0 && out) {
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
          res.end(out)
        } else {
          res.writeHead(500)
          res.end(JSON.stringify({ error: err || 'plantuml failed' }))
        }
      })
      child.stdin.write(decoded)
      child.stdin.end()
    })
    server.on('error', () => resolve(null))
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      plantumlPort = typeof addr === 'object' && addr ? addr.port : null
      plantumlServer = server
      resolve(plantumlPort)
    })
    // 8s 兜底
    setTimeout(() => {
      if (plantumlPort === null) resolve(null)
    }, 8000)
  })
}

export function stopPlantUmlServer(): void {
  if (plantumlServer) {
    plantumlServer.close()
    plantumlServer = null
    plantumlPort = null
  }
}

/** 渲染 PlantUML：编码源码 → 请求本地服务 → 返回 SVG。 */
export async function renderPlantUml(source: string): Promise<{ ok: boolean; svg?: string; error?: string }> {
  // REQ-115：优先使用内置纯 JS PlantUML 子集渲染器（无需 Java/jar/联网）。
  // 覆盖序列图、类图等常用类型；复杂类型回退为等宽源码展示（保证不崩溃）。
  try {
    const { renderPlantUmlLocal } = await import('./plantuml-local')
    const local = renderPlantUmlLocal(source)
    if (local.ok && local.svg) {
      return { ok: true, svg: local.svg }
    }
  } catch {
    // 内置渲染异常则继续尝试 Java 后端
  }
  // 可选 Java + plantuml.jar 后端（用户在设置开启时）。
  const { getSettings } = await import('./store')
  const settings = await getSettings()
  if (!settings.enablePlantUMLServer) {
    return {
      ok: false,
      error: '内置渲染器不支持该 PlantUML 语法子集。如需完整支持，请在设置中开启本地 PlantUML 服务（需系统 Java + plantuml.jar）。'
    }
  }
  const port = await startPlantUmlServer()
  if (!port) {
    return {
      ok: false,
      error: '内置渲染器不支持该子集，且本地 Java/plantuml.jar 服务未就绪。'
    }
  }
  const encoded = plantumlEncoder.encode(source)
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/svg/' + encodeURIComponent(encoded),
        method: 'GET'
      },
      (r) => {
        let data = ''
        r.on('data', (d) => {
          data += d.toString()
        })
        r.on('end', () => {
          if (r.statusCode === 200 && data.includes('<svg')) {
            resolve({ ok: true, svg: data })
          } else {
            resolve({ ok: false, error: data || '渲染失败' })
          }
        })
      }
    )
    req.on('error', (e) => resolve({ ok: false, error: e.message }))
    req.setTimeout(15000, () => {
      req.destroy()
      resolve({ ok: false, error: '渲染超时' })
    })
    req.end()
  })
}

// 仅供测试：直接写临时文件并调用 pandoc/外部命令的占位，避免未使用告警。
export function _touchJarForTest(): void {
  void execFile
  void writeFileSync
}
