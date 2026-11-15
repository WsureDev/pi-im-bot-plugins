import { z } from 'zod'
import { CatalogReleaseSchema } from '../../../pi-im-bot/src/plugins/market/contracts'

export const SourceDirectorySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u)
export const ReleasedPackageSchema = z
  .object({
    directory: SourceDirectorySchema,
    sequence: z.number().int().positive(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    publishedAt: z.number().int(),
    bytes: z.number().int().positive(),
    entry: CatalogReleaseSchema
  })
  .strict()
export type ReleasedPackage = z.infer<typeof ReleasedPackageSchema>
export const SourceStateSchema = z
  .object({ version: z.literal(1), releases: z.array(ReleasedPackageSchema).max(1024) })
  .strict()
export type SourceState = z.infer<typeof SourceStateSchema>
export const BuildStatusSchema = z.object({
  directory: SourceDirectorySchema,
  state: z.enum(['idle', 'queued', 'building', 'ready', 'failed', 'removed']),
  updatedAt: z.number(),
  error: z.string().optional(),
  release: ReleasedPackageSchema.optional()
})
export type BuildStatus = z.infer<typeof BuildStatusSchema>
