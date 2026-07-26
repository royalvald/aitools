// REQ-014 版本对比：基于 LCS 的逐行 diff。
// 输出统一的增删行列表，供版本历史面板渲染。

export type DiffOp = 'equal' | 'add' | 'del'

export interface DiffLine {
  op: DiffOp
  text: string
}

// 计算两个文本之间的逐行 diff（LCS 动态规划）。
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = (oldText ?? '').split('\n')
  const b = (newText ?? '').split('\n')
  const n = a.length
  const m = b.length

  // dp[i][j] = a[i:] 与 b[j:] 的最长公共子序列长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'equal', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: 'del', text: a[i] })
      i++
    } else {
      out.push({ op: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) {
    out.push({ op: 'del', text: a[i++] })
  }
  while (j < m) {
    out.push({ op: 'add', text: b[j++] })
  }
  return out
}
