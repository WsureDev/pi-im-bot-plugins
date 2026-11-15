import { join, resolve } from 'node:path'
import { z } from 'zod'
import { frameworkDirectory } from './framework'

const name = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/u)
  .parse(process.argv[2] ?? 'status')
const args = [
  process.execPath,
  '--no-env-file',
  join(frameworkDirectory(), 'scripts/pack-plugin.ts'),
  join(import.meta.dir, '../plugins', name)
]
if (process.argv[3]) {
  args.push(resolve(process.argv[3]))
}
const child = Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' })
if ((await child.exited) !== 0) {
  throw new Error('插件校验或打包失败，请先运行 build')
}
