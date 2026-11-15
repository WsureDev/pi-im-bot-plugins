import { readdir, mkdir, copyFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { z } from 'zod'
import { frameworkDirectory } from './framework'
import { verifiedApiSnapshot } from './api-snapshot'

const root = join(import.meta.dir, '..')
const snapshot = await verifiedApiSnapshot()
const requested = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/u)
  .optional()
  .parse(process.argv[2])
let names = await readdir(join(root, 'plugins'))
if (requested) {
  names = [requested]
}
for (const name of names) {
  const directory = join(root, 'plugins', name)
  const entry = join(directory, 'src/index.ts')
  if (!(await Bun.file(entry).exists())) {
    continue
  }
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    format: 'esm',
    minify: true,
    plugins: [
      {
        name: 'public-bot-sdk',
        setup(build) {
          build.onResolve({ filter: /^@pi-im-bot\/plugin-sdk$/u }, () => {
            return { path: join(frameworkDirectory(), 'src/plugins/sdk/index.ts') }
          })
        }
      }
    ]
  })
  if (!result.success || result.outputs.length !== 1) {
    throw new Error(result.logs.join('\n'))
  }
  await mkdir(join(directory, 'dist'), { recursive: true })
  await Bun.write(join(directory, 'dist/index.mjs'), result.outputs[0])
  await Bun.write(join(directory, 'API-SNAPSHOT.json'), JSON.stringify(snapshot, null, 2) + '\n')
  if (name === 'status') {
    const renderer = dirname(Bun.resolveSync('@resvg/resvg-wasm', directory))
    const wasm = (await readdir(renderer)).find((file) => {
      return file.endsWith('.wasm')
    })
    if (!wasm) {
      throw new Error('渲染依赖缺少 WASM 资产')
    }
    await mkdir(join(directory, 'assets'), { recursive: true })
    await copyFile(join(renderer, wasm), join(directory, 'assets/renderer.wasm'))
  }
  console.log('Built ' + name)
}
