import { ComfyRefusal } from './refusal'
import type { Workflow } from './catalog'
import type { Draw } from './settings'
import { SettingsSchema } from './settings'
import type { z } from 'zod'
import { chooseLoras, applyLoras } from './loras'
export function stepBindings(workflow: Workflow) {
  if (Object.keys(workflow.bindings.stepNodes).length) {
    return workflow.bindings.stepNodes
  }
  if (workflow.bindings.steps) {
    return { all: workflow.bindings.steps }
  }
  return {}
}
export function parameters(
  workflow: Workflow,
  args: Draw,
  settings: z.infer<typeof SettingsSchema>,
  seed: number,
  scopeSteps: Record<string, number> = {}
) {
  const choice = chooseLoras(workflow, args, settings.max_loras)
  if ((choice.selected.length || choice.clear) && !settings.lora_enabled) {
    throw new ComfyRefusal('此实例未启用LoRA执行')
  }
  const values: Record<string, string | number | boolean> = applyLoras(
    workflow,
    choice.selected,
    choice.clear,
    settings.keep_defaults_when_selected
  )
  const hints: string[] = []
  const seen = new Set(
    choice.prompt.split(',').map((part) => {
      return part.trim().normalize('NFKC').toLocaleLowerCase()
    })
  )
  if (settings.inject_selected_prompt_hints) {
    for (const text of choice.selected
      .flatMap((entry) => {
        return entry.hints
      })
      .flatMap((hint) => {
        return hint.split(',')
      })) {
      const clean = text.trim()
      const normalized = clean.normalize('NFKC').toLocaleLowerCase()
      if (clean && !seen.has(normalized)) {
        hints.push(clean)
        seen.add(normalized)
      }
    }
  }
  values[workflow.bindings.positive] = [...hints, choice.prompt].filter(Boolean).join(', ')
  if (workflow.bindings.negative) {
    const initial = workflow.parameters[workflow.bindings.negative]?.default
    const parts: string[] = []
    if (typeof initial === 'string' && initial.trim()) {
      parts.push(initial.trim())
    }
    for (const text of [settings.default_negative, args.negative_prompt]) {
      if (text?.trim()) {
        parts.push(text.trim())
      }
    }
    values[workflow.bindings.negative] = parts.join(', ')
  } else if (args.negative_prompt) {
    throw new ComfyRefusal('模板没有登记负词绑定')
  }
  if (workflow.bindings.seed) {
    values[workflow.bindings.seed] = seed
  }
  const steps = { ...scopeSteps }
  const bindings = stepBindings(workflow)
  if (args.steps !== undefined) {
    if (!Object.keys(bindings).length) {
      throw new ComfyRefusal('模板没有登记步骤绑定')
    }
    for (const node of Object.keys(bindings)) {
      steps[node] = args.steps
    }
  }
  Object.assign(steps, args.node_steps)
  for (const [node, value] of Object.entries(steps)) {
    const name = bindings[node]
    const parameter = workflow.parameters[name]
    if (!name || !parameter || parameter.type !== 'number') {
      throw new ComfyRefusal('步骤节点未登记到受管参数：' + node)
    }
    if (
      value < 1 ||
      value > 200 ||
      (parameter.min !== undefined && value < parameter.min) ||
      (parameter.max !== undefined && value > parameter.max)
    ) {
      throw new ComfyRefusal('步骤超出受管范围')
    }
    values[name] = value
  }
  return values
}
