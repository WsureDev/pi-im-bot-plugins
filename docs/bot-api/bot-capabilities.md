# Bot RPC 能力参考

调用入口是 `await context.host(method, params)`，返回 unknown，使用 Zod 校验。方法、grant 与触发权限是三层不同概念；操作/handler 声明、实例允许、调用快照与当前授权共同限制使用。不存在传入群号或发言者 ID 来重新选择目标的参数。

```ts
import { RuntimeStatusSchema } from '@pi-im-bot/plugin-sdk'

const status = RuntimeStatusSchema.parse(await context.host('system.status', {}))
context.signal.throwIfAborted()
```

| 方法                        | 操作/handler 与实例需要的 grant | 参数                                       | 返回与附加限制                                                                            |
| --------------------------- | ------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| system.status               | system.status                   | 严格空对象 `{}`                            | RuntimeStatusSchema（含可选 GPU/显存摘要）；另需触发权限 runtime_status，读取 Bot 控制面可见指标 |
| history.read                | history.read                    | limit 1–100，默认 20                       | 当前范围经过投影的消息数组；另需 chat_history                                             |
| artifact.read               | artifact.read                   | id、offset≥0、limit≤196608，默认 65536     | id/mimeType/bytes/offset/base64/hasMore；仅当前范围，另需 artifact_read                   |
| artifact.write              | artifact.write                  | name、mimeType、encoding=text/base64、data | id/name/mimeType/bytes；data 最多 300000 字符，单次调用累计 12 项/8 MiB，再受统一额度约束 |
| artifact.publish            | artifact.write                  | 相对 path、可选 name、mimeType             | id/name/mimeType/bytes/sha256；从当前活动私有卷打开普通文件，不跟随符号链接，流式复制     |
| delivery.send               | delivery.send                   | text≤20000、artifactIds≤8                  | id/platformMessageIds；另需 chat_send，一次调用最多额外发送 8 次；经过统一交付            |
| delivery.recall             | delivery.recall                 | messageId、delayMs 0–86400000              | taskId；另需 message_recall，仅在已注册撤回服务的上下文可用，当前为本次已确认回执观察     |
| connector:别名              | connector:别名                  | tool、arguments 对象                       | text/artifactIds/isError；只能调用已绑定 MCP，另需对应 mcp:服务/工具 权限                 |
| operation:依赖别名/操作     | 同名 operation:… grant          | arguments、phase=execute/poll/cancel       | done/pending/failed/cancelled；需显式实例依赖与目标操作权限                               |
| point:plugin.self.名称@版本 | 同名 point:… grant              | value 对象                                 | 按 point 模式返回；只能由拥有者操作启动自己的 point                                       |

输入额外字段会被相应严格 schema 拒绝。尤其 system.status 不接受路径、环境变量、命令、任意地址或远端目标。

新增 `media.read` / `service:别名` 的参数、typed SDK、预算、授权和来源约束见 [具名 GSVI 与入站媒体](managed-media-and-speech.md)。

## 状态观测的准确含义

system.status 的 observer 固定为 bot-control-plane。返回 OS 可见 CPU/内存、swap、Bot 数据所在文件系统、可见网络接口累计计数、Bot 进程用量及插件/Provider/模型数量。GPU 摘要包含 NVIDIA 型号、显存总量/已用、利用率、温度和功耗。没有 hostname、IP、绝对路径、环境变量、配置正文或凭据。

CPU 是约 100 ms 采样并短时合并；Linux 内存优先使用 MemAvailable。网络是可见非 loopback 接口累计计数，不是月流量，也不保证排除虚拟接口重复计数。Bot 在 Docker 内时，OS 可见总量、命名空间与容器配额/物理主机全量不同；不允许把插件 Worker 或 Agent 沙箱的 os 指标冒充 Bot 主机。

runtime_status 是动作权限，不是模型工具名，不应加入工具选择或常驻工具。插件操作仍需自己的 plugin:… 权限；状态 RPC 在采集前后重验动作授权，取消或撤权后不返回迟到数据。

GPU 由 Bot 控制面用固定绝对路径和固定参数调用 `nvidia-smi`，设置 `LC_ALL=C`、1.5 秒超时和 64 KiB 输出上限；插件 Worker 不挂载 NVIDIA 设备、Docker socket，也不会收到原始命令输出。Bot 位于容器内时只会看到该容器被 NVIDIA runtime 分配的设备；没有 `nvidia-smi` 或设备时返回 `gpu: null` 与 `gpu-unavailable` 警告。

## 发布文件

```ts
import { join } from 'node:path'
import { z } from 'zod'

const ArtifactSchema = z.object({ id: z.uuid() })
await Bun.write(join(context.dataDir, 'report.txt'), '业务结果')
const artifact = ArtifactSchema.parse(
  await context.host('artifact.publish', {
    path: 'report.txt',
    name: 'report.txt',
    mimeType: 'text/plain'
  })
)
return { text: '已生成报告', artifactIds: [artifact.id] }
```

path 是相对数据目录的路径，不是宿主路径或文件句柄。写完并关闭文件再发布；发布期间文件变化会失败。发布完成后可以清理卷里的临时文件，核心的 Artifact 独立持久保存。大量二进制不要放入 JSON/base64 RPC 帧或模型文本。

统一产物默认：单文件 256 MiB、每聊天范围 1 GiB/512 项、每生产者 2 GiB/1024 项、全局 8 GiB/4096 项、并发写入 8。实际配置可能更小。路径/容量错误不能通过改 file name、producer 或 groupId 绕过。

## MCP 与插件协作

```ts
const result = await context.host('connector:images', {
  tool: 'generate_image',
  arguments: { prompt: '一张插画' }
})
```

连接器别名从实例绑定取得，插件不接收 MCP 服务 Header 或 Provider 密钥。MCP 工具还必须在当前范围选中且由触发人获准。只读 Hook 只能调用当前目录和调用时都声明 readOnlyHint=true 的 MCP 工具。

```ts
const outcome = await context.host('operation:renderer/render', {
  arguments: { text: '需要呈现的文字' },
  phase: 'execute'
})
```

跨插件保留原范围和授权上限，目标只收到自己的设置。嵌套调用有深度与资源限制；回到被占用的 Worker、环路或名额耗尽会直接失败，不能相互持锁等待。捕获失败应采取明确降级，不能未经授权换另一群、另一身份或另一个服务。

## 未开放的调用

`storage.read/write` 虽属于早期可解析 grant 字符串，目前没有对应宿主方法。文件使用自己的 dataDir，grant 不能改变卷的挂载权限。也没有直接的 `llm.generate`、`http.fetch`、`schedule.create`、`agent.delegate`、`config.save`、`render.html` 或平台 adapter RPC；不要照着内部工具服务名字构造 `context.host()` 调用。

若缺少能力，新增受管 MCP/插件服务或向框架增加有明确输入、输出、授权和期限的 RPC。不要开放整个 Bot 对象作为捷径。
