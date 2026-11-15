# 异步操作、数据和生命周期

GSVI 的同步 HTTP 合成使用 background operation，但协议没有持久远端句柄；中断提交标未知，不捏造 poll/cancel。详见 [具名服务与媒体](managed-media-and-speech.md)。

## 返回后台句柄

manifest.operation：

```json
{
  "id": "generate",
  "title": "生成结果",
  "description": "提交耗时工作",
  "execution": "background",
  "timeoutMs": 10000,
  "inputSchema": { "type": "object", "properties": {} },
  "poll": "poll_generation",
  "cancel": "cancel_generation"
}
```

operations 字典需实现 generate、poll_generation、cancel_generation。poll/cancel 是 generate 的处理器名字，不必再注册成对模型开放的操作。

```ts
return {
  status: 'pending',
  handle: { taskId: '服务返回的任务号' },
  pollAfterMs: 1000,
  message: '已提交'
}
```

Core 的 poll/cancel 调用输入是 `{ "handle": 之前保存的handle }`，不是直接传原 handle，也不重复传 execute 的原始参数。处理器应使用 `z.object({ handle: YourHandleSchema })` 校验。每次处理有自己的 Worker 调用期限；等待期间释放 Worker 和主会话。handle 必须 JSON 可序列化，最多受 RPC 帧预算约束；它作为私有执行记录保存，不放入普通工具结果或群消息。

完成返回 `{status:'done',result:{text,artifactIds,value?,suppressText?}}` 或普通 PluginResult。`suppressText` 只控制纯产物交付，不改变 Artifact 校验和平台能力限制。失败返回 failed/error，确认取消返回 cancelled/message。取消无法确认时不要谎报 cancelled；保持 pending/未知状态交给宿主处理。

execute 使用 operation.inputSchema；poll/cancel/recover 可分别声明阶段 schema 与 handleSchema，由 Core/SDK 校验，插件仍在边界使用 Zod。reconcile 使用 poll schema。pollAfterMs 允许 250–300000。不能在 poll 中再次调用“创建任务”接口。

## 重启和副作用

提交前保存检查点，保存原代码版本、配置、范围、授权上限及服务句柄。已确认完成的操作不重放；提交/取消结果不明确时标 outcome_unknown，不自动再发一次业务请求。只读轮询可以按原句柄继续，权限撤销、实例停用和范围切换仍然生效。

外部 API 是否支持幂等键由业务协议决定。一次 RPC 的请求去重不等于跨重启 exactly-once，不要把网络异常自动当成“服务肯定没收到”。

Job 结果由 Core 统一交付，后台 handler 没有直接 delivery.send。直接命令进入后台时先返回任务受理信息，任务完成再交付；群成员可通过 `/jobs`、`/job ID`、`/job cancel ID` 等核心指令管理。插件无需再建一个平行的全局任务表和群消息队列。

普通前台 operation 返回 pending 时会明确要求使用后台 Job，不会在前台偷偷无限等待。长时间生图、视频总结与转码应从一开始声明后台协议。

## 调用上下文

`PluginContext`：dataDir、invocation、signal、host(method,params)。invocation 包含：

- id、parentId、instanceId、generation（固定包 revision）。
- scope.id 与可信 address（channel/accountId/kind/chatId/threadId）。
- conversationId 与 conversationEpoch。
- origin、actors（最多 20 个原触发人的 ID/显示名/来源/角色）。
- settings、生效 grants、deadlineAt、inputRevision。

这些都是本次副本，不是 Bot 实例；改副本不会更新 Core 配置。调用服务时 Core 使用自己绑定的范围和身份，忽略/拒绝插件另传的冒充字段。

## 私有数据

`context.dataDir` 当前为 `/data/files`。同一实例、同一聊天范围的成员共享数据；不同实例、范围分开。版本升级保留相同实例/范围数据，切换 conversation 不等于删库。数据结构与迁移由插件负责，代码回滚不保证旧代码能读新数据。

data:scope在同一实例/范围串行，不同插件和范围可并发。data:none按Core可信前后台分lane，同一lane串行、前后台可共享原总预算并发，状态一致性由Core CAS保证。换代前回收占用同一卷的旧 Worker。Worker 可因空闲、故障、期限或资源压力回收，因此：

- 模块变量只作可丢弃缓存。
- 重要状态写到 dataDir，使用临时文件 + rename 等适合业务的一致性方式。
- 不在 import 时启动网络请求、定时器、后台 while 循环或自动注册平台监听器。
- 公开 SDK 没有 initialize/terminate 或自注册 Cron 生命周期。需要长期定时工作时申请相应框架能力，不能把 Worker 当守护进程。
- 临时生成文件发布为 Artifact 后及时清理；不要通过无限文件名把私有卷塞满。

Worker 当前关闭网络、根和代码只读、无 Docker socket、不继承宿主环境与凭据。MCP/其他服务走 Core 的已声明连接器。Agent 的 Shipyard 沙箱与插件 Worker 是不同执行域，不能借 Agent 工作目录绕过插件数据范围。

