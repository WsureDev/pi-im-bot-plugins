# 独立资源 Provider、协议与指令

状态：2026-11-18 第一版实现与验证。本文取代旧 `live-control-plane.md` 中把插件操作直接当作资源的设计。已实现的范围和后续扩展分别记录，未完成项不得作为现有能力使用。

## 领域边界

资源 Provider 与插件平行存在。协议定义方法及语义，Provider 将后端接口实现为协议，资源实例保存连接与配置，插件通过绑定消费资源。资源不自动注册聊天指令、LLM Tool 或 Hook；删除消费插件不会删除资源。一个实例可实现多个协议并被多个插件使用。

框架不枚举图库、TTS、搜索等业务类型。协议有命名空间、版本、必选方法、输入/输出 JSON Schema、UI Schema 和语义说明。实现必须明确宣称兼容；相同 JSON 形状不能证明语义兼容。新协议和声明式适配定义可以导入，无须修改 Core。第三方可执行代码不得加载到 Core；当前先实现可验证的 HTTP/MCP 声明适配，再按真实需要扩展独立隔离适配器运行时。

资源实例有自己的 ID、启停、配置版本、Provider 定义和凭据。消费方只得到协议与调用句柄。模型、集合等选项可以作为配置或由只读方法发现，不强制为每个后端创建一层子资源。

## 首批接入

1. x-image：核对 `social-image-archive` 的 MCP 实现，提供 `pi.image-library@1` 的 `pick`、`facets`。适配 `pick_images`、`list_image_facets` 的 structuredContent。保留 count 截断、maxPick、实际 returned、nextCursor 和过滤语义；不把元数据 query 称为视觉搜索。`X-Archive-Max-Pick` 可在连接 Headers 中配置。无需改动原服务。
2. comfy-gateway：核对现有网关源码，其真实接口确实兼容 ComfyUI `/prompt`、`/history/:id`、`/view`；另有 `/gateway/v1/models`、`/gateway/v1/model-inventory`、`/gateway/v1/jobs/:id` 和精确 cancel。提供 `pi.comfy-gateway@1` 的 `models`、`inventory`、`submit`、`status`、`history`、`cancel`。

网关没有命名工作流模板目录，提交参数是原生 API 格式 `prompt` 图。`submit` 发送 `X-Idempotency-Key`，返回 `prompt_id` 只表示受理。后续用原 ID 查询状态与 history；空 history 不代表失败。未知结果明确报告、不自动重放；现阶段不提供断线后按幂等键查询或自动恢复提交的界面。

图库原图引用和网关 history 的图片引用统一投影为 `files`。指令或插件可要求将图片下载到当前范围的受管 Artifact，再由既有交付链发送。下载限于配置服务同源、不跟随重定向、不向其他 origin 转发凭据，超过文件预算明确失败。普通 JSON 结果保持原结构；不靠模型解释返回值。

两种实现独立于 Bot 插件安装。配置页能创建、编辑、停用、检查和调用实例；不要求先安装一个同名插件，也不要求管理台测试选择聊天房间。已有眼睛显隐秘密输入继续使用。

## 插件依赖与调用

插件声明资源别名、协议版本及需要的方法，在实例配置中绑定实际资源 ID。选择器按兼容性筛选。Host 负责绑定解析、授权、版本检查、超时取消、结果验证和凭据保密；Worker 不接触连接凭据。绑定缺失或不兼容时明确报错，不悄悄使用其他后端。

## 配置转指令

指令是资源能力的显式消费入口。管理员选择资源、协议方法，设置名称、说明、固定参数、用户文本或 JSON 参数映射及结果展示。统一复用 Bot 指令识别、权限和交付，不经过模型。JSON 输入不能覆盖固定参数；整段文字模式仅开放指定的 JSON Pointer 路径。命令冲突（含 Core、插件及其他映射）在保存时拒绝；后来安装插件产生同名冲突时调用也拒绝。停用、权限撤销及资源配置变化在派发与交付前复核。

首批入口：图库 pick/筛选与标签；网关模型清单、带固定图的任务提交、原任务状态与结果查询。新映射默认停用，由用户显式启用。生成命令先返回受理 ID，再通过状态/结果指令取回；此版本没有自动轮询后主动推送最终图片。`/stop` 停止本地等待并阻止迟到交付，不隐含远端任务已取消；远端取消使用明确的 cancel 方法。

| 指令示例 | 目标 | 参数模式 | 固定值与输出 |
| --- | --- | --- | --- |
| `/pick 猫` | gallery / `pi.image-library@1` / pick | text → `/filters/query` | `{"count":3}`，图片输出 |
| `/pick-n 5` | gallery / pick | text → `/count`，textType:number | 固定参数为空，数量仍受服务 maxPick 限制 |
| `/tags` | gallery / facets | none | `{"dimension":"tags","limit":20}` |
| `/models` | gateway / models | none | JSON 输出 |
| `/draw 一只猫` | gateway / submit | text → `/prompt/6/inputs/text` | 管理员保存完整图；节点 6 只是示例，需按实际图指定 |
| `/draw-status 任务ID` | gateway / status | text → `/id` | JSON 输出 |
| `/draw-result 任务ID` | gateway / history | text → `/id` | 图片输出 |

指令使用 `command:resource:<id>` 能力，底层使用 `resource:<instance>/<protocol>/<method>` 或原 MCP 能力；两层权限都检查。关闭模型 Tool 曝光不等于关闭直接指令。后台 MCP Tasks 继续复用已有持久 Job，不伪装成同步结果。

## 当前声明格式与接口

