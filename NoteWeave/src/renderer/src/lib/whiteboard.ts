export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function formatScale(value: number): string {
  return `${Math.round(value * 100)}%`
}
