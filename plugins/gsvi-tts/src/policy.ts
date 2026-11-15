import { z } from 'zod'
import { join } from 'node:path'
import { rename, unlink } from 'node:fs/promises'
import type { PluginContext } from '@pi-im-bot/plugin-sdk'
import { selectedVoice, TtsSettingsSchema } from './settings'
import {shellWords,pythonDecimal} from './grammar'
import {pythonStrip} from '@pi-im-bot/plugin-sdk'

export const PolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    voice: z.string().min(1),
    max_chars: z.number().int().positive(),
    probability: z.number().int().min(0).max(100)
  })
  .strict()
export type Policy = z.infer<typeof PolicySchema>
const Usage = '用法：/usetts [on|off|list] 或 /usetts "音色名" 正整数字数 0–100概率'

export function parsePolicy(text: string) {
  let tokens: string[]
  try { tokens=shellWords(text) } catch { throw new Error(Usage) }
  if (tokens.length === 0) {
    return { action: 'status' as const }
  }
  if (tokens.length === 1) {
    const action = z.enum(['on', 'off', 'list']).safeParse(tokens[0].toLowerCase())
    if (action.success) {
      return { action: action.data }
    }
  }
  if(tokens.length!==3){throw new Error(Usage)}
  let maxChars: number
  let probability: number
  try {maxChars=pythonDecimal(tokens[1]);probability=pythonDecimal(tokens[2])}catch{throw new Error(Usage)}
  const policy = PolicySchema.safeParse({
    enabled: true,
    voice: tokens[0],
    max_chars: maxChars,
    probability
  })
  if (!policy.success) {
    throw new Error(Usage)
  }
  return { action: 'configure' as const, policy: policy.data }
}

export async function loadPolicy(context: PluginContext) {
  const file = Bun.file(join(context.dataDir, 'policy.json'))
  if (await file.exists()) {
    return { policy: PolicySchema.parse(await file.json()), initialized: true }
  }
  const settings = TtsSettingsSchema.parse(context.invocation.settings)
  return {
    policy: PolicySchema.parse({
      enabled: false,
      voice: await selectedVoice(context),
      max_chars: settings.preset.max_chars,
      probability: settings.preset.probability
    }),
    initialized: false
  }
}

export async function savePolicy(context: PluginContext, policy: Policy) {
  context.signal.throwIfAborted()
  const path = join(context.dataDir, 'policy.json')
  const temporary = path + '.' + crypto.randomUUID() + '.tmp'
  try {
    await Bun.write(temporary, JSON.stringify(PolicySchema.parse(policy)))
    context.signal.throwIfAborted()
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export function shouldRender(policy: Policy, text: string, random: () => number = Math.random) {
  const chars = Array.from(pythonStrip(text)).length
  if (!policy.enabled || chars === 0 || chars > policy.max_chars || policy.probability === 0) {
    return false
  }
  if (policy.probability === 100) {
    return true
  }
  return random() * 100 < policy.probability
}
