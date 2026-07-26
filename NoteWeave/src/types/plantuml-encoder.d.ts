declare module 'plantuml-encoder' {
  /** 将 PlantUML 源码按 PlantUML 服务约定编码为 URL 安全字符串。 */
  export function encode(source: string): string
  /** 解码 PlantUML 编码字符串。 */
  export function decode(encoded: string): string
  const _default: { encode: typeof encode; decode: typeof decode }
  export default _default
}
