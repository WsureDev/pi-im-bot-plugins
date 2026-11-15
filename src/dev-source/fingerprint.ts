import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { SourceDirectorySchema } from './contracts'

const ignored = new Set(['node_modules', '.git', 'dist', 'API-SNAPSHOT.json', 'renderer.wasm'])
const cached = new Map<string, { stamp: string; digest: string }>()
async function fileDigest(path: string) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) {
    throw new Error('源文件类型或大小不支持：' + path)
  }
  const stamp = [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
  const old = cached.get(path)
  if (old?.stamp === stamp) {
    return old.digest
  }
  const digest = createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
  cached.set(path, { stamp, digest })
  return digest
}
export async function sourceDirectories(workspace: string) {
  const directories = await readdir(join(workspace, 'plugins'), { withFileTypes: true })
  const names: string[] = []
  for (const entry of directories) {
    if (
      entry.isDirectory() &&
      SourceDirectorySchema.safeParse(entry.name).success &&
      (await Bun.file(join(workspace, 'plugins', entry.name, 'plugin.json')).exists())
    ) {
      names.push(entry.name)
    }
  }
  if (names.length > 200) {
    throw new Error('本地源最多登记 200 个插件目录')
  }
  return names.sort()
}
export async function sourceFingerprint(workspace: string, directory: string) {
  SourceDirectorySchema.parse(directory)
  const values: Array<[string, string]> = []
  async function walk(path: string, prefix: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => {
      return a.name.localeCompare(b.name)
    })) {
      if (ignored.has(entry.name) || entry.name.startsWith('.')) {
        continue
      }
      const name = prefix + entry.name
      if (entry.isSymbolicLink()) {
        throw new Error('开发源不接受链接：' + name)
      }
      if (entry.isDirectory()) {
        await walk(join(path, entry.name), name + '/')
      } else {
        values.push([name, await fileDigest(join(path, entry.name))])
      }
      if (values.length > 2004) {
        throw new Error('开发源文件数量超过预算')
      }
    }
  }
  await walk(join(workspace, 'plugins', directory), '')
  for (const name of ['bun.lock', 'tsconfig.json', 'scripts/build.ts', 'scripts/api-snapshot.ts']) {
    values.push([name, await fileDigest(join(workspace, name))])
  }
  const snapshot = z
    .object({ digest: z.string().regex(/^[a-f0-9]{64}$/u) })
    .parse(await Bun.file(join(workspace, 'docs/bot-api/snapshot.json')).json())
  values.push(['bot-api', snapshot.digest])
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}
