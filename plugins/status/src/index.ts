import {
  definePlugin,
  artifactResult,
  textResult,
  RuntimeStatusSchema,
  type PluginContext
} from '@pi-im-bot/plugin-sdk'
import { z } from 'zod'
import { join } from 'node:path'
import { unlink } from 'node:fs/promises'
import { StatusArgumentsSchema, StatusSettingsSchema, parseStatusArguments } from './settings'
import { statusText } from './format'
import { statusCard } from './card'
import { renderCard } from './render'

const ArtifactSchema = z.object({ id: z.uuid() })
async function inspect(input: unknown, context: PluginContext) {
  const args = StatusArgumentsSchema.parse(input)
  if (args.format === 'help') {
    return textResult(
      '/状态、/sysstatus [--card|--text|--json|help]\n/status 是 Bot 内置会话状态指令。系统指标需要 runtime_status 权限。'
    )
  }
  const settings = StatusSettingsSchema.parse(context.invocation.settings)
  const snapshot = RuntimeStatusSchema.parse(await context.host('system.status', {}))
  context.signal.throwIfAborted()
  if (args.format === 'json') {
    return textResult(JSON.stringify(snapshot, null, 2))
  }
  const text = statusText(snapshot, settings.bot_name)
  let format = args.format
  if (format === 'auto') {
    format = settings.default_format
  }
  if (format === 'text') {
    return textResult(text)
  }
  const path = 'status-' + context.invocation.id + '.png'
  try {
    const png = await renderCard(statusCard(snapshot, settings))
    context.signal.throwIfAborted()
    await Bun.write(join(context.dataDir, path), png)
    const artifact = ArtifactSchema.parse(
      await context.host('artifact.publish', { path, name: 'system-status.png', mimeType: 'image/png' })
    )
    return artifactResult([artifact.id])
  } catch {
    context.signal.throwIfAborted()
    return textResult(text + '\n状态卡片未能生成或发布，已返回指标文本。')
  } finally {
    await unlink(join(context.dataDir, path)).catch(() => {})
  }
}
export default definePlugin({
  operations: { inspect },
  parsers: {
    status_args(input) {
      return parseStatusArguments(input.text)
    }
  }
})
