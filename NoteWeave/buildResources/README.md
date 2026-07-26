# buildResources

## PlantUML（REQ-115）

为启用本地 PlantUML 图表渲染（```plantuml 代码块），请：

1. 从 https://plantuml.com/download 下载 `plantuml.jar` 放到本目录（`buildResources/plantuml.jar`）。
2. 确保系统已安装 Java 运行时（应用设置中会显示检测状态）。
3. 在应用「设置 → 本地 PlantUML 服务」开启开关。
4. 打包时取消注释 `electron-builder.yml` 中的 `extraResources` 段，使 jar 随应用分发。

> 说明：Graphviz（```dot 代码块）使用纯 WASM 本地渲染，无需任何外部依赖即可工作。
> PlantUML 因协议要求严格本地（不联网），故依赖系统 Java + plantuml.jar。
