import { definePlugin, textResult, type PluginContext } from '@pi-im-bot/plugin-sdk'
import { z } from 'zod'
import { generate, poll, recover, cancel } from './generate'
import { catalogPage } from './catalog'
import { manage, parseDraw } from './commands'
import { recordOperation } from './records'
import { readState } from './state'
import { ScopePolicySchema, SettingsSchema } from './settings'
const EmptySchema = z.object({}).strict()
const Usage = `ComfyUI：Pi按需编写提示词并调用generate，未获得结果不要重复调用。/画图 提示词 [--workflow ID] [--steps N] [-c 1..16] [--neg 负词] 使用合并转发；/画图no 使用逐图直发。平台不支持forward时Core在发送前明确降级为direct，未知forward不会重发。\n工具参数prompt/negative_prompt/workflow/count/steps/seed/loras/clear_defaults/direct_send；提示词无需URL或HTML编码。LoRA可用名称/文件名，强度-4..4，triggers为1起始索引；也支持<lora picks="name:0.8@1+2,!clear_defaults">。库存仅来自受管模板manifest，无宿主scan。\n/history开关：/comfy_history on|off|status。关闭时模型后续请求投影隐藏本插件generate工具参数，保留用户原消息、Pi原审计和恢复receipt。\n/comfy_record list 或 pop COUNT：导出ring20的实际派发JSON及状态，FIFO pop不删除Core恢复receipt。\n管理指令/comfy_lock、/comfy_use、/comfy_steps、/违禁级别，需要Core显式comfy_manage授权，昵称与Mock标签不授予管理员。`
export default definePlugin({
  operations: {
    generate,
    poll,
    recover,
    cancel,
    manage,
    record: recordOperation,
    async usage(input, context) {
      EmptySchema.parse(input)
      const settings = SettingsSchema.parse(context.invocation.settings)
      return textResult(
        Usage +
          '\n当前限制：' +
          JSON.stringify({
            maxCount: settings.max_count,
            maxLoras: settings.max_loras,
            loraEnabled: settings.lora_enabled
          })
      )
    },
    async workflows(input, context) {
      const args = z
        .object({
          workflow: z.string().optional(),
          section: z.enum(['workflows', 'parameters', 'models', 'loras']).default('workflows'),
          cursor: z.number().int().min(0).max(10000).default(0)
        })
        .strict()
        .parse(input)
      const page = await catalogPage(context, args.workflow, args.section, args.cursor)
      const text = JSON.stringify(page)
      if (text.length <= 10000) {
        return textResult(text)
      }
      const artifact = z.object({ id: z.string() }).parse(
        await context.host('artifact.write', {
          name: 'comfy-catalog-page.json',
          mimeType: 'application/json',
          encoding: 'text',
          data: text
        })
      )
      return textResult(
        '目录页共' +
          page.items.length +
          '项；总量' +
          page.total +
          '。完整当前页见scope Artifact。下一游标：' +
          String(page.nextCursor ?? '结束'),
        [artifact.id]
      )
    }
  },
  parsers: {
    draw(input) {
      return parseDraw(input.text, false)
    },
    draw_direct(input) {
      return parseDraw(input.text, true)
    },
    workflows(input) {
      if (input.text.trim()) {
        return { workflow: input.text.trim() }
      }
      return {}
    },
    history(input) {
      return { action: 'history', value: input.text.trim() || 'status' }
    },
    lock(input) {
      return { action: 'lock', value: input.text.trim() || 'status' }
    },
    sensitive(input) {
      return { action: 'sensitive', value: input.text.trim() || 'status' }
    },
    workflow(input) {
      return { action: 'workflow', value: input.text.trim() || 'status' }
    },
    add_steps(input) {
      return { action: 'steps', value: input.text.trim() || 'list' }
    },
    steps(input) {
      return { action: 'steps', value: input.text.trim() || 'status' }
    },
    record(input) {
      const parts = input.text.trim().split(/\s+/u)
      let action = 'list'
      let count = 1
      if (parts[0]) {
        action = parts[0]
      }
      if (parts[1]) {
        count = Number(parts[1])
      }
      return { action, count }
    }
  },
  hooks: {
    async history(_input: unknown, context: PluginContext) {
      const scope = (
        await readState(context, 'scope', 'comfy.policy', ScopePolicySchema, ScopePolicySchema.parse({}))
      ).value
      if (scope.history) {
        return { hideArguments: [] }
      }
      return { hideArguments: ['generate'] }
    }
  }
})
