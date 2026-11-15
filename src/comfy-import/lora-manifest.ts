import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { ComfyWorkflowResource as Workflow } from '../../../pi-im-bot/src/plugins/sdk/index'
const ManifestEntrySchema = z
  .object({
    aliases: z.array(z.string()).default([]),
    description: z.string().default(''),
    default_strength: z.number().optional(),
    default_clip_strength: z.number().optional(),
    trigger_options: z.array(z.string()).optional(),
    trigger_words: z.array(z.string()).optional(),
    prompt_hints: z.array(z.string()).default([]),
    enabled: z.boolean().optional(),
    disabled: z.boolean().optional()
  })
  .passthrough()
const ManifestSchema = z
  .object({ loras: z.record(z.string(), ManifestEntrySchema).default({}) })
  .passthrough()
export function mergeLoraManifest(
  inventory: Map<string, Workflow['loras'][number]>,
  sidecar: unknown,
  diagnostics: string[]
) {
  const manifest = ManifestSchema.safeParse(sidecar)
  if (!manifest.success) {
    diagnostics.push('LoRA sidecar结构不支持，未忽略其内容')
  }
  if (manifest.success) {
    for (const [filename, entry] of Object.entries(manifest.data.loras)) {
      let prior = inventory.get(filename)
      if (!prior) {
        const matches = [...inventory.values()].filter((entry) => {
          return entry.filename.split('/').at(-1) === filename.split('/').at(-1)
        })
        if (matches.length > 1) {
          diagnostics.push('LoRA sidecar文件名有歧义，需要operator使用完整相对名称')
          continue
        }
        prior = matches[0]
      }
      if (prior) {
        inventory.delete(prior.filename)
      }
      const value: Workflow['loras'][number] = {
        id: prior?.id ?? 'lora-' + createHash('sha256').update(filename).digest('hex').slice(0, 16),
        name: entry.aliases[0] ?? prior?.name ?? filename.split('/').at(-1) ?? filename,
        filename,
        aliases: entry.aliases,
        description: entry.description,
        enabled: entry.enabled !== false && !entry.disabled,
        triggers: entry.trigger_options ?? entry.trigger_words ?? [],
        promptHints: entry.prompt_hints,
        strength: entry.default_strength ?? prior?.strength ?? 1
      }
      if (prior && prior.filename !== filename && !value.aliases.includes(prior.filename)) {
        value.aliases.push(prior.filename)
      }
      if (entry.default_clip_strength !== undefined) {
        value.clipStrength = entry.default_clip_strength
      }
      inventory.set(filename, value)
    }
  }
}
