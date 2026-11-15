import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { frameworkDirectory } from './framework'

const SnapshotSchema = z.object({
  apiVersion: z.literal(1),
  generatedAt: z.string(),
  digest: z.string(),
  files: z.record(z.string(), z.string())
})
export async function verifiedApiSnapshot() {
  const path = join(import.meta.dir, '../docs/bot-api/snapshot.json')
  const snapshot = SnapshotSchema.parse(await Bun.file(path).json())
  for (const [name, expected] of Object.entries(snapshot.files)) {
    const digest = createHash('sha256')
      .update(await readFile(join(frameworkDirectory(), name)))
      .digest('hex')
    if (digest !== expected) {
      throw new Error('Bot API 或文档已变化，请先运行 bun run docs:sync：' + name)
    }
  }
  return snapshot
}
