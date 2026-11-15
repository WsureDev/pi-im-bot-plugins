import { z } from 'zod'
import type { PluginContext } from '@pi-im-bot/plugin-sdk'
const ReadSchema = z.object({ version: z.number().int(), value: z.unknown() })
const CompareSchema = z.object({
  applied: z.boolean(),
  version: z.number().int(),
  duplicate: z.boolean().optional()
})
export async function readState<T>(
  context: PluginContext,
  area: 'scope' | 'instance',
  key: string,
  schema: z.ZodType<T>,
  fallback: T
) {
  const result = ReadSchema.parse(await context.host('state.read', { area, key }))
  if (result.value === null) {
    return { version: result.version, value: fallback }
  }
  return { version: result.version, value: schema.parse(result.value) }
}
export async function updateState<T>(
  context: PluginContext,
  area: 'scope' | 'instance',
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
  update: (value: T) => T,
  receiptItem?: number
) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    context.signal.throwIfAborted()
    const current = await readState(context, area, key, schema, fallback)
    const value = schema.parse(update(current.value))
    const params: {
      area: string
      key: string
      version: number
      value: T
      comfyReceipt?: { alias: string; item: number }
    } = { area, key, version: current.version, value }
    if (receiptItem !== undefined) {
      params.comfyReceipt = { alias: 'render', item: receiptItem }
    }
    const result = CompareSchema.parse(await context.host('state.compare', params))
    if (result.applied) {
      return { value, duplicate: result.duplicate ?? false }
    }
  }
  throw new Error('范围状态并发更新冲突，请稍后重试')
}
export async function authority(context: PluginContext) {
  return z
    .object({ allowed: z.array(z.string()) })
    .parse(await context.host('authorization.inspect', { capabilities: ['comfy_manage', 'comfy_generate'] }))
    .allowed
}
