# 系统状态 · 首个 Python 插件迁移

查询 Bot 控制面可见系统指标，返回 PNG 状态卡片、中文文本或结构化 JSON。卡片模式只发送图片，文字、JSON、帮助模式只发送文字，不把图片和摘要文字混在一条回复里。操作、指令与 Pi 工具共用同一实现，不额外调用模型。

```text
/状态
/状态 --card
/状态 --text
/sysstatus --json
/状态 help
```

`/status` 是 Bot 内置会话控制指令，保持原行为。未知参数会由 parser 拒绝，不交给 LLM 猜测路由。

## 安装

在工作区执行 `bun run build status`、`bun run pack status /tmp/system-status.zip`，然后从工作台插件中心导入 ZIP 或构建后的本目录。首次保持停用；实际运行需要 Bot 支持 system.status RPC、实例允许 system.status/artifact.write，触发人获准 runtime_status 和本插件 operation/command。

运行前在 Bot「插件 → 运行环境」完成依赖检测并启用执行。实例若显示缺少系统状态/产物能力，可点击“允许所需能力”。名称、主题等 schema 项只影响显示，不是执行环境配置。工作区测试使用自编 child-process fixture，不自动启用正式执行或修改容器。

## 配置

`_conf_schema.json` 提供文本名称、默认 card/text、主题和阈值色。可按账号、群和 conversation 覆盖，群成员共享。bot_name 用于文字摘要；图片固定英文标题及指标标签，避免引入完整 CJK 字库。

PNG 由 Worker 内已打包的 WASM 渲染器生成，字体和 WASM 都随包携带，不连接第三方渲染站。生成文件先发布为范围内 Artifact，再清理私有卷临时文件。渲染或发布失败保留指标文本。

GPU/显存由 Bot 控制面使用固定参数的 `nvidia-smi` 只读探针采集，插件 Worker 不挂载 `/dev/nvidia*`、Docker socket 或宿主命令。没有 NVIDIA 运行时时显示 N/A；探针只返回型号、显存总量/已用、利用率、温度和功耗的校验后摘要。

## 数据语义

指标来自 Core RPC，不从 Worker 或 Agent 沙箱采集。Docker 场景 OS 可见值可能与物理主机全量、容器限额不同。网络为可见接口累计计数，不是月流量。缺失字段显示 N/A 或说明，不能伪造为零。

原插件的月流量后台采样、阈值提醒、自定义背景上传和额外 LLM 分析尚未迁移，见 [迁移矩阵](MIGRATION.md)。没有保留无实际行为的对应开关。
