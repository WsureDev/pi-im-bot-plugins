# 受管异步呈现

`delivery.presentation@1` 保留同步选择 `{text,artifactIds}`，并支持短时返回 `{render:{operation,arguments}}`。Core 把它限定到获选 Hook **同一实例**的 background operation；插件不能选择另一个实例、Actor、目的地或身份。Hook 仍受原 `maxPresentationMs`/handler 期限限制，不在 Hook 中合成或挂后台 Promise。

仅当确实选中允许发送的异步 render 时，DeliveryService 才调用 Core 的 captureAdmission()，生成固定配置/输入/权限快照并与决定、处理器和原文/附件一起保存到 Outbox；随后，按原 outbound ID 幂等受理一个呈现 Job。Job 只执行所选 operation，最终继续原 Outbox；不会再发送一条普通 Job 通知或重跑 Agent。原文保留在 `rawReply` 和 Pi 历史，呈现只改发送副本。HTTP 普通 Outbox 投影不暴露私有 render 参数或接纳快照。

## 可信输入

Delivery View 新增 Core 构造的字段：

| 字段 | 契约 |
| --- | --- |
| producer | agent-final / scheduled-agent / background-agent / agent-tool / plugin / control / unknown |
| deferred | 当前入口是否提供受管异步呈现；false 时不能返回 render |
| content | plain 或 mixed；现有发送契约只有纯文字和 Artifact，任一 Artifact 都是 mixed |
| capabilities | 原触发/合批权限上限与当前权限检查共同允许的能力 ID，用于选择诊断，不是授权凭据 |

普通 Agent 最终回复由执行器标记；计划/后台 Agent 由 Job spec 与 schedule 元数据标记；明确 Agent 工具通知由Core的原chat_send/工具内delivery.send闭包或chat_present标记。普通插件指令和插件业务 Job 不获得 Agent 来源。未知入口默认 unknown。来源不从文本、昵称、runId 或插件参数推断。C 已提供类型化 format:forward，即使仅文字也由 Core 整条标记 mixed；当前仍不提供任意出站 mention/quote/native 平台对象。输入中的引用不会把另一个纯文字输出变成混合输出。

## 真实回执与恢复

- Agent final 和 Agent Job report 支持 deferred。根 run `presentation.state=accepted`/工具 `{delivered:false,jobId}` 表示已接纳，尚未确认平台发送。最终账本和 Job 提供 sent/partial/unknown/suppressed；UI 明示等待状态。
- `chat_present` 是新的显式 Agent 通知入口，需要 chat_present 和 chat_send。受理后不能重复发送；Core 将这两个权限连同 operation actions 固定为后续必要权限。
- 原 `chat_send` 与Agent工具内的插件 `delivery.send` 在deferred=false时参与短时呈现；Core可信agent-tool来源才允许，普通插件/指令通知不混入。选择Hook只返回计划，执行在Hook之外，最多10秒/剩余期限，失败原文，仍等待真实平台ACK。实现与恢复边界见gsvi-outgoing-parity.md。
- 一次逻辑最终回复只做一次呈现决定，不按模型 token/delta 分段合成。原决定持久后，重启不重新抽概率、不重新选择处理器；受理中断可恢复同一 Job request。提交中断按原 Job checkpoint 标 outcome_unknown，不能重新 POST。
- 语音已知失败回退原文；没有远端 receipt 的未知合成也只结束本地等待、交付一次原文，并保留 Job 的 outcome_unknown，不自动重提。取消或撤权不变成成功回退。文本回退决定一旦持久化，迟到音频没有交付所有权。
- /stop、/new、模式/目标切换沿用控制受理路径。stop 先同步取消待呈现 Outbox，再取消 Job，覆盖保存决定到 Job 受理之间的窗口。已确认/部分/未知发送沿用原账本，不自动再发。
- operation 可声明 `actions:["tts_synthesize"]` 等当前受支持的语音动作。Core 在执行和呈现交付复核原权限天花板、操作/Hook、实例 grants、服务绑定及凭据/策略版本；服务展示名变更不使执行失效。已选业务参数固定，后续 /usetts 变化仅影响新决定。

## 数据隔离与执行预算

operation `data:"none"` 只选择数据隔离：使用无私有卷的 Worker，Core 可信 foreground/background 调度各有一个无数据 lane/key；同一实例/聊天范围在同一 lane 内串行，前后台可在原总容量内并发。数据隔离与调度分类独立，插件输入不能选择 lane。不能声明 storage.read/write，也不能 artifact.publish 私有文件。它可通过具名服务产生 Core Artifact。这样长语音合成不占用政策指令的数据 lane；无网络、只读代码、RPC 配额、期限、取消和进程隔离保持生效。普通 operation 默认 data:scope，仍按实例/聊天范围串行。

TTS 政策仍保存在实例/聊天的私有数据中。C 按 Comfy 实际需求新增 instance/scope 的最小受管 CAS 状态，见 managed-comfy.md；没有第二 Agent 引擎。

## 容量拒绝与受理未知（T 第一轮审核回修）

