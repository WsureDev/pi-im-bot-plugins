import { z } from 'zod'
import { gsvi, GsviInputSchema, textResult, type PluginContext } from '@pi-im-bot/plugin-sdk'
import { loadPolicy, parsePolicy, savePolicy, shouldRender } from './policy'
import { TtsSettingsSchema } from './settings'
import {listChoices,requireChoice} from './catalogue'

const PolicyInputSchema = z.object({ text: z.string() }).strict()
const ViewSchema = z.object({
  producer: z.enum([
    'agent-final',
    'scheduled-agent',
    'background-agent',
    'agent-tool',
    'plugin',
    'control',
    'unknown'
  ]),
  deferred: z.boolean(),
  content: z.enum(['plain', 'mixed']),
  text: z.string(),
  artifactIds: z.array(z.string()),
  capabilities: z.array(z.string())
})
export const RenderInputSchema = TtsSettingsSchema.omit({ preset: true })
  .extend({ text: z.string().min(1), voice: z.string().min(1) })
  .strict()

export async function policyOperation(input: unknown, context: PluginContext) {
  const command = parsePolicy(PolicyInputSchema.parse(input).text)
  const settings = TtsSettingsSchema.parse(context.invocation.settings)
  if(command.action==='list'){return listChoices(context)}
  const stored = await loadPolicy(context)
  let policy = stored.policy
  if (command.action === 'configure') {
    policy = command.policy
  }
  if (command.action === 'on') {
    policy = { ...policy, enabled: true }
  }
  if (command.action === 'off') {
    policy = { ...policy, enabled: false }
  }
  if (command.action === 'configure' || (command.action === 'on' && !stored.initialized)) {
    await requireChoice(context,policy.voice)
  }
  if (command.action !== 'status') {
    await savePolicy(context, policy)
  }
  let state = '关闭'
  if (policy.enabled) {
    state = '开启'
  }
  let source = '尚未初始化，展示预设（含已有 /voice 选择）'
  if (stored.initialized || command.action !== 'status') {
    source = '已保存的范围共享配置'
  }
  let capacity = ''
  if (context.invocation.limits?.backgroundStatelessConcurrency === 0) {
    capacity =
      '\n后台自动呈现当前不可用：至少需要 2 个业务 Worker；政策保留。工具短时呈现同样保留前台控制容量，不足时使用原文。'
  }
  return textResult(
    `本聊天范围的 TTS：${state}\n音色：${policy.voice}\n字数界限：${policy.max_chars}\n触发概率：${policy.probability}%\n配置来源：${source}${capacity}`
  )
}

export async function automatic(input: unknown, context: PluginContext) {
  const view = ViewSchema.parse(input)
  if (
    (!view.deferred && view.producer !== 'agent-tool') ||
    view.content !== 'plain' ||
    view.artifactIds.length > 0 ||
    !['agent-final', 'scheduled-agent', 'background-agent', 'agent-tool'].includes(view.producer)
  ) {
    return null
  }
  if (
    !view.capabilities.includes('tts_synthesize') ||
    !view.capabilities.includes('plugin:' + context.invocation.instanceId + '/render')
  ) {
    return null
  }
  const { policy } = await loadPolicy(context)
  if (!shouldRender(policy, view.text)) {
    return null
  }
  const settings = TtsSettingsSchema.parse(context.invocation.settings)
  return {
    render: {
      operation: 'render',
      arguments: {
        text: view.text,
        voice: policy.voice,
        version: settings.version,
        text_lang: settings.text_lang,
        emotion: settings.emotion,
        prompt_text_lang: settings.prompt_text_lang
      }
    }
  }
}

export async function render(input: unknown, context: PluginContext) {
  const args = RenderInputSchema.parse(input)
  const payload = GsviInputSchema.safeParse({
    action: 'synthesize',
    text: args.text.trim(),
    voice: args.voice,
    version: args.version,
    textLang: args.text_lang,
    emotion: args.emotion,
    promptTextLang: args.prompt_text_lang
  })
  if (!payload.success) {
    return { status: 'failed' as const, error: '呈现参数无效，保留原文' }
  }
  const result = await gsvi(context, 'speech', payload.data)
  context.signal.throwIfAborted()
  if (result.status === 'audio') {
    return textResult('', [result.artifactId], true)
  }
  if (result.status === 'failed') {
    return { status: 'failed' as const, error: '合成未完成，保留原文' }
  }
  if (result.status === 'unknown') {
    throw new Error(result.message)
  }
  throw new Error('语音服务返回类型不匹配')
}
