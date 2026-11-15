import { readdir, mkdir, lstat, realpath } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { convertWorkflow } from '../src/comfy-import/convert'
const args = process.argv.slice(2)
function option(name: string) {
  const index = args.indexOf(name)
  if (index < 0) {
    return undefined
  }
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error('缺少参数 ' + name)
  }
  return value
}
const directory = resolve(z.string().min(1).parse(option('--input')))
const output = option('--out')
const mapFile = option('--mapping')
const PathSchema = z.array(z.union([z.string(), z.number().int()])).min(3)
const MappingSchema = z.record(
  z.string(),
  z
    .object({
      positive: z.array(PathSchema).optional(),
      negative: z.array(PathSchema).optional(),
      outputs: z.array(z.string()).optional(),
      extraLoraSlots: z.number().int().min(0).max(15).optional()
    })
    .strict()
)
let mappings: z.infer<typeof MappingSchema> = {}
if (mapFile) {
  mappings = MappingSchema.parse(await Bun.file(resolve(mapFile)).json())
}
function inside(source: string, target: string) {
  const path = relative(source, target)
  return !isAbsolute(path) && path !== '..' && !path.startsWith('../')
}
if (output) {
  if (inside(directory, resolve(output))) {
    throw new Error('--out必须位于来源目录之外')
  }
  await mkdir(resolve(output), { recursive: true })
  if (inside(await realpath(directory), await realpath(resolve(output)))) {
    throw new Error('--out链接指向来源目录，拒绝写入')
  }
}
const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort()
async function read(name: string) {
  const path = join(directory, name)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) {
    return { diagnostics: ['只接受指定目录内<=2MiB的普通JSON文件，不读取链接或目录'] }
  }
  const bytes = await Bun.file(path).bytes()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  try {
    return { sha256, value: JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown, diagnostics: [] }
  } catch {
    return { sha256, diagnostics: ['JSON结构不能解析，未输出原始内容'] }
  }
}
const results = []
let sidecars = 0
for (const name of names) {
  try {
    const source = await read(name)
    if (name.endsWith('.lora.json') || name.endsWith('.steps.json')) {
      sidecars += 1
      results.push({ file: name, sha256: source.sha256, status: 'sidecar', diagnostics: source.diagnostics })
      continue
    }
    if (source.diagnostics.length) {
      results.push({
        file: name,
        sha256: source.sha256,
        status: 'unsupported',
        diagnostics: source.diagnostics
      })
      continue
    }
    let sidecar: unknown = {}
    const loraName = name.replace(/\.json$/u, '.lora.json')
    if (names.includes(loraName)) {
      const attached = await read(loraName)
      if (attached.diagnostics.length) {
        results.push({
          file: name,
          sha256: source.sha256,
          status: 'unsupported',
          diagnostics: ['对应LoRA sidecar无法安全解析']
        })
        continue
      }
      sidecar = attached.value
    }
    const converted = convertWorkflow(name, source.value, sidecar, mappings[name])
    let status = 'unsupported'
    if (converted.workflow) {
      status = 'ready_for_operator_review'
      if (output) {
        await Bun.write(
          join(resolve(output), converted.workflow.id + '.json'),
          JSON.stringify(converted.workflow, null, 2) + '\n'
        )
      }
    }
    results.push({
      file: name,
      sha256: source.sha256,
      status,
      id: converted.workflow?.id,
      diagnostics: converted.diagnostics,
      notes: converted.notes ?? [],
      gpuValidated: false
    })
  } catch {
    results.push({
      file: name,
      status: 'unsupported',
      diagnostics: ['文件不可安全读取/转换，未输出原始内容']
    })
  }
}
const report = {
  dryRun: true,
  applied: false,
  inputDirectory: directory,
  workflows: names.length - sidecars,
  sidecars,
  results
}
if (output) {
  await Bun.write(join(resolve(output), 'import-report.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))
