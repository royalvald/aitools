import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import type { AssetEntry } from '../shared/types'
import { ocrCacheKey, relToAssetUrl } from '../shared/ocr-helpers'
import { getAssetsDir, listAllAssets, assetUrlToAbs } from './store'

// REQ-205 图片 OCR 搜索：基于 tesseract.js 本地识别图片文字，结果缓存到
// {userData}/ocr-cache/{hash}.json，供全文搜索纳入「图片」命中类型。
//
// 注意：tesseract.js 首次运行需下载 worker / wasm / 语言数据（默认从 CDN）。
// 在离线/不可用环境下 OCR 会失败并返回 error，但不影响应用其它功能；
// 用户可在设置中关闭 OCR 开关以节省资源。

let recognizerPromise: Promise<Recognizer | null> | null = null

interface Recognizer {
  recognize: (imagePath: string) => Promise<{ data: { text: string } }>
  terminate: () => Promise<void>
}

async function getRecognizer(): Promise<Recognizer | null> {
  if (recognizerPromise) return recognizerPromise
  recognizerPromise = (async () => {
    try {
      const Tesseract = (await import('tesseract.js')) as unknown as {
        createWorker: (langs?: string | string[], oem?: number, options?: unknown) => Promise<Recognizer>
      }
      const worker = await Tesseract.createWorker('chi_sim+eng')
      return worker
    } catch {
      recognizerPromise = null
      return null
    }
  })()
  return recognizerPromise
}

export function getOcrCacheDir(): string {
  return path.join(app.getPath('userData'), 'ocr-cache')
}

// 用 asset 相对路径（去扩展名）作为缓存键，避免路径分隔符问题
// （实现见 src/shared/ocr-helpers.ts 的 ocrCacheKey，此处复用）

function cachePathForKey(key: string): string {
  return path.join(getOcrCacheDir(), `${key}.json`)
}

// 读取某 asset URL 对应的已缓存 OCR 文本（无缓存返回 null）
export async function getOcrText(assetUrl: string): Promise<string | null> {
  try {
    const abs = assetUrlToAbs(assetUrl)
    const rel = path.relative(getAssetsDir(), abs).replace(/\\/g, '/')
    const key = ocrCacheKey(rel)
    const raw = await fs.readFile(cachePathForKey(key), 'utf-8')
    const data = JSON.parse(raw) as { text?: string }
    return data.text ?? null
  } catch {
    return null
  }
}

// 对单张图片执行 OCR；force=true 时忽略已有缓存
export async function ocrImageByUrl(
  assetUrl: string,
  force = false
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const abs = assetUrlToAbs(assetUrl)
  const rel = path.relative(getAssetsDir(), abs).replace(/\\/g, '/')
  const key = ocrCacheKey(rel)

  if (!force) {
    const cached = await getOcrText(assetUrl)
    if (cached !== null) return { ok: true, text: cached }
  }

  try {
    await fs.access(abs)
  } catch {
    return { ok: false, error: '图片文件不存在' }
  }

  const worker = await getRecognizer()
  if (!worker) {
    return { ok: false, error: 'OCR 引擎不可用（tesseract.js 加载失败）' }
  }

  try {
    const result = await worker.recognize(abs)
    const text = (result.data?.text ?? '').trim()
    await fs.mkdir(getOcrCacheDir(), { recursive: true })
    await fs.writeFile(cachePathForKey(key), JSON.stringify({ text, rel, at: new Date().toISOString() }), 'utf-8')
    return { ok: true, text }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

// 批量 OCR：遍历所有图片资源，对未缓存的执行 OCR
export async function ocrBatch(): Promise<{ processed: number; failed: number }> {
  const all = await listAllAssets()
  const images = all.filter((a: AssetEntry) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.name))
  let processed = 0
  let failed = 0
  for (const img of images) {
    // 跳过已有缓存
    const cached = await getOcrText(img.url)
    if (cached !== null) continue
    const r = await ocrImageByUrl(img.url)
    if (r.ok) processed++
    else failed++
  }
  return { processed, failed }
}

// 搜索用：扫描全部 OCR 缓存，返回 { rel -> text } 映射
export async function loadAllOcrTexts(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const files = await fs.readdir(getOcrCacheDir())
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(path.join(getOcrCacheDir(), file), 'utf-8')
        const data = JSON.parse(raw) as { text?: string; rel?: string }
        if (data.text && data.rel) {
          map.set(data.rel, data.text)
        }
      } catch {
        // ignore single corrupted cache
      }
    }
  } catch {
    // cache dir not exist
  }
  return map
}

// relToAssetUrl 见 src/shared/ocr-helpers.ts（已在顶部导入）
