import { manageSteps } from './steps'
import { z } from 'zod'
import type { PluginContext } from '@pi-im-bot/plugin-sdk'
import { ScopePolicySchema, GlobalPolicySchema, SettingsSchema } from './settings'
import { readState, updateState } from './state'
import { catalog } from './catalog'
export const ManageSchema = z
  .object({
    action: z.enum(['history', 'lock', 'sensitive', 'workflow', 'steps']),
    value: z.string().default('status')
  })
  .strict()
export async function manage(input: unknown, context: PluginContext) {
  const { action, value } = ManageSchema.parse(input)
  if (action === 'steps') {
    return manageSteps(context, value)
  }
  const settings = SettingsSchema.parse(context.invocation.settings)
  if (action === 'lock') {
    if (!settings.lockdown_command_enabled) {
      throw new Error('此实例关闭了动态锁命令')
    }
    if (!['on', 'off', 'status'].includes(value)) {
      throw new Error('用法：/comfy_lock on|off|status')
    }
    let result = (
      await readState(context, 'instance', 'comfy.policy', GlobalPolicySchema, { locked: settings.lockdown })
    ).value
    if (value !== 'status') {
      result = (
        await updateState(context, 'instance', 'comfy.policy', GlobalPolicySchema, result, () => {
          return { locked: value === 'on' }
        })
      ).value
    }
    return { text: '实例锁定：' + String(result.locked), artifactIds: [] }
  }
  let result = (
    await readState(context, 'scope', 'comfy.policy', ScopePolicySchema, ScopePolicySchema.parse({}))
  ).value
  if (value !== 'status') {
    const next: Partial<typeof result> = {}
    if (action === 'history') {
      if (!['on', 'off'].includes(value)) {
        throw new Error('用法：/comfy_history on|off|status')
      }
      next.history = value === 'on'
    }
    if (action === 'sensitive') {
      next.sensitive = z.enum(['none', 'lite', 'full']).parse(value)
    }
    if (action === 'workflow') {
      if (
        !(await catalog(context)).some((workflow) => {
          return workflow.id === value
        })
      ) {
        throw new Error('工作流未绑定')
      }
      next.workflow = value
    }
    result = (
      await updateState(context, 'scope', 'comfy.policy', ScopePolicySchema, result, (current) => {
        return { ...current, ...next }
      })
    ).value
  }
  return {
    text:
      '本范围Comfy政策：' +
      JSON.stringify(result) +
      '\n关闭history仅过滤模型可见生成工具参数；原始审计/恢复回执保留。',
    artifactIds: []
  }
}

export { parseDraw } from './draw-command'
