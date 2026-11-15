import { mkdir, open, rename, unlink, readdir, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function atomicFile(path: string, content: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + crypto.randomUUID() + '.tmp'
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(content)
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  const directory = await open(dirname(path), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}
export async function packageBytes(root: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return 0
    }
    throw error
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error('发布目录不能包含链接')
    }
    if (entry.isDirectory()) {
      total += await packageBytes(path)
    } else {
      total += (await lstat(path)).size
    }
  }
  return total
}
