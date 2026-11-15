import { ComfyRefusal } from './refusal'
import type { PluginContext } from '@pi-im-bot/plugin-sdk'
import { z } from 'zod'
import { DrawSchema, type Draw } from './settings'
import { catalog } from './catalog'
import { parameters } from './parameters'
import { checkPolicy, reserveCooldown, refundCooldown } from './policy'
import { ItemSchema, remember, type Item } from './records'
import { authority } from './state'
const HandleSchema = z.object({ count: z.number().int().min(1).max(16), direct: z.boolean() }).strict()
async function itemCall(
  context: PluginContext,
  action: 'poll' | 'recover' | 'cancel' | 'reconcile',
  item: number
) {
  const result = ItemSchema.parse(await context.host('service:render', { action, item }))
  await remember(context, result)
  return result
}
function outcome(items: Item[], direct: boolean, cancelling = false) {
  if (
    cancelling &&
    items.every((item) => {
      return item.status === 'cancelled' || item.status === 'not_started'
    })
  ) {
    return { status: 'cancelled' as const, message: '所有已知排队项已取消，未启动项不再提交' }
  }
  const succeeded = items.filter((item) => {
    return item.status === 'succeeded'
  })
  const pending = items.some((item) => {
    return item.status === 'submitted' || item.status === 'running'
  })
  if (pending) {
    return {
      status: 'pending' as const,
      handle: { count: items.length, direct },
      pollAfterMs: 1000,
      message: '已登记逐item回执，等待原任务结果'
    }
  }
  const uncertain = items.some((item) => {
    return item.status === 'outcome_unknown' || item.status === 'abandoned'
  })
  let businessStatus: 'succeeded' | 'partial' | 'failed' | 'unknown' = 'failed'
  if (succeeded.length === items.length) {
    businessStatus = 'succeeded'
  } else if (succeeded.length) {
    businessStatus = 'partial'
  } else if (uncertain) {
    businessStatus = 'unknown'
  }
  const artifacts = succeeded.flatMap((item) => {
    return item.artifactIds
  })
  let format: 'direct' | 'forward' = 'forward'
  if (direct) {
    format = 'direct'
  }
  return {
    status: 'done' as const,
    result: {
      text: `Comfy生成结果：${succeeded.length}/${items.length}项成功；业务状态${businessStatus}。未确认项不会重新提交。`,
      artifactIds: artifacts,
      format,
      itemized: true,
      businessStatus,
      factsComplete: !uncertain,
      items: items.map((item) => {
        const row: {
          item: number
          status: string
          artifactIds: string[]
          requestArtifactId?: string
          workflow?: string
          workflowDigest?: string
        } = { item: item.item, status: item.status, artifactIds: item.artifactIds }
        if (item.requestArtifactId !== undefined) {
          row.requestArtifactId = item.requestArtifactId
        }
        if (item.workflow !== undefined) {
          row.workflow = item.workflow
        }
        if (item.workflowDigest !== undefined) {
          row.workflowDigest = item.workflowDigest
        }
        return row
      })
    }
  }
}
async function prepare(input: unknown, context: PluginContext) {
  const args = DrawSchema.parse(input)
  const policy = await checkPolicy(context, args.prompt, args.negative_prompt)
  if (args.count > policy.settings.max_count) {
    throw new ComfyRefusal('批次数超过此实例限制')
  }
  const id = args.workflow ?? policy.scope.workflow ?? policy.settings.default_workflow
  const workflows = await catalog(context, id)
  const workflow = workflows.find((entry) => {
    return entry.id === id
  })
  if (!workflow) {
    throw new ComfyRefusal('请选择此服务已绑定的工作流')
  }
  const selected: Draw = { ...args }
  let seed = args.seed
  if (seed === undefined) {
    seed = crypto.getRandomValues(new Uint32Array(1))[0]
  }
  const compiled = Array.from({ length: args.count }, (_, index) => {
    return parameters(
      workflow,
      selected,
      policy.settings,
      seed + index,
      policy.scope.stepOverrides[workflow.id] ?? {}
    )
  })
  const cooldown = await reserveCooldown(context, policy.settings, policy.admin)
  return { args, compiled, workflow, cooldown }
}
export async function generate(input: unknown, context: PluginContext) {
  let plan: Awaited<ReturnType<typeof prepare>>
  try {
    plan = await prepare(input, context)
  } catch (error) {
    context.signal.throwIfAborted()
    if (error instanceof ComfyRefusal || error instanceof z.ZodError) {
      return { status: 'failed' as const, error: error.message.slice(0, 1000) }
    }
    throw error
  }
  const { args, compiled, workflow, cooldown } = plan
  const items: Item[] = []
  let attempted = false
  try {
    for (const [item, values] of compiled.entries()) {
      context.signal.throwIfAborted()
      const result = ItemSchema.parse(
        await context.host('service:render', {
          action: 'submit',
          item,
          workflow: workflow.id,
          parameters: values
        })
      )
      attempted ||= result.attempted
      items.push(result)
      await remember(context, result)
    }
    return outcome(items, args.direct_send)
  } catch (error) {
    context.signal.throwIfAborted()
    if (!(await authority(context)).includes('comfy_generate')) {
      throw error
    }
    if (!attempted) {
      let knownUnused = true
      try {
        for (let item = 0; item < args.count; item += 1) {
          const receipt = ItemSchema.parse(await context.host('service:render', { action: 'peek', item }))
          if (receipt.status !== 'not_started' && !(receipt.status === 'failed' && !receipt.attempted)) {
            knownUnused = false
          }
        }
      } catch {
        knownUnused = false
      }
      if (knownUnused) {
        await refundCooldown(context, cooldown.token)
      }
    }
    throw error
  }
}
export async function poll(input: unknown, context: PluginContext) {
  const { handle } = z.object({ handle: HandleSchema }).strict().parse(input)
  const items = []
  for (let item = 0; item < handle.count; item += 1) {
    items.push(await itemCall(context, 'poll', item))
  }
  return outcome(items, handle.direct)
}
export async function recover(input: unknown, context: PluginContext) {
  const { input: original, intent } = z
    .object({
      input: DrawSchema,
      handle: z.unknown(),
      intent: z.enum(['resume', 'cancel', 'reconcile']).default('resume')
    })
    .strict()
    .parse(input)
  const items = []
  let action: 'recover' | 'cancel' | 'reconcile' = 'recover'
  if (intent === 'reconcile') {
    action = 'reconcile'
  }
  if (intent === 'cancel') {
    action = 'cancel'
  }
  for (let item = 0; item < original.count; item += 1) {
    items.push(await itemCall(context, action, item))
  }
  return outcome(items, original.direct_send, intent === 'cancel')
}
export async function cancel(input: unknown, context: PluginContext) {
  const { handle } = z.object({ handle: HandleSchema }).strict().parse(input)
  const items = []
  for (let item = 0; item < handle.count; item += 1) {
    items.push(await itemCall(context, 'cancel', item))
  }
  return outcome(items, handle.direct, true)
}
