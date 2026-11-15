import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { ComfyWorkflowResource as Workflow } from '../../../pi-im-bot/src/plugins/sdk/index'
import type { Path, Scalar } from './parameter'
const NumberLikeSchema = z
  .union([z.number().finite(), z.string().regex(/^-?\d+(?:\.\d+)?$/u)])
  .transform(Number)
const RowSchema = z
  .object({
    name: z.string(),
    strength: NumberLikeSchema,
    clipStrength: NumberLikeSchema.optional(),
    active: z.boolean().optional()
  })
  .passthrough()
const StackSchema = z.union([z.array(RowSchema), z.object({ __value__: z.array(RowSchema) }).passthrough()])
export function importLoraNode(
  id: string,
  node: Workflow['graph'][string],
  bindings: Workflow['bindings'],
  inventory: Map<string, Workflow['loras'][number]>,
  scalar: Scalar,
  extraLoraSlots: number,
  diagnostics: string[],
  notes: string[]
) {
  function addLora(
    namePath: Path,
    weightPath: Path,
    clipPath: Path | undefined,
    enabledPath: Path | undefined,
    name: string,
    strength: number,
    clip: number | undefined,
    enabled: boolean,
    strings: boolean
  ) {
    const index = bindings.loras.length
    if (index >= 16) {
      diagnostics.push('LoRA可绑定槽超过16项，需要operator精简或分拆模板')
      return
    }
    const nameParam = 'lora_' + index
    const weightParam = 'weight_' + index
    scalar(nameParam, [namePath], name, { maxLength: 300 })
    let encoding: 'identity' | 'number-string' = 'identity'
    if (strings) {
      encoding = 'number-string'
    }
    scalar(weightParam, [weightPath], strength, { min: -4, max: 4, encoding })
    const slot: Workflow['bindings']['loras'][number] = { name: nameParam, strength: weightParam }
    if (clipPath) {
      const clipParam = 'clip_' + index
      scalar(clipParam, [clipPath], clip ?? strength, { min: -4, max: 4, encoding })
      slot.clipStrength = clipParam
    }
    if (enabledPath) {
      const on = 'enabled_' + index
      scalar(on, [enabledPath], enabled)
      slot.enabled = on
    }
    bindings.loras.push(slot)
    if (name && name !== 'None' && name !== 'none') {
      inventory.set(name, {
        id: 'lora-' + createHash('sha256').update(name).digest('hex').slice(0, 16),
        name: name.split('/').at(-1) ?? name,
        filename: name,
        aliases: [],
        description: '',
        enabled: true,
        triggers: [],
        promptHints: [],
        strength,
        clipStrength: clip
      })
    }
  }
  if (
    /LoraLoader/u.test(node.class_type) &&
    typeof node.inputs.lora_name === 'string' &&
    typeof node.inputs.strength_model === 'number'
  ) {
    let clipPath: Path | undefined
    let clip: number | undefined
    if (typeof node.inputs.strength_clip === 'number') {
      clipPath = [id, 'inputs', 'strength_clip']
      clip = node.inputs.strength_clip
    }
    addLora(
      [id, 'inputs', 'lora_name'],
      [id, 'inputs', 'strength_model'],
      clipPath,
      undefined,
      node.inputs.lora_name,
      node.inputs.strength_model,
      clip,
      true,
      false
    )
  } else if (/lora/iu.test(node.class_type) && node.inputs.loras !== undefined) {
    const stack = StackSchema.safeParse(node.inputs.loras)
    if (!stack.success) {
      diagnostics.push('LoRA节点 ' + id + ' 使用不支持的stack形状，需要operator登记显式绑定')
      return
    }
    let prefix: Path = [id, 'inputs', 'loras']
    let rawRows: z.infer<ReturnType<typeof z.json>>[]
    let wrapper: Record<string, z.infer<ReturnType<typeof z.json>>> | undefined
    if (Array.isArray(node.inputs.loras)) {
      rawRows = z.array(z.json()).parse(node.inputs.loras)
    } else {
      wrapper = z.record(z.string(), z.json()).parse(node.inputs.loras)
      rawRows = z.array(z.json()).parse(wrapper.__value__)
      prefix = [...prefix, '__value__']
    }
    const extra = extraLoraSlots
    const stringStrength = rawRows.some((row) => {
      return typeof z.record(z.string(), z.unknown()).parse(row).strength === 'string'
    })
    const count = Math.min(extra, 16 - rawRows.length)
    for (let spare = 0; spare < count; spare += 1) {
      if (stringStrength) {
        rawRows.push({ name: '', strength: '0', clipStrength: '0', active: false, expanded: false })
      } else {
        rawRows.push({ name: '', strength: 0, clipStrength: 0, active: false, expanded: false })
      }
    }
    if (count > 0) {
      notes.push('LoRA节点' + id + '的受管副本增加' + count + '个关闭空槽；原文件不变')
    }
    if (wrapper) {
      node.inputs.loras = { ...wrapper, __value__: rawRows }
    } else {
      node.inputs.loras = rawRows
    }
    const rows = z.array(RowSchema).parse(rawRows)
    for (const [index, row] of rows.entries()) {
      let originalValue: unknown
      if (Array.isArray(node.inputs.loras)) {
        originalValue = node.inputs.loras[index]
      } else {
        originalValue = z.object({ __value__: z.array(z.unknown()) }).parse(node.inputs.loras).__value__[
          index
        ]
      }
      const original = z.record(z.string(), z.unknown()).parse(originalValue)
      let clipPath: Path | undefined
      let enabledPath: Path | undefined
      if (row.clipStrength !== undefined) {
        clipPath = [...prefix, index, 'clipStrength']
      }
      if (row.active !== undefined) {
        enabledPath = [...prefix, index, 'active']
      }
      addLora(
        [...prefix, index, 'name'],
        [...prefix, index, 'strength'],
        clipPath,
        enabledPath,
        row.name,
        row.strength,
        row.clipStrength,
        row.active ?? true,
        typeof original.strength === 'string'
      )
    }
  }
}
