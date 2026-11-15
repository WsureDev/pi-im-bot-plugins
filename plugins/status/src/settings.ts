import { z } from 'zod'

export const StatusSettingsSchema = z
  .object({
    bot_name: z.string().min(1).max(100).default('Pi IM Bot'),
    default_format: z.enum(['card', 'text']).default('card'),
    theme: z.enum(['teal', 'blue', 'rose']).default('teal'),
    warn_percent: z.number().int().min(50).max(100).multipleOf(5).default(85)
  })
  .strict()
export const StatusArgumentsSchema = z
  .object({ format: z.enum(['auto', 'card', 'text', 'json', 'help']).default('auto') })
  .strict()
export type StatusSettings = z.infer<typeof StatusSettingsSchema>

export function parseStatusArguments(text: string) {
  const flags: Record<string, string> = {
    '': 'auto',
    '--card': 'card',
    '--text': 'text',
    '--json': 'json',
    help: 'help',
    '--help': 'help'
  }
  const format = flags[text.trim()]
  if (!format) {
    throw new Error('用法：/状态 [--card|--text|--json|help]')
  }
  return StatusArgumentsSchema.parse({ format })
}
