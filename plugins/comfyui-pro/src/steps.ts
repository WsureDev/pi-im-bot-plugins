import { z } from 'zod'
import type { PluginContext } from '@pi-im-bot/plugin-sdk'
import { catalog } from './catalog'
import { readState, updateState } from './state'
import { ScopePolicySchema, SettingsSchema } from './settings'
import { stepBindings } from './parameters'
import { commandTokens } from './draw-command'
export async function manageSteps(context: PluginContext, value: string) {
  const settings = SettingsSchema.parse(context.invocation.settings)
  const scope = (
    await readState(context, 'scope', 'comfy.policy', ScopePolicySchema, ScopePolicySchema.parse({}))
  ).value
  const id = scope.workflow ?? settings.default_workflow
  const workflow = (await catalog(context, id)).find((entry) => {
    return entry.id === id
  })
  if (!workflow) {
    throw new Error('请先选择已绑定的工作流')
  }
  const bindings = stepBindings(workflow)
  const tokens = commandTokens(value).map((token) => {
    return token.value
  })
  if (!tokens.length || ['list', 'status'].includes(tokens[0])) {
    return {
      text:
        '工作流 ' +
        workflow.id +
        ' 步数覆盖：' +
        JSON.stringify(scope.stepOverrides[workflow.id] ?? {}) +
        '\n允许节点/参数：' +
        JSON.stringify(bindings),
      artifactIds: []
    }
  }
  if (tokens.length === 1 && /^\d+$/u.test(tokens[0])) {
    const number = tokens[0]
    tokens.splice(
      0,
      1,
      ...Object.keys(bindings).flatMap((node) => {
        return [node, number]
      })
    )
  }
  const clear = tokens.length === 1 && tokens[0] === 'clear'
  const changes: Record<string, number | null> = {}
  if (!clear) {
    if (!tokens.length || tokens.length % 2) {
      throw new Error('用法：/comfy_add list|clear|节点 步数 [节点 步数]；off取消单节点')
    }
    for (let index = 0; index < tokens.length; index += 2) {
      const node = tokens[index]
      const parameter = workflow.parameters[bindings[node]]
      if (!parameter || parameter.type !== 'number') {
        throw new Error('节点没有受管步骤绑定：' + node)
      }
      const requested = tokens[index + 1]
      if (['off', '0', 'del', 'delete', 'rm', 'remove'].includes(requested)) {
        changes[node] = null
        continue
      }
      if (!/^\d+$/u.test(requested)) {
        throw new Error('步骤必须为1–200整数或off')
      }
      const count = z.number().int().min(1).max(200).parse(Number(requested))
      if (
        (parameter.min !== undefined && count < parameter.min) ||
        (parameter.max !== undefined && count > parameter.max)
      ) {
        throw new Error('步骤超出此参数受管范围')
      }
      changes[node] = count
    }
  }
  const updated = await updateState(context, 'scope', 'comfy.policy', ScopePolicySchema, scope, (current) => {
    const values = { ...current.stepOverrides[workflow.id] }
    if (clear) {
      for (const node of Object.keys(values)) {
        delete values[node]
      }
    } else {
      for (const [node, count] of Object.entries(changes)) {
        if (count === null) {
          delete values[node]
        } else {
          values[node] = count
        }
      }
    }
    return { ...current, stepOverrides: { ...current.stepOverrides, [workflow.id]: values } }
  })
  return {
    text:
      '工作流 ' +
      workflow.id +
      ' 步数覆盖已保存：' +
      JSON.stringify(updated.value.stepOverrides[workflow.id]),
    artifactIds: []
  }
}
