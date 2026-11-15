import { ComfyRefusal } from './refusal'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { PluginContext } from '@pi-im-bot/plugin-sdk'
import { readState, updateState, authority } from './state'
import { SettingsSchema, ScopePolicySchema, GlobalPolicySchema } from './settings'
const CooldownSchema = z.object({
  entries: z.array(z.object({ actor: z.string(), token: z.string(), at: z.number() })).max(128)
})
const WordsSchema = z.object({ lite: z.array(z.string()), full: z.array(z.string()) })
let words: Promise<z.infer<typeof WordsSchema>> | undefined
function dictionary() {
  words ??= Bun.file(new URL('../assets/sensitive-words.json', import.meta.url))
    .json()
    .then((value: unknown) => {
      return WordsSchema.parse(value)
    })
  return words
}
export async function policies(context: PluginContext) {
  const settings = SettingsSchema.parse(context.invocation.settings)
  const scope = (
    await readState(context, 'scope', 'comfy.policy', ScopePolicySchema, ScopePolicySchema.parse({}))
  ).value
  const global = (
    await readState(
      context,
      'instance',
      'comfy.policy',
      GlobalPolicySchema,
      GlobalPolicySchema.parse({ locked: settings.lockdown })
    )
  ).value
  const allowed = await authority(context)
  return { settings, scope, global, admin: allowed.includes('comfy_manage') }
}
export async function checkPolicy(context: PluginContext, prompt: string, negative: string | undefined) {
  const policy = await policies(context)
  const { settings, scope, global, admin } = policy
  if (global.locked && !admin) {
    throw new ComfyRefusal('Comfy实例已锁定')
  }
  if (context.invocation.scope.address.kind === 'group') {
    if (
      !settings.allowed_scopes.includes(context.invocation.scope.id) &&
      !(admin && settings.admin_bypass_whitelist)
    ) {
      throw new ComfyRefusal('此聊天范围不在Comfy白名单')
    }
  } else if (!settings.allow_private) {
    throw new ComfyRefusal('此实例未开放私聊')
  }
  let level = settings.private_sensitive
  if (context.invocation.scope.address.kind === 'group') {
    level = settings.group_sensitive
  }
  level = scope.sensitive ?? level
  if (level !== 'none' && !(admin && settings.admin_bypass_sensitive)) {
    const dictionary = await wordsFor(level)
    const text = (prompt + '\n' + (negative ?? '')).normalize('NFKC').toLocaleLowerCase()
    if (
      dictionary.some((word) => {
        const normalized = word.toLocaleLowerCase()
        if (/^[a-z0-9_ -]+$/u.test(normalized)) {
          return new RegExp(
            '(^|[^a-z0-9_])' + normalized.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '($|[^a-z0-9_])',
            'u'
          ).test(text)
        }
        return text.includes(normalized)
      })
    ) {
      throw new ComfyRefusal('提示词未通过本范围敏感词策略')
    }
  }
  return policy
}
async function wordsFor(level: 'lite' | 'full') {
  const entries = await dictionary()
  if (level === 'lite') {
    return entries.lite
  }
  return [...entries.lite, ...entries.full]
}
export async function reserveCooldown(
  context: PluginContext,
  settings: z.infer<typeof SettingsSchema>,
  admin: boolean
) {
  const token = context.invocation.parentId ?? context.invocation.id
  if (admin && settings.admin_bypass_cooldown) {
    return { token, actors: [] as string[] }
  }
  const actors = context.invocation.actors.map((actor) => {
    return createHash('sha256')
      .update(actor.origin + ':' + actor.id)
      .digest('hex')
  })
  const now = Date.now()
  await updateState(context, 'scope', 'comfy.cooldown', CooldownSchema, { entries: [] }, (value) => {
    const entries = value.entries.filter((entry) => {
      return now - entry.at < settings.cooldown_seconds * 1000
    })
    if (
      entries.some((entry) => {
        return actors.includes(entry.actor) && entry.token !== token
      })
    ) {
      throw new ComfyRefusal('Comfy请求仍在冷却期')
    }
    return {
      entries: [
        ...entries.filter((entry) => {
          return !actors.includes(entry.actor)
        }),
        ...actors.map((actor) => {
          return { actor, token, at: now }
        })
      ]
    }
  })
  return { token, actors }
}
export async function refundCooldown(context: PluginContext, token: string) {
  await updateState(context, 'scope', 'comfy.cooldown', CooldownSchema, { entries: [] }, (value) => {
    return {
      entries: value.entries.filter((entry) => {
        return entry.token !== token
      })
    }
  })
}