可选 render 的全局/范围/每 run Job 配额、或不支持的 Worker 容量，在 **JobRequests 同一幂等键**保存结构化拒绝，不创建 Job、不增加或退还配额。已有接纳或拒绝回执优先于当前容量检查。只有这类已确认未受理的结果才抛 `RenderAdmissionRejected`，由原 Outbox 保存 `renderFallback:{code,message}` 并继续正常文字/附件发送；Agent 成功与 rawReply 不变。清配额、重启均不会重新抽概率或复活呈现意图。

一般错误不能冒充明确拒绝。提交响应丢失且当前取消/授权检查仍通过时，根 run 保持完成，`presentation.state=unknown`；`chat_present` 返回 `{delivered:false,admissionUnknown:true,outboundId}`，没有伪造的 Job ID/ACK。呈现意图保留，由启动恢复按原 request 查原接纳/拒绝回执；不重跑 Agent、选择器或 GSVI POST。没有独立的呈现核对指令，未知接纳在启动恢复时核对。已接纳的 Job 仍可独立完成并更新原交付账本。取消和当前撤权会封存意图，不能转为晚到文字回退。

受管 render 必须是本实例 background + data:none 操作。只有 Core 判定为后台的无数据调用共用 `maxWorkers - 1` 的活动调用上限，仍受原总 Worker/内存/容器槽限制；后台排队也在原 maxPending 内保留前台受理余量，不能另开一套 Worker 或扩大内存。maxWorkers=1 时自动呈现不接纳且不发起合成，封存拒绝后发原文。`invocation.limits.backgroundStatelessConcurrency` 是 Core 提供的静态容量诊断，不是授权或空闲槽承诺；/usetts 状态、开关会明示不可用原因。maxWorkers=2 时最多一个后台无数据合成；默认4时最多三个后台无数据活动调用，GSVI 仍另受原两个 HTTP 并发额度。

前台余量防止后台无数据合成耗尽全部槽，并不抢占其他普通 data:scope 业务；普通同范围串行、冷启动/回收的原期限及失败保守记账继续生效。容器未完成清理时不退还实际槽，不能为追求控制延迟突破总预算。

## 按消费者声明的权限诊断

无匹配消费者时 prepare 直接保留正文/附件，零目录逐项鉴权。只有 `delivery.presentation@1` 可声明 `inspectCapabilities`（最多16项，当前支持 tts_voices/tts_synthesize 及 `plugin:self/操作`）。Core 只对这些去重后的 ID 检查原权限上限和当前授权，给该选择器的 Delivery View 最多16个 capabilities；其他 Hook 收到空列表。gsvi-tts 声明 tts_synthesize 和 plugin:self/render，不发送整个权限目录。

诊断只是当前时刻的选择提示。Hook 调用、选中操作受理、服务调用及实际交付均继续实时复核，不能把该列表当作执行凭证。声明与授权调用次数随消费者需求增长，不随无关能力目录增长；没有新数据库测试或长期授权缓存。


Core 根据固定登记的 operation.execution、真实 Job 上下文、观察任务和父调用预算确定调度类别。嵌套调用继承后台类别，调用前台依赖不能将后台父任务升级为前台。命令解析器本身按实际前台阶段执行，但保留关联操作的数据隔离；在后台上下文中的解析器仍继承后台预算。该分类仅作为 Core 内部 manager 参数，不接收插件业务参数、RPC自报 execution 或 SDK origin 作为预算凭据。

| 数据与调度 | 数据挂载 | 执行预算 |
| --- | --- | --- |
| foreground + data:none | 无私有数据挂载，artifact.publish 禁止借用同scope私有文件 | 原总 Worker/排队预算，合法 maxWorkers=1 可执行 |
| background + data:none | 同样不挂载私有数据；与前台无数据调用使用独立 Worker key/lane | 原总预算，再受 maxWorkers-1 后台活动额度约束，嵌套无容量及时失败 |
| data:scope | 原私有范围卷与同scope串行契约 | 原总预算；普通长业务不被本次修改抢占 |

limits.backgroundStatelessConcurrency 只表示后台无数据额度，不能据此推断前台 data:none 不可用。总槽在真实容器清理完成后才释放；数据隔离 key 与嵌套重入检查使用一致的实际 Worker key；无数据调用的 key 纳入可信调度类别，仍共用总 Worker/内存/队列预算，不增加私有卷。

## 按选择惰性保存恢复快照

DeliveryPresentation 使用小接口 captureAdmission(): RenderAdmission。创建 presentation 只安装该回调；DeliveryService 在选中异步 render 且允许发送时调用一次，保存原 renderAdmission。普通文字、同步媒体选择、概率未命中、混合附件跳过、可见性拒绝均不调用它、不为呈现创建配置快照、不克隆原 PreparedRunInput，也不在 Outbox 附加 renderAdmission。

已有 rendering / prepared / sent 继续复用原决定和已保存快照，恢复与幂等重入不会再次调用 captureAdmission。明确拒绝、未知接纳和发送前退出仍保留真实 render 的快照。visibility/text/receipt 继续照常运行；登记了持久 receipt 观察器时，其观察任务仍可按自身生命周期保存必要配置快照，这与 renderAdmission 无关。

短时工具呈现使用同一个Outbox，持久inlineRender状态而不创建Job/renderAdmission。Core继承原background/data:none预算，并在调用前按已受理业务调用数保留一个前台控制槽；validators独立，不能扩大总预算。进程中断不自动重新合成或群发，未知保留账本；inline消息历史保留原text，平台只接收发送副本。
