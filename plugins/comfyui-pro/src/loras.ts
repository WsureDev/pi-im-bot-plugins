import { ComfyRefusal } from './refusal'
import type { Workflow } from './catalog'
import type { Draw } from './settings'
interface Selection {
  entry: Workflow['loras'][number]
  strength: number
  clipStrength: number
  hints: string[]
}
function normalize(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replaceAll('\\', '/')
    .replace(/\.safetensors$/u, '')
}
function lookup(workflow: Workflow, name: string) {
  return workflow.loras.filter((entry) => {
    return [
      entry.id,
      entry.name,
      entry.filename,
      entry.filename.split('/').at(-1) ?? '',
      ...entry.aliases
    ].some((alias) => {
      return normalize(alias) === normalize(name)
    })
  })
}
export function chooseLoras(workflow: Workflow, args: Draw, maximum: number) {
  const picks = [...args.loras]
  let clear = args.clear_defaults
  const prompt = args.prompt
    .replace(/<lora\s+picks=(["'])(.*?)\1\s*\/?\s*>/giu, (_match: string, _quote: string, text: string) => {
      for (const token of text.split(',')) {
        const value = token.trim()
        if (value === '!clear_defaults') {
          clear = true
          continue
        }
        const parts = /^(.*?)(?::(-?\d+(?:\.\d+)?))?(?:@(\d+(?:\+\d+)*))?$/u.exec(value)
        if (!parts || !parts[1]) {
          throw new ComfyRefusal('LoRA选择语法错误')
        }
        const pick: Draw['loras'][number] = { name: parts[1] }
        if (parts[2]) {
          pick.strength = Number(parts[2])
        }
        if (parts[3]) {
          pick.triggers = parts[3].split('+').map(Number)
        }
        picks.push(pick)
      }
      return ''
    })
    .trim()
  const selected: Selection[] = []
  const seen = new Set<string>()
  for (const pick of picks) {
    const matches = lookup(workflow, pick.name)
    if (matches.length !== 1 || !matches[0].enabled) {
      throw new ComfyRefusal('LoRA不存在、名称有歧义或已禁用')
    }
    const entry = matches[0]
    if (seen.has(entry.id)) {
      continue
    }
    seen.add(entry.id)
    const strength = pick.strength ?? entry.strength
    if (!Number.isFinite(strength) || strength < -4 || strength > 4) {
      throw new ComfyRefusal('LoRA强度超出范围')
    }
    let hints: string[] = []
    if (pick.triggers?.length) {
      hints = [...new Set(pick.triggers)].map((index) => {
        const text = entry.triggers[index - 1]
        if (!text) {
          throw new ComfyRefusal('LoRA触发词候选不存在')
        }
        return text
      })
    } else if (entry.promptHints.length) {
      hints = entry.promptHints
    } else if (entry.triggers.length === 1) {
      hints = [entry.triggers[0]]
    }
    selected.push({
      entry,
      strength,
      clipStrength: pick.clip_strength ?? entry.clipStrength ?? strength,
      hints
    })
  }
  if (selected.length > maximum) {
    throw new ComfyRefusal('LoRA选择数量超过实例限制')
  }
  return { prompt, selected, clear }
}
export function applyLoras(workflow: Workflow, selected: Selection[], clear: boolean, keepDefaults: boolean) {
  const values: Record<string, string | number | boolean> = {}
  const occupied = new Map<string, number>()
  const claimed = new Set<number>()
  const preserve = !clear && (keepDefaults || selected.length === 0)
  for (const [index, slot] of workflow.bindings.loras.entries()) {
    const name = workflow.parameters[slot.name]?.default
    const weight = workflow.parameters[slot.strength]?.default
    let clip: unknown = weight
    if (slot.clipStrength) {
      clip = workflow.parameters[slot.clipStrength]?.default
    }
    let enabled = true
    if (slot.enabled) {
      enabled = workflow.parameters[slot.enabled]?.default !== false
    }
    let defaults: Workflow['loras'] = []
    if (typeof name === 'string') {
      defaults = lookup(workflow, name)
    }
    if (defaults.length > 1) {
      throw new ComfyRefusal('模板默认LoRA名称有歧义，请登记完整文件名')
    }
    const disabled = defaults.some((entry) => {
      return !entry.enabled
    })
    const active = typeof name === 'string' && name.length > 0 && enabled && (weight !== 0 || clip !== 0)
    if (preserve && active && !disabled) {
      let canonical = name
      if (defaults.length === 1) {
        canonical = defaults[0].filename
      }
      const id = normalize(canonical)
      if (occupied.has(id)) {
        throw new ComfyRefusal('模板默认LoRA重复，请审查默认槽位')
      }
      occupied.set(id, index)
      claimed.add(index)
    } else if (clear || disabled || (selected.length > 0 && !keepDefaults)) {
      values[slot.strength] = 0
      if (slot.clipStrength) {
        values[slot.clipStrength] = 0
      }
      if (slot.enabled) {
        values[slot.enabled] = false
      }
    }
  }
  for (const pick of selected) {
    const key = normalize(pick.entry.filename)
    let index = occupied.get(key)
    if (index === undefined) {
      index = workflow.bindings.loras.findIndex((_slot, slot) => {
        return !claimed.has(slot)
      })
      if (index < 0) {
        throw new ComfyRefusal('保留默认LoRA后没有足够的受管槽位')
      }
      claimed.add(index)
      occupied.set(key, index)
    }
    const slot = workflow.bindings.loras[index]
    if (!slot.clipStrength && pick.clipStrength !== pick.strength) {
      throw new ComfyRefusal('模板没有独立CLIP强度绑定，不能丢弃差异强度')
    }
    values[slot.name] = pick.entry.filename
    values[slot.strength] = pick.strength
    if (slot.clipStrength) {
      values[slot.clipStrength] = pick.clipStrength
    }
    if (slot.enabled) {
      values[slot.enabled] = true
    }
  }
  return values
}
