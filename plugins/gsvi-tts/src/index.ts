import { automatic, policyOperation, render } from './automatic'
import {listChoices,requireChoice} from './catalogue'
import { definePlugin, gsvi, textResult, type PluginContext } from '@pi-im-bot/plugin-sdk'
import { z } from 'zod'
import { TtsSettingsSchema, selectedVoice, saveVoice } from './settings'

const EmptySchema = z.object({}).strict()
const VoiceSchema = z.object({ voice: z.string().trim().min(1) }).strict()
const SpeakSchema = z.object({ text: z.string().trim().min(1), voice: z.string().min(1).optional() }).strict()

export default definePlugin({
  hooks: { automatic },
  operations: {
    policy: policyOperation,
    render,
    async voices(input, context) {
      EmptySchema.parse(input)
      return listChoices(context)
    },
    async select(input, context) {
      const { voice } = VoiceSchema.parse(input)
      await requireChoice(context,voice)
      await saveVoice(context, voice)
      return textResult('本聊天范围音色已选择：' + voice)
    },
    async speak(input, context) {
      const args = SpeakSchema.parse(input)
      const settings = TtsSettingsSchema.parse(context.invocation.settings)
      const voice = args.voice ?? (await selectedVoice(context))
      const result = await gsvi(context, 'speech', {
        action: 'synthesize',
        text: args.text,
        voice,
        version: settings.version,
        textLang: settings.text_lang,
        emotion: settings.emotion,
        promptTextLang: settings.prompt_text_lang
      })
      context.signal.throwIfAborted()
      if (result.status === 'audio') {
        return textResult(args.text, [result.artifactId])
      }
      if (result.status === 'unknown') {
        throw new Error(result.message)
      }
      if (result.status === 'failed') {
        return textResult('语音合成未完成，保留原文：\n' + args.text)
      }
      throw new Error('语音服务返回类型不匹配')
    }
  }
})
