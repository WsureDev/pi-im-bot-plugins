# Hook、呈现与插件编排

「插件 → 编排」由实际调用点共用的节点声明生成，可查看输入/输出 JSON Schema、可写字段和已接入处理器。保存启停/优先级会改变真实调用顺序，依赖及 before/after 仍优先。纯指令/工具插件没有自动流程页；当前六个切入点及未开放阶段见 Bot 主仓库 `docs/framework/plugin-product-and-capabilities.md`。

Hook 独立于模型工具。处理器声明绑定 point 后，由 Core 在固定阶段调度，不能通过任意消息监听器修改共享对象。每个 handler 有独立 `hook:plugin:<实例>/<id>` 权限。

## 六个核心切入点

| point / mode                     | 输入                                                            | 输出与用途                                                             |
| -------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| context.collect@1 / collect      | `{text}`，已投影的本轮请求，最多 20000 字符；可信范围在 context | `{fragments:[{key,text}]}`；有来源和总预算的参考上下文，不改 Pi 原历史 |
| delivery.visibility@1 / policy   | DeliveryView                                                    | `{allow, reason?}`；任一有效拒绝使本次隐藏，不能被后续允许覆盖         |
| delivery.text@1 / transform      | DeliveryView                                                    | 带 baseRevision 的 patch；仅允许改 `/text`                             |
| delivery.presentation@1 / select | 文字处理后的 DeliveryView                                       | `{text,artifactIds}`、`{render:{operation,arguments}}` 或 null；按序第一个有效非空呈现器接管             |
| delivery.receipt@1 / observe     | 交付事实，见下文                                                | 通常不返回业务结果；可以安排本次已确认回复的持久撤回                   |
| message.recorded@1 / observe     | `{message}`，规范化后的当前范围消息                             | 观察普通消息，不要求启动 Agent，不阻塞消息记录者                       |

DeliveryView 字段：id、roomId、address、conversationId、origin、phase、text、artifactIds。origin 是 im/command/schedule/job/tool/admin，phase 是 final/intermediate/progress/tool-direct/notification/control。

回执输入字段：phase、id（交付账本 ID）、messageId（逻辑消息 UUID）、state、text（实际呈现文字）、originalText、artifactIds、platformMessageIds。state 可以为准备/已准备/隐藏/失败/发送中/已发送/未知对应的 preparing/prepared/suppressed/failed/sending/sent/unknown，不能把所有回执都当作发送成功。

## 按字段变换

manifest 中：

```json
{
  "id": "tidy",
  "point": "delivery.text@1",
  "mode": "transform",
  "writes": ["/text"],
  "priority": 10,
  "timeoutMs": 1000,
  "onError": "skip"
}
```

实现：

```ts
import { definePlugin, replaceText } from '@pi-im-bot/plugin-sdk'
import { z } from 'zod'

const ViewSchema = z.object({ text: z.string() })

export default definePlugin({
  hooks: {
    tidy(input, context) {
      const view = ViewSchema.parse(input)
      return replaceText(context, view.text.replace(/\n{3,}/gu, '\n\n'))
    }
  }
})
```

replaceText 返回 `{baseRevision: context.invocation.inputRevision, patch:[{op:'set',path:'/text',value:…}]}`。Core 核对输入版本、point 可写范围、handler.writes 和完整输出类型；一个非法字段会使整份 patch 失败，不留下部分修改。数组删除需要数组整体写权限，不能靠位移改掉不属于自己的字段。

## 呈现与撤回各自处理自己的阶段

语音呈现器挂 delivery.presentation 读取已整理文字，短时选择本实例后台 render operation；耗时语音调用与 Artifact 由受管 Job 完成。已在同步预算内准备好的媒体仍可返回 text/artifactIds。无需接管时返回 null。它不修改 Pi 原文，也不直接调用平台 send。

回执观察器只在 state=sent 时安排撤回：

```ts
await context.host('delivery.recall', {
  messageId: receipt.messageId,
  delayMs: 180000
})
```

需要 handler/实例的 delivery.recall grant 和触发人的 message_recall 权限。只能选择本次回执的逻辑消息，不能用平台 message ID 或任意群号。等待由 Core 持久任务承担，不在 Worker 内 sleep 三分钟。

主回复、插件指令、主动发送与 Job 结果进入同一交付流程。账本保留模型原文、呈现结果、产物和平台分部回执；已完成呈现恢复时复用，呈现/发送结果未知时不盲目重做。控制命令与错误提示使用核心直达路径，避免业务插件挡住 `/stop`。

## 排序、选择与失败

- before/after/requires 引用 `实例ID/handlerID`，显式依赖别名可以解析到目标实例。
- 先满足依赖关系，再按 priority 降序，最后以稳定 ID 排序。不存在“优先级大就能改所有数据”。
- selector 可限定 channels、origins、phases；范围选择、触发上限、实时权限和 disabled 还会继续过滤。
- onError 默认 skip，沿用最后有效值；fail 终止该条流程。调用方取消始终终止，不能按 skip 继续发送。
- select 是有顺序的候选链；exclusive 要求单个有效参与者。工具收纳是一个排他选定策略，不是让多个收纳插件并行争夺。

collect/policy/transform 是只读宿主上下文，不能启动外部业务操作、生成产物或额外发送；MCP 还要求 readOnlyHint。select 可发布产物和调用显式业务依赖。所有 Hook 都不能 delivery.send；后台插件 Job 和观察器也没有直接群发送服务。

“只读”约束宿主能力，不表示插件私有卷变成纯函数内存；不要把修改自己的缓存伪称为修改 Core 上下文。

## 自定义 point

拥有者在 manifest.points 声明 `prepare@1` 的 mode、inputSchema、outputSchema 和 writable。拥有者 operation/实例获准 `point:plugin.self.prepare@1` 后：

```ts
const prepared = await context.host('point:plugin.self.prepare@1', {
  value: { prompt: '业务输入' }
})
```

集成插件声明 hook.point=`plugin.<拥有者实例>.prepare@1`，按同一版本契约返回。Core 验证输入、每份完整变换值及输出；拥有者的 schema 在独立纯验证 Worker 执行，不 import 拥有者入口，不取得私有设置或数据卷。

transform 返回最终值，collect 返回 `{contributions:[{source,value}],omitted}`，select 返回首个结果或 null，policy 返回 allow/deny，exclusive 必须有有效结果，observe 返回 `{accepted,eventId?}` 并交给持久观察队列。其他插件不能手工启动你的 point，应调用公开 operation。

默认自定义 point 最多 32 handlers、256 KiB 输入/结果、10 秒总期限；单次纯 schema 验证最多 3 秒。上下文收集默认 3 秒/8000 字符；呈现总预算默认 15 秒，观察处理默认 1 秒。更长业务要改为 Job，不能靠提高一个 handler 的 timeout 延长父期限。

`delivery.presentation@1` 现支持短时返回本实例后台 operation 的 render 请求；producer/deferred/content/capabilities 由 Core 构造。详见 [受管异步呈现](managed-presentation.md)。同步发送仍要求真实 ACK。