`resources.json` 中独立管理 `providers`（实例）、`resourceProtocols`、`providerDefinitions` 和 `resourceCommands`。前两种内置实现只是普通注册定义；自定义协议与 Provider 可通过页面导入，无需改 Core。旧 `provided` 与插件声明的兼容代码只供原有插件任务解码，新目录和调用路径不读取它们；旧 `/api/control/registry` 等插件投影入口已移除。

管理 API 为 `/api/resource-providers`，提供实例创建/启停/删除、配置及秘密读取、定义导入、方法调用、指令保存。管理台调用不要求 roomId。配置使用版本检查及原子私有文件写入，秘密字段通过专用 POST 编辑接口读取，普通目录及 GET 配置只返回秘密状态。

协议定义包含 `id`、`title`、`description`、`methods`；每个方法声明 `id`、`effect: read|write`、输入/输出 JSON Schema、可选 `inputUiSchema` 和 `example`。协议的 `@1` 是精确主版本身份；方法集合以 Provider 的明确映射和插件所需方法校验，不根据 schema 相似度推断兼容。

Provider 定义包含 `id`、`title`、`description`、`configuration`（UI Schema）及 `mappings`。连接实例至少配置 `endpoint`、`headers`（secret JSON 字符串）、`timeoutMs`。映射示例：

```json
{
  "protocol": "example.search@1",
  "method": "search",
  "inputMapping": { "/keyword": "/query" },
  "transport": {
    "kind": "http",
    "method": "GET",
    "path": "/search",
    "query": { "q": "keyword" }
  },
  "outputPath": "/data"
}
```

未给 inputMapping 时原样传参；给出时仅复制指定 JSON Pointer，缺少的可选源字段省略。outputPath 从响应选择值后再验证协议输出。HTTP 支持固定路径、`{id}` 编码占位符、查询参数和 JSON body；MCP 映射使用 `{"kind":"mcp","tool":"明确工具名"}`。第一版不执行定义中的脚本，也不自动导入任意第三方适配器代码。

请求结果是 `{requestId,value,files,artifactIds}`。JSON 方法响应限 8 MiB；大图片通过 files 读取，遵守既有 Artifact 配额。HTTP 二进制、multipart 上传、任意跨源文件、流式领域结果及复杂多步骤适配器不在本版范围内。网关上传接口、WebSocket 和 LoRA 管理没有被冒充为已接入方法。

## MCP 与资源的关系

管理 API 请求体上限为 1 MiB。协议的 read/write 描述业务副作用，不按 HTTP 动词推断；只读搜索可以使用 POST。HTTP 明确拒绝与连接中断/不完整执行响应分别处理，后者对写操作返回 `outcome: unknown` 和调用 ID。

MCP 是通信与能力发现协议；本项目资源协议是供业务代码依赖的领域契约。MCP tools 可承载操作，但 MCP resources 指 URI 标识的上下文内容，不能与本项目“资源实例”混为一谈。两者理念不冲突，却不构成无损的自动等价转换。MCP 官方明确允许 tools 通过模型之外的交互入口调用，因此直接转指令本身符合协议。

- MCP → 资源：一个独立适配定义可把明确选择的工具映射到协议方法，校验输入/输出并处理结果。不能凭工具名或说明自动宣称兼容图库/TTS协议。text-only、交互、sampling、elicitation、会话及任务等能力需要逐项处理；不支持的能力要明确拒绝。
- 资源 → MCP：适合把选定方法显式导出为 MCP tools，保留 schema、错误、产物和生命周期。副作用标注只是提示，不是授权。不是把所有方法变成 MCP resources，也不把凭据或完整管理接口导出。
- MCP → 指令：没有领域协议映射价值时，允许直接绑定已登记的 MCP tool，复用相同指令配置、权限与参数校验。无需先伪造一个领域资源。导出 MCP 服务属于单独入口配置，不能自动开放所有资源。

本版已经实现 MCP → 资源（x-image）及 MCP → 指令。前者接受 structuredContent 或唯一 JSON 文本结果，并拒绝无法无损解释的混合内容、isError 和 required Tasks；后者沿用现有 MCP 结果、Artifact 和 Tasks 处理。资源 → MCP 已完成设计分析，尚未提供对外 MCP server；后续应单独配置导出清单、调用身份与生命周期，不自动开启网络服务，也不能把异步受理误标为生成完成。

依据：[MCP Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[MCP Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)、[MCP Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)。

## 验证与实施记录

- [x] 独立声明、实例与管理 API，移除活动目录中的插件自动投影。
- [x] x-image：标签查询、单张选图的真实只读调用通过。
- [x] comfy-gateway：真实模型目录读取通过；提交/幂等键/未知结果只在自编后端验证，没有执行 GPU 生图。
- [x] 插件绑定、SDK 与权限：两个隔离插件共享资源、凭据不入 Worker、移除消费者不删除资源、撤权拒绝调用。
- [x] 配置转指令：资源与原 MCP 工具均通过 Coordinator 执行，模型请求数为 0；固定参数、冲突和权限拒绝已验证。
- [x] 管理 UI：资源创建/配置/真实选图/指令保存/刷新持久化和 390px 手机布局通过浏览器验收，未出现脚本错误；密钥使用标准密码框。
- [x] MCP 适配边界与当前可用状态。
- [x] 类型检查及生产构建通过；完整 Core 208 项、Dashboard 5 项、历史 Preview 15 项通过。最后的参数转换和迁移清理另以 15 项相关测试复核。

验证备注：并行构建期间，原 observer 的一个时序断言曾失败；该文件独立复跑和后续完整串行回归均通过，未修改该测试或观察器实现。

真实验证范围：接口发现与读取不包含重启服务、修改容器、调用收费模型、执行 GPU 生图或真实群发送。此类动态验证如未执行应逐项记载；自编协议替身不等于生产后端运行验收。
