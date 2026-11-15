import { z } from 'zod'
export const SettingsSchema = z.object({
  default_workflow: z.string().default(''),
  allowed_scopes: z.array(z.string()).default([]),
  allow_private: z.boolean().default(true),
  cooldown_seconds: z.number().int().min(0).max(3600).default(30),
  max_count: z.number().int().min(1).max(16).default(16),
  max_loras: z.number().int().min(0).max(16).default(4),
  inject_selected_prompt_hints: z.boolean().default(true),
  lora_enabled: z.boolean().default(true),
  keep_defaults_when_selected: z.boolean().default(true),
  default_negative: z.string().max(4000).default(''),
  lockdown: z.boolean().default(false),
  lockdown_command_enabled: z.boolean().default(true),
  group_sensitive: z.enum(['none', 'lite', 'full']).default('full'),
  private_sensitive: z.enum(['none', 'lite', 'full']).default('lite'),
  admin_bypass_whitelist: z.boolean().default(false),
  admin_bypass_cooldown: z.boolean().default(false),
  admin_bypass_sensitive: z.boolean().default(false)
})
export const ScopePolicySchema = z.object({
  history: z.boolean().default(false),
  workflow: z.string().optional(),
  sensitive: z.enum(['none', 'lite', 'full']).optional(),
  stepOverrides: z
    .record(z.string().max(32), z.record(z.string().max(80), z.number().int().min(1).max(200)))
    .default({})
})
export const GlobalPolicySchema = z.object({ locked: z.boolean().default(false) })
export const DrawSchema = z
  .object({
    prompt: z.string().trim().min(1).max(8000),
    negative_prompt: z.string().max(4000).optional(),
    workflow: z.string().max(32).optional(),
    count: z.number().int().min(1).max(16).default(1),
    direct_send: z.boolean().default(false),
    steps: z.number().int().min(1).max(200).optional(),
    seed: z.number().int().min(0).max(9007199254740000).optional(),
    node_steps: z.record(z.string().max(80), z.number().int().min(1).max(200)).default({}),
    clear_defaults: z.boolean().default(false),
    loras: z
      .array(
        z
          .object({
            name: z.string().min(1).max(300),
            strength: z.number().min(-4).max(4).optional(),
            clip_strength: z.number().min(-4).max(4).optional(),
            triggers: z.array(z.number().int().min(1).max(20)).max(20).optional()
          })
          .strict()
      )
      .max(16)
      .default([])
  })
  .strict()
export type Draw = z.infer<typeof DrawSchema>
