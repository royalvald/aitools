// REQ-119：Pandoc 集成（检测 + 委托 CLI 调用）。
// 不内置 pandoc；仅检测系统是否安装，调用其 CLI 生成目标格式。

import { execFile, spawn } from 'child_process'
import path from 'path'
import { app } from 'electron'
import fs from 'fs/promises'

let cached: { available: boolean; version?: string; path?: string } | null = null

/** 检测系统 Pandoc 是否可用，结果缓存。 */
export function detectPandoc(): Promise<{ available: boolean; version?: string; path?: string }> {
  if (cached) return Promise.resolve(cached)
  return new Promise((resolve) => {
    const child = execFile('pandoc', ['--version'], (err, stdout) => {
      if (err) {
        cached = { available: false }
        resolve(cached)
        return
      }
      const m = stdout.match(/pandoc ([^\s]+)/)
      cached = { available: true, version: m ? m[1] : undefined, path: 'pandoc' }
      resolve(cached)
    })
    child.on('error', () => {
      cached = { available: false }
      resolve(cached)
    })
  })
}

/** 使用 Pandoc 把临时 .md 转换为目标格式文件。 */
export async function exportWithPandoc(
  markdownContent: string,
  outputFilePath: string,
  extraArgs: string[] = []
): Promise<{ success: boolean; error?: string }> {
  const det = await detectPandoc()
  if (!det.available) {
    return { success: false, error: '未检测到 Pandoc，请先安装 Pandoc 并确保其在 PATH。' }
  }
  // 写临时 .md
  const tmpDir = path.join(app.getPath('userData'), 'pandoc-tmp')
  await fs.mkdir(tmpDir, { recursive: true })
  const tmpMd = path.join(tmpDir, `${Date.now()}.md`)
  await fs.writeFile(tmpMd, markdownContent, 'utf-8')
  // pandoc 输入 -> 输出（根据 outputFilePath 扩展名决定，pandoc 会自动识别）
  return new Promise((resolve) => {
    const args = [tmpMd, '-o', outputFilePath, ...extraArgs]
    const child = spawn('pandoc', args, { shell: false })
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', () => {
      resolve({ success: false, error: '调用 Pandoc 失败' })
    })
    child.on('close', (code) => {
      // 清理临时文件
      fs.unlink(tmpMd).catch(() => {})
      if (code === 0) resolve({ success: true })
      else resolve({ success: false, error: stderr || `Pandoc 退出码 ${code}` })
    })
  })
}
