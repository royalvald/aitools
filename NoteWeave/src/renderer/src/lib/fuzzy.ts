// 简单模糊匹配：子序列匹配 + 连续匹配加分。返回匹配分数（>0 表示命中，0 表示未命中）。

export function fuzzyMatch(query: string, target: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let score = 0
  let qi = 0
  let consecutive = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++
      consecutive++
      score += 1 + consecutive // 连续匹配加分
      if (ti === 0 || t[ti - 1] === ' ' || t[ti - 1] === '/' || t[ti - 1] === '\\') {
        score += 2 // 词首匹配加分
      }
    } else {
      consecutive = 0
    }
  }
  return qi === q.length ? score : 0
}
