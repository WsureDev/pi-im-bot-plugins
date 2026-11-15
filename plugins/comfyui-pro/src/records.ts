import { z } from 'zod'
import type { PluginContext } from '@pi-im-bot/plugin-sdk'
import { readState, updateState } from './state'
import { join } from 'node:path'
import { unlink } from 'node:fs/promises'
export const ItemSchema = z.object({
  item: z.number().int(),
  recordId: z.string().optional(),
  attempted: z.boolean(),
  status: z.enum([
    'not_started',
    'submitted',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'outcome_unknown',
    'abandoned'
  ]),
  hasReceipt: z.boolean(),
  artifactIds: z.array(z.string()),
  requestArtifactId: z.string().optional(),
  workflow: z.string().optional(),
  workflowDigest: z.string().optional(),
  error: z.string().optional()
})
export type Item = z.infer<typeof ItemSchema>
const RecordSchema = ItemSchema.extend({ at: z.number() })
const RingSchema = z.object({ records: z.array(RecordSchema).max(20) })
export async function remember(context: PluginContext, item: Item) {
  if (!item.attempted || !item.recordId || !item.requestArtifactId) {
    return
  }
  const stored = await readState(context, 'scope', 'comfy.records', RingSchema, { records: [] })
  if (
    stored.value.records.some((entry) => {
      return entry.recordId === item.recordId
    })
  ) {
    await updateState(context, 'scope', 'comfy.records', RingSchema, { records: [] }, (ring) => {
      return {
        records: ring.records.map((entry) => {
          if (entry.recordId === item.recordId) {
            return { ...entry, ...item }
          }
          return entry
        })
      }
    })
    return
  }
  await updateState(
    context,
    'scope',
    'comfy.records',
    RingSchema,
    { records: [] },
    (ring) => {
      if (
        ring.records.some((entry) => {
          return entry.recordId === item.recordId
        })
      ) {
        return ring
      }
      return { records: [...ring.records, { ...item, at: Date.now() }].slice(-20) }
    },
    item.item
  )
}
export async function recordOperation(input: unknown, context: PluginContext) {
  const args = z
    .object({
      action: z.enum(['list', 'pop']).default('list'),
      count: z.number().int().min(1).max(20).default(1)
    })
    .strict()
    .parse(input)
  let records: z.infer<typeof RecordSchema>[] = []
  let remaining = 0
  if (args.action === 'pop') {
    await updateState(context, 'scope', 'comfy.records', RingSchema, { records: [] }, (ring) => {
      records = ring.records.slice(0, args.count)
      remaining = ring.records.length - records.length
      return { records: ring.records.slice(records.length) }
    })
  } else {
    records = (await readState(context, 'scope', 'comfy.records', RingSchema, { records: [] })).value.records
    remaining = records.length
  }
  if (!records.length) {
    return { text: '当前没有提交JSON记录。', artifactIds: [] }
  }
  const parts: string[] = []
  for (const record of records) {
    const chunks: Uint8Array[] = []
    let offset = 0
    for (;;) {
      const chunk = z
        .object({ base64: z.string(), hasMore: z.boolean(), bytes: z.number(), offset: z.number() })
        .parse(await context.host('artifact.read', { id: record.requestArtifactId, offset, limit: 196608 }))
      const bytes = Buffer.from(chunk.base64, 'base64')
      chunks.push(bytes)
      offset += bytes.length
      if (!chunk.hasMore) {
        break
      }
      if (offset > 600000) {
        throw new Error('提交记录超过导出额度')
      }
    }
    parts.push(JSON.stringify({ record, payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
  }
  const path = 'comfy-records-' + crypto.randomUUID() + '.json'
  try {
    await Bun.write(join(context.dataDir, path), '[' + parts.join(',') + ']')
    const artifact = z.object({ id: z.string() }).parse(
      await context.host('artifact.publish', {
        path,
        name: 'comfy-records.json',
        mimeType: 'application/json'
      })
    )
    return {
      text: `已导出${records.length}条实际派发尝试JSON（含状态，记录不等于远端成功）；队列剩余${remaining}条。`,
      artifactIds: [artifact.id]
    }
  } finally {
    await unlink(join(context.dataDir, path)).catch(() => {})
  }
}