默认文件卷每范围 64 MiB、每插件实例 1 GiB、部署总计 8 GiB、最多 128 卷。磁盘满会拒绝写入，不换空目录。异常卷隔离，不能通过改源码版本重新获取一份空数据冒充恢复。

## 预算与取消

默认 4 个业务 Worker、每个 256 MiB/0.5 CPU/64 进程，64 个额外排队调用。单帧最多 512 KiB，每次调用累计接收/宿主结果各 32 MiB，最多 256 次宿主 RPC。默认空闲 60 秒回收，启动期限 30 秒。纯验证 Worker 有独立名额和最多 128 MiB。

所有 context.host Promise 必须在返回前完成或被取消。Worker 返回结果时仍有未完成宿主调用会被 Core 拒绝；fire-and-forget RPC 不是异步任务注册机制。

父期限、调用期限、运行时取消、实时撤权都可能早于业务 timeout。I/O 使用 context.signal，并在发布、发送及返回前检查。同步 WASM/CPU 工作必须自己限制输入规模；长循环无法合作取消时，Core 会定向终止 Worker。

调用超时不等待慢容器清理，未确认回收的资源仍计入名额。队列满和嵌套互等会及时失败，不能靠无限 Promise 队列拖住其他插件。

Core 的最终回复与工具直发都在每段发送前检查取消和期限，最终交付返回后再检查 run 状态。已经实际发送的内容保留回执，不声称撤回；本地取消使后续分段停止时，发送账本为 cancelled，有已确认部分的消息/Job 为 partial。真正无法确认的传输仍为 unknown。以上状态都不会触发自动重发，必要的失败说明有独立交付记录。

## 入站受理与历史保留

平台消息归档不再直接等同于已受理。消息 admission 记录 pending、dispatching、accepted、unknown、expired 或 cancelled；业务待受理集合受核心队列容量和等待期限限制。Agent 的 run 与来源消息在同一事务中关联；队列拒绝后可以重试，重启可恢复安全的 pending。stop 先持久取消调用时该范围已有的 pending，再停止已建 run；已取消输入不会因重复平台事件、旧恢复快照或重启重新执行。停止后新来的输入独立受理。`/new`、渠道模式切换和停用等调用相同 stop 路径。

`/stop`、`/new`、`/help`、`/status`、`/skills`、`/jobs`、`/job` 帮助以及 Job 查询/取消有独立即时受理名额（最多 16 个并发控制调用），不受业务 pending 拥塞阻挡；原有可信身份与动作权限检查仍生效。业务插件指令和 `/job update` 不在豁免列表。控制指令同样在副作用前持久 claim dispatch；期间退出或失败时标为不确定并等待核对，不自动重做。旧版没有 admission 元数据的归档消息继续保守去重，不猜测旧副作用是否发生。

Job 活动索引只保留未收尾任务，历史按每页 128 项归档。控制面 HTTP `GET /api/rooms/:id/jobs/history?beforePage=N` 返回 `{jobs,nextPage?}`，省略参数取最新页；它不是新增的 Worker RPC。常规列表和历史均展示当前 revision：修订激活时从历史投影移入 active，完成后归入最新页，不再复用首次完成的位置。同一 revision 的回执更新不刷新排序。历史以当前 revision 最近完成入档的顺序分页，前端使用同一列表；空页从分页链摘除，查询不会反复扫描修订留下的空洞。完整 Job UUID 可直接查询或控制旧任务；短前缀匹配限于活动与最近结果，有歧义或旧任务应使用完整 ID。

request 去重回执、run 预算、Job 正文与各 revision、配置快照文件不按年龄删除，因为 durable 工具仍可能恢复引用。修订时移动的是列表投影，不删除原任务或去重记录；内存缓存上限与最近结果 limit 都不表示磁盘存储上限。未来归档删除必须先证明恢复所有者已退休。

受管呈现 Job 与原 Outbox 共用交付所有者；`accepted` 是等待呈现状态，不能当作 sent。`data:none` 操作没有私有数据挂载，可释放政策指令的数据 lane。完整契约见 [受管异步呈现](managed-presentation.md)。

`invocation.limits.backgroundStatelessConcurrency` 是 Core 提供的 后台无数据活动调用容量元数据（maxWorkers-1），不代表当前空闲名额。1 Worker 的自动呈现明确拒绝并保留文字；已知 Job 容量拒绝与未知接纳的持久回执及 inspectCapabilities 声明详见 [受管呈现](managed-presentation.md)。

数据隔离与调度类别独立：合法 foreground + data:none 可在单 Worker 下执行，仍没有私有卷或私有文件发布能力。只有真正选中的异步 render 才通过 captureAdmission 惰性保存呈现恢复快照。

## C 的受管状态与服务恢复

[具名 ComfyUI 与恢复](managed-comfy.md) 已实现 instance/scope CAS 状态、无句柄 recover、逐阶段 input/handle schema 和具名服务回执。manifest 可声明 handleSchema、pollInputSchema、cancelInputSchema、recoverInputSchema；有声明的阶段由 Core/SDK 校验，reconcile 使用 poll 契约。data:none 与执行预算仍独立，状态 RPC 不等于挂载私有卷。后台任务结果事实不完整时可保留 outcome_unknown，与平台发送状态分开。
