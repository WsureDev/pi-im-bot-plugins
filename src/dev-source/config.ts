import { z } from 'zod'
import { resolve } from 'node:path'

export const DevSourceConfigSchema = z.object({
  workspace: z.string(),
  storage: z.string(),
  publicUrl: z.url().refine((value) => {
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    )
  }),
  port: z.number().int().min(1024).max(65535),
  watch: z.boolean().default(true),
  pollMs: z.number().int().min(100).default(1000),
  debounceMs: z.number().int().min(0).default(750),
  maxHoldMs: z.number().int().min(100).default(3000),
  maxBytes: z
    .number()
    .int()
    .positive()
    .default(512 * 1024 * 1024),
  buildTimeoutMs: z.number().int().min(1000).default(60000)
})
export type DevSourceConfig = z.infer<typeof DevSourceConfigSchema>
export function devSourceConfiguration() {
  const port = z.coerce
    .number()
    .int()
    .min(1024)
    .max(65535)
    .parse(process.env.PLUGIN_SOURCE_PORT ?? 19337)
  const workspace = resolve(import.meta.dir, '../..')
  const watch = z.enum(['0', '1']).parse(process.env.PLUGIN_SOURCE_WATCH ?? '1') === '1'
  return DevSourceConfigSchema.parse({
    workspace,
    storage: resolve(workspace, '.dev-source'),
    publicUrl: process.env.PLUGIN_SOURCE_PUBLIC_URL ?? 'http://localhost:' + port,
    port,
    watch
  })
}
