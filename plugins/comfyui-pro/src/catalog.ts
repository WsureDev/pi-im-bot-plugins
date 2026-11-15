import { z } from 'zod'
import type { PluginContext } from '@pi-im-bot/plugin-sdk'
const ParamSchema = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxLength: z.number()
})
const ModelSchema = z.object({ role: z.string(), filename: z.string() })
const LoraSchema = z.object({
  id: z.string(),
  name: z.string(),
  filename: z.string(),
  aliases: z.array(z.string()).default([]),
  description: z.string().default(''),
  clipStrength: z.number().optional(),
  enabled: z.boolean(),
  triggers: z.array(z.string()),
  promptHints: z.array(z.string()).default([]),
  strength: z.number()
})
const SummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  digest: z.string(),
  bindings: z.object({
    positive: z.string(),
    negative: z.string().optional(),
    seed: z.string().optional(),
    steps: z.string().optional(),
    stepNodes: z.record(z.string(), z.string()).default({}),
    loras: z.array(
      z.object({
        name: z.string(),
        strength: z.string(),
        clipStrength: z.string().optional(),
        enabled: z.string().optional()
      })
    )
  }),
  parameterCount: z.number().optional(),
  modelCount: z.number().optional(),
  loraCount: z.number().optional()
})
export const WorkflowSchema = SummarySchema.extend({
  parameters: z.record(z.string(), ParamSchema),
  models: z.array(ModelSchema),
  loras: z.array(LoraSchema)
})
export type Workflow = z.infer<typeof WorkflowSchema>
export async function catalogPage(
  context: PluginContext,
  workflow: string | undefined,
  section: 'workflows' | 'parameters' | 'models' | 'loras',
  cursor = 0
) {
  const params: { action: string; workflow?: string; section: string; cursor: number } = {
    action: 'catalog',
    section,
    cursor
  }
  if (workflow !== undefined) {
    params.workflow = workflow
  }
  return z
    .object({ items: z.array(z.unknown()), nextCursor: z.number().optional(), total: z.number() })
    .parse(await context.host('service:render', params))
}
async function all<T>(
  context: PluginContext,
  workflow: string | undefined,
  section: 'workflows' | 'parameters' | 'models' | 'loras',
  schema: z.ZodType<T>
) {
  const items: T[] = []
  let cursor = 0
  for (let page = 0; page < 128; page += 1) {
    const result = await catalogPage(context, workflow, section, cursor)
    items.push(
      ...result.items.map((item) => {
        return schema.parse(item)
      })
    )
    if (result.nextCursor === undefined) {
      return items
    }
    if (result.nextCursor <= cursor) {
      throw new Error('目录游标未前进')
    }
    cursor = result.nextCursor
  }
  throw new Error('目录分页超过单次操作预算')
}
export async function catalog(context: PluginContext, id?: string): Promise<Workflow[]> {
  const summaries = await all(context, id, 'workflows', SummarySchema)
  if (!id) {
    return summaries.map((summary) => {
      return { ...summary, parameters: {}, models: [], loras: [] }
    })
  }
  const result: Workflow[] = []
  for (const summary of summaries) {
    const parameters = await all(
      context,
      id,
      'parameters',
      z.object({ key: z.string(), definition: ParamSchema })
    )
    const models = await all(context, id, 'models', ModelSchema)
    const loras = await all(context, id, 'loras', LoraSchema)
    result.push({
      ...summary,
      parameters: Object.fromEntries(
        parameters.map((entry) => {
          return [entry.key, entry.definition]
        })
      ),
      models,
      loras
    })
  }
  return result
}
