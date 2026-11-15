import { parameterWriter, type Path } from './parameter'
import { importLoraNode } from './lora-nodes'
import { mergeLoraManifest } from './lora-manifest'
import { z } from 'zod'
import {
  ComfyWorkflowResourceSchema,
  ComfyGraphSchema as GraphSchema,
  resourceRisks,
  type ComfyWorkflowResource as Workflow
} from '../../../pi-im-bot/src/plugins/sdk/index'
import { createHash } from 'node:crypto'
export interface ImportMapping {
  positive?: Path[]
  negative?: Path[]
  outputs?: string[]
  extraLoraSlots?: number
}
export function convertWorkflow(
  filename: string,
  raw: unknown,
  sidecar: unknown = {},
  mapping: ImportMapping = {}
) {
  const risks = [...resourceRisks(raw, 'workflow'), ...resourceRisks(sidecar, 'manifest')]
  if (risks.length) {
    return { diagnostics: risks }
  }
  const graphResult = GraphSchema.safeParse(raw)
  if (!graphResult.success) {
    return { diagnostics: ['不是受支持的API-format graph；需要operator明确导出API格式'] }
  }
  const graph = graphResult.data
  const parameters: Workflow['parameters'] = {}
  const bindings: Workflow['bindings'] = { positive: 'positive', stepNodes: {}, loras: [] }
  const diagnostics: string[] = []
  const notes: string[] = []
  const inventory = new Map<string, Workflow['loras'][number]>()
  const models: Workflow['models'] = []
  const scalar = parameterWriter(parameters)
  function pathsFor(reference: unknown, visited = new Set<string>()): Path[] {
    const link = z.tuple([z.string(), z.number()]).safeParse(reference)
    if (!link.success || visited.has(link.data[0])) {
      return []
    }
    const id = link.data[0]
    visited.add(id)
    const node = graph[id]
    if (!node) {
      return []
    }
    const direct: Path[] = []
    for (const key of [
      'text',
      'text_g',
      'text_l',
      'opt_text',
      'string',
      'text_positive',
      'positive',
      'prompt',
      'wildcard_text'
    ]) {
      if (typeof node.inputs[key] === 'string') {
        direct.push([id, 'inputs', key])
      }
    }
    if (direct.length) {
      return direct
    }
    if (typeof node.inputs.value === 'string' && /primitive|string|parameterbreak/iu.test(node.class_type)) {
      return [[id, 'inputs', 'value']]
    }
    return Object.values(node.inputs).flatMap((value) => {
      return pathsFor(value, visited)
    })
  }
  const positive: Path[] = []
  const negative: Path[] = []
  const seedPaths: Path[] = []
  for (const [id, node] of Object.entries(graph)) {
    if (node.inputs.positive !== undefined) {
      positive.push(...pathsFor(node.inputs.positive))
    }
    if (node.inputs.negative !== undefined) {
      negative.push(...pathsFor(node.inputs.negative))
    }
    for (const key of ['seed', 'noise_seed']) {
      if (typeof node.inputs[key] === 'number') {
        seedPaths.push([id, 'inputs', key])
      }
    }
    for (const key of ['steps', 'steps_total']) {
      let path: Path = [id, 'inputs', key]
      let value = node.inputs[key]
      let controlId = id
      const link = z.tuple([z.string(), z.number()]).safeParse(value)
      if (link.success) {
        const target = graph[link.data[0]]
        if (target) {
          for (const candidate of ['value', 'steps', 'int']) {
            if (typeof target.inputs[candidate] === 'number') {
              path = [link.data[0], 'inputs', candidate]
              value = target.inputs[candidate]
              controlId = link.data[0]
              break
            }
          }
        }
      }
      if (typeof value === 'number') {
        const name = 'steps_' + controlId.replace(/[^a-zA-Z0-9_-]/gu, '_')
        scalar(name, [path], value, { min: 1, max: 200, integer: true })
        bindings.stepNodes[controlId] = name
      }
    }
    for (const [input, role] of [
      ['ckpt_name', 'checkpoint'],
      ['unet_name', 'diffusion'],
      ['vae_name', 'vae'],
      ['clip_name', 'clip'],
      ['control_net_name', 'controlnet']
    ] as const) {
      const value = node.inputs[input]
      if (typeof value === 'string') {
        models.push({ role, filename: value })
      }
    }
    importLoraNode(id, node, bindings, inventory, scalar, mapping.extraLoraSlots ?? 4, diagnostics, notes)
  }
  function unique(paths: Path[]) {
    return [
      ...new Map(
        paths.map((path) => {
          return [JSON.stringify(path), path]
        })
      ).values()
    ]
  }
  function initial(path: Path): string {
    const id = String(path[0])
    const key = String(path[2])
    const value = graph[id]?.inputs[key]
    if (typeof value !== 'string') {
      return ''
    }
    return value
  }
  const positives = unique(mapping.positive ?? positive)
  const negatives = unique(mapping.negative ?? negative)
  if (!positives.length) {
    diagnostics.push('不能明确推断正向文本输入；需 --mapping positive 路径')
  } else {
    scalar('positive', positives, initial(positives[0]), { maxLength: 16000 })
  }
  if (negatives.length) {
    bindings.negative = 'negative'
    scalar('negative', negatives, initial(negatives[0]), { maxLength: 16000 })
  }
  if (seedPaths.length) {
    bindings.seed = 'seed'
    scalar('seed', unique(seedPaths), 0, {
      min: 0,
      max: 9007199254740991,
      integer: true,
      offsets: unique(seedPaths).map((_path, index) => {
        return index
      })
    })
  }
  mergeLoraManifest(inventory, sidecar, diagnostics)
  const outputs =
    mapping.outputs ??
    Object.entries(graph)
      .filter(([, node]) => {
        return node.class_type === 'SaveImage'
      })
      .map(([id]) => {
        return id
      })
  for (const [nodeId, node] of Object.entries(graph)) {
    if (/saveimagewebsocket/iu.test(node.class_type)) {
      notes.push(
        'WS输出' + nodeId + '不受本history/view协议支持，未将其登记为文件输出；operator需审查/重配此节点'
      )
    }
  }
  if (!outputs.length) {
    diagnostics.push(
      '没有history/view可读取的SaveImage输出；SaveImageWebsocket不能作为文件输出。需operator重配输出节点'
    )
  }
  const candidate = {
    id: 'wf-' + createHash('sha256').update(filename).digest('hex').slice(0, 20),
    name: filename.slice(0, 100),
    description: '由 ' + filename + ' 只读转换；参数/输入输出绑定需operator审查，未验证生产模型或GPU执行。',
    graph,
    parameters,
    bindings,
    outputs,
    models,
    loras: [...inventory.values()]
  }
  if (diagnostics.length) {
    return { diagnostics }
  }
  const parsed = ComfyWorkflowResourceSchema.safeParse(candidate)
  if (!parsed.success) {
    return {
      diagnostics: parsed.error.issues.map((issue) => {
        return issue.path.join('.') + ': ' + issue.message
      })
    }
  }
  return { workflow: parsed.data, diagnostics: [], notes }
}
