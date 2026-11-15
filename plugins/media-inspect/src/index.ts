import { definePlugin, readMedia, textResult, type PluginContext } from '@pi-im-bot/plugin-sdk'
import { z } from 'zod'
import { join } from 'node:path'
import { unlink } from 'node:fs/promises'
import { inspectMedia, MediaValidationError } from './inspect'

const InputSchema = z.object({ mediaId: z.uuid().optional(), text: z.string().max(100).optional() }).strict()
const HistorySchema = z.array(
  z.object({
    attachments: z.array(z.object({ source: z.enum(['media', 'artifact']), id: z.uuid() })).optional()
  })
)
const ArtifactSchema = z.object({ id: z.uuid() })
const limit = 2 * 1024 * 1024

async function findMedia(context: PluginContext) {
  const history = HistorySchema.parse(await context.host('history.read', { limit: 20 }))
  for (const message of history.reverse()) {
    const media = message.attachments?.find((entry) => {
      return entry.source === 'media'
    })
    if (media) {
      return media.id
    }
  }
  throw new Error('最近 20 条本范围历史没有入站附件，请提供 mediaId 或先发送附件')
}

export default definePlugin({
  operations: {
    async inspect(input, context) {
      const args = InputSchema.parse(input)
      let mediaId = args.mediaId
      if (!mediaId && args.text?.trim()) {
        mediaId = z.uuid().parse(args.text.trim())
      }
      mediaId ??= await findMedia(context)
      const metadata = await readMedia(context, { mediaId, limit: 0 })
      if (metadata.bytes > limit) {
        context.signal.throwIfAborted()
        return { status: 'failed', error: 'media-inspect 输入超过 2 MiB 上限，未发布产物' }
      }
      const chunks: Buffer[] = []
      let offset = 0
      while (offset < metadata.bytes) {
        const chunk = await readMedia(context, { mediaId, offset, limit: 131072, maxBytes: limit })
        const bytes = Buffer.from(chunk.base64, 'base64')
        if (
          !bytes.length ||
          chunk.bytes !== metadata.bytes ||
          chunk.mimeType !== metadata.mimeType ||
          chunk.offset !== offset
        ) {
          throw new Error('媒体读取结果不连续')
        }
        chunks.push(bytes)
        offset += bytes.length
      }
      const data = Buffer.concat(chunks, offset)
      let inspected: ReturnType<typeof inspectMedia>
      try {
        context.signal.throwIfAborted()
        inspected = inspectMedia(data, metadata.mimeType)
      } catch (error) {
        context.signal.throwIfAborted()
        if (error instanceof MediaValidationError) {
          return { status: 'failed', error: error.message }
        }
        throw error
      }
      const report = { mediaId, name: metadata.name, ...inspected }
      const prefix = 'inspect-' + crypto.randomUUID()
      const originalPath = prefix + '.' + report.extension
      const reportPath = prefix + '.json'
      try {
        await Bun.write(join(context.dataDir, originalPath), data)
        await Bun.write(join(context.dataDir, reportPath), JSON.stringify(report, null, 2))
        context.signal.throwIfAborted()
        const original = ArtifactSchema.parse(
          await context.host('artifact.publish', {
            path: originalPath,
            name: 'media-export.' + report.extension,
            mimeType: metadata.mimeType
          })
        )
        const artifact = ArtifactSchema.parse(
          await context.host('artifact.publish', {
            path: reportPath,
            name: 'media-inspect.json',
            mimeType: 'application/json'
          })
        )
        return textResult(
          '媒体诊断完成：' + report.format + '，' + report.bytes + ' 字节；附原始内容导出和诊断报告。',
          [original.id, artifact.id]
        )
      } finally {
        await Promise.all(
          [originalPath, reportPath].map(async (path) => {
            await unlink(join(context.dataDir, path)).catch(() => {})
          })
        )
      }
    }
  }
})
