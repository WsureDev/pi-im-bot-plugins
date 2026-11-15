import { z } from 'zod'
import { join } from 'node:path'
import { rename, unlink } from 'node:fs/promises'
import type { PluginContext } from '@pi-im-bot/plugin-sdk'

export const TtsSettingsSchema = z.object({
  version: z.enum(['v1', 'v2', 'v4']).default('v4'),
  preset: z
    .object({
      voice: z.string().min(1),
      max_chars: z.number().int().positive(),
      probability: z.number().int().min(0).max(100)
    })
    .strict()
    .default({ voice: '花火', max_chars: 100, probability: 100 }),
  text_lang: z.string().min(1).default('中文'),
  emotion: z.string().min(1).default('默认'),
  prompt_text_lang: z.string().default('')
})
const SelectionSchema = z.object({ voice: z.string().min(1) }).strict()

export async function selectedVoice(context: PluginContext) {
  const file = Bun.file(join(context.dataDir, 'voice.json'))
  if (await file.exists()) {
    return SelectionSchema.parse(await file.json()).voice
  }
  return TtsSettingsSchema.parse(context.invocation.settings).preset.voice
}

export async function saveVoice(context: PluginContext, voice: string) {
  context.signal.throwIfAborted()
  const path = join(context.dataDir, 'voice.json')
  const temporary = path + '.' + crypto.randomUUID() + '.tmp'
  try {
    await Bun.write(temporary, JSON.stringify(SelectionSchema.parse({ voice })))
    context.signal.throwIfAborted()
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
