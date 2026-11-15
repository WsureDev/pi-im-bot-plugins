import { resolve } from 'node:path'
import { z } from 'zod'
import { Hono } from 'hono'
import { foundationFixture } from './foundation-fixture'
import { PluginInstanceSchema } from '../../pi-im-bot/src/plugins/config'
import { importPlugin } from '../../pi-im-bot/src/plugins/package'
import { fillConfigDefaults } from '../../pi-im-bot/src/plugins/configuration/values'
import { ResourceLibrary } from '../../pi-im-bot/src/resources/library'
import { ResourcesConfigSchema } from '../../pi-im-bot/src/resources/schema'
import { WorkflowSchema, ComfyServiceSchema, GraphSchema } from '../../pi-im-bot/src/services/comfy/resources'
import { untilJob } from '../../pi-im-bot/tests/job-harness'
export function authoredWorkflow(id = 'fixture') {
  return WorkflowSchema.parse({
    id,
    name: id,
    description: 'Authored offline API-format workflow',
    graph: {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'authored-model.safetensors' } },
      '2': {
        class_type: 'LoraLoader',
        inputs: {
          model: ['1', 0],
          clip: ['1', 1],
          lora_name: 'default.safetensors',
          strength_model: 0.7,
          strength_clip: 0.7
        }
      },
      '3': {
        class_type: 'LoraLoader',
        inputs: {
          model: ['2', 0],
          clip: ['2', 1],
          lora_name: 'selected.safetensors',
          strength_model: 0,
          strength_clip: 0
        }
      },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: 'original positive', clip: ['3', 1] } },
      '5': { class_type: 'CLIPTextEncode', inputs: { text: 'original negative', clip: ['3', 1] } },
      '6': { class_type: 'EmptyLatentImage', inputs: { width: 64, height: 64, batch_size: 1 } },
      '7': {
        class_type: 'KSampler',
        inputs: {
          seed: 1,
          steps: 12,
          cfg: 7,
          sampler_name: 'euler',
          scheduler: 'normal',
          denoise: 1,
          model: ['3', 0],
          positive: ['4', 0],
          negative: ['5', 0],
          latent_image: ['6', 0]
        }
      },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['1', 2] } },
      '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'fixture' } }
    },
    parameters: {
      positive: { type: 'string', paths: [['4', 'inputs', 'text']], maxLength: 16000 },
      negative: {
        type: 'string',
        paths: [['5', 'inputs', 'text']],
        default: 'original negative',
        maxLength: 16000
      },
      seed: { type: 'number', paths: [['7', 'inputs', 'seed']], min: 0, max: 9007199254740991 },
      steps: { type: 'number', paths: [['7', 'inputs', 'steps']], min: 1, max: 200 },
      lora0: {
        type: 'string',
        paths: [['2', 'inputs', 'lora_name']],
        default: 'default.safetensors',
        maxLength: 300
      },
      weight0: {
        type: 'number',
        paths: [
          ['2', 'inputs', 'strength_model'],
          ['2', 'inputs', 'strength_clip']
        ],
        default: 0.7,
        min: -4,
        max: 4
      },
      lora1: {
        type: 'string',
        paths: [['3', 'inputs', 'lora_name']],
        default: 'selected.safetensors',
        maxLength: 300
      },
      weight1: {
        type: 'number',
        paths: [
          ['3', 'inputs', 'strength_model'],
          ['3', 'inputs', 'strength_clip']
        ],
        default: 0,
        min: -4,
        max: 4
      }
    },
    bindings: {
      positive: 'positive',
      negative: 'negative',
      seed: 'seed',
      steps: 'steps',
      stepNodes: { '7': 'steps' },
      loras: [
        { name: 'lora0', strength: 'weight0' },
        { name: 'lora1', strength: 'weight1' }
      ]
    },
    outputs: ['9'],
    models: [{ role: 'checkpoint', filename: 'authored-model.safetensors' }],
    loras: [
      {
        id: 'default',
        name: 'default',
        filename: 'default.safetensors',
        strength: 0.7,
        enabled: true,
        triggers: []
      },
      {
        id: 'selected',
        name: 'selected',
        filename: 'selected.safetensors',
        strength: 1,
        enabled: true,
        triggers: ['first trigger', 'second trigger']
      }
    ]
  })
}
const PayloadSchema = z.object({ prompt: GraphSchema, client_id: z.string() }).strict()
export async function fakeComfy() {
  let mode = 'ok'
  let unknownIndex = 1
  const tasks = new Map<
    string,
    { payload: z.infer<typeof PayloadSchema>; state: 'queued' | 'running' | 'done' }
  >()
  const calls: Array<{ method: string; path: string }> = []
  const submissions: Array<{ id: string; payload: z.infer<typeof PayloadSchema> }> = []
  const deletes: string[][] = []
  const started = Promise.withResolvers<void>()
  const submitRelease = Promise.withResolvers<void>()
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSRAAAAAASUVORK5CYII=',
    'base64'
  )
  const app = new Hono()
  app.use('*', async (c, next) => {
    calls.push({ method: c.req.method, path: new URL(c.req.url).pathname })
    if (c.req.header('authorization') !== 'Bearer AUTHORED_COMFY_PRIVATE') {
      return c.text('unauthorized', 401)
    }
    await next()
  })
  app.post('/prompt', async (c) => {
    const payload = PayloadSchema.parse(await c.req.json())
    if (mode === 'reject') {
      return c.json({ error: 'authored reject' }, 400)
    }
    const id = crypto.randomUUID()
    let state: 'queued' | 'running' = 'queued'
    if (mode === 'running') {
      state = 'running'
    }
    tasks.set(id, { payload, state })
    submissions.push({ id, payload })
    started.resolve()
    if (mode === 'hold-submit') {
      await submitRelease.promise
    }
    if (mode === 'unknown') {
      return c.text('unconfirmed submit', 503)
    }
    return c.json({ prompt_id: id })
  })
  app.get('/history/:id', (c) => {
    const id = c.req.param('id')
    const task = tasks.get(id)
    if (!task) {
      return c.json({})
    }
    const index = submissions.findIndex((item) => {
      return item.id === id
    })
    if (mode === 'partial-unknown' && index === unknownIndex) {
      return c.text('authored unavailable history', 503)
    }
    if (mode === 'partial-running' && index === unknownIndex) {
      task.state = 'running'
      return c.json({})
    }
    if (mode === 'partial-failed' && index === 1) {
      return c.json({ [id]: { status: { completed: true, status_str: 'error' }, outputs: {} } })
    }
    if (['wait', 'queued', 'running'].includes(mode)) {
      if (mode === 'running') {
        task.state = 'running'
      }
      return c.json({})
    }
    task.state = 'done'
    let filename = id + '.png'
    if (mode === 'bad-path') {
      filename = '../other-task.png'
    }
    return c.json({
      [id]: {
        status: { completed: true, status_str: 'success' },
        outputs: { '9': { images: [{ filename, subfolder: '', type: 'output' }] } }
      }
    })
  })
  app.get('/view', (c) => {
    if (mode === 'bad-mime') {
      return c.text('<html>not an image</html>')
    }
    if (mode === 'oversize') {
      return new Response(new Uint8Array(2048), { headers: { 'content-type': 'image/png' } })
    }
    return new Response(png, { headers: { 'content-type': 'image/png' } })
  })
  app.get('/queue', (c) => {
    return c.json({
      queue_running: [...tasks]
        .filter(([, task]) => {
          return task.state === 'running'
        })
        .map(([id]) => {
          return [1, id]
        }),
      queue_pending: [...tasks]
        .filter(([, task]) => {
          return task.state === 'queued'
        })
        .map(([id]) => {
          return [1, id]
        })
    })
  })
  app.post('/queue', async (c) => {
    const body = z
      .object({ delete: z.array(z.string()) })
      .strict()
      .parse(await c.req.json())
    deletes.push(body.delete)
    for (const id of body.delete) {
      const task = tasks.get(id)
      if (mode === 'delete-race' && task) {
        task.state = 'running'
      } else if (task?.state === 'queued') {
        tasks.delete(id)
      }
    }
    return c.json({})
  })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch })
  return {
    url: 'http://127.0.0.1:' + server.port,
    calls,
    submissions,
    deletes,
    tasks,
    started: started.promise,
    releaseSubmit() {
      submitRelease.resolve()
    },
    png,
    set mode(value: string) {
      mode = value
    },
    set unknownIndex(value: number) {
      unknownIndex = value
    },
    async close() {
      submitRelease.resolve()
      await server.stop(true)
    }
  }
}
export async function comfyFixture(
  reply?: Parameters<typeof foundationFixture>[0],
  runtime: Parameters<typeof foundationFixture>[1] = {}
) {
  const env = await foundationFixture(reply, { maxWorkers: 4, ...runtime })
  const remote = await fakeComfy()
  const instance = PluginInstanceSchema.parse({
    id: 'comfyui-pro',
    name: 'Comfy fixture',
    sourceDir: resolve(import.meta.dir, '../plugins/comfyui-pro'),
    enabled: true,
    grants: [
      'service:render',
      'state.read',
      'state.write',
      'authorization.inspect',
      'artifact.read',
      'artifact.write',
      'storage.write'
    ]
  })
  const bundle = await importPlugin(
    instance,
    resolve(import.meta.dir, '..'),
    env.worker.manager.paths.packageDir
  )
  instance.settings = fillConfigDefaults(bundle.configuration!, {})
  instance.settings.default_workflow = 'fixture'
  instance.settings.allowed_scopes = [env.app.room.id]
  instance.settings.cooldown_seconds = 0
  instance.settings.group_sensitive = 'none'
  instance.services = { render: 'comfy-local' }
  const library = env.app.config.resources
  env.app.config.resources = new ResourceLibrary(
    ResourcesConfigSchema.parse({
      ...library.config,
      plugins: [...library.config.plugins, instance],
      workflows: [authoredWorkflow(), authoredWorkflow('second')],
      comfyServices: [
        ComfyServiceSchema.parse({
          id: 'comfy-local',
          name: 'Fake Comfy',
          kind: 'comfy',
          enabled: true,
          url: remote.url,
          headers: { Authorization: 'Bearer AUTHORED_COMFY_PRIVATE' },
          workflows: ['fixture', 'second']
        })
      ]
    }),
    library.manifests,
    library.skillManifests,
    [...library.pluginPackages, bundle]
  )
  async function settled(id: string) {
    await untilJob(async () => {
      const job = await env.app.jobs.repository.get(id)
      return ['sent', 'unknown', 'partial', 'suppressed', 'none'].includes(job.revisions['1'].delivery)
    }, 'comfy result not settled')
    return (await env.app.jobs.repository.get(id)).revisions['1']
  }
  const applied = env.app.config.resources.config.plugins.find((entry) => {
    return entry.id === instance.id
  })!
  return {
    ...env,
    remote,
    instance: applied,
    bundle,
    settled,
    async close() {
      await remote.close()
      await env.close()
    }
  }
}

export async function manageComfy(
  env: Awaited<ReturnType<typeof comfyFixture>>,
  input: { action: string; value?: string },
  roomId = env.app.room.id
) {
  const { localIdentity } = await import('../../pi-im-bot/src/permissions/identity')
  if (
    !env.app.config.framework.defaults.permissions.rules.some((rule) => {
      return rule.capabilities.includes('comfy_manage') && rule.effect === 'allow'
    })
  ) {
    env.app.config.framework.defaults.permissions.rules.push({
      effect: 'allow',
      capabilities: ['comfy_manage'],
      subjects: [{ kind: 'local' }]
    })
  }
  const invocation = env.app.coordinator.jobInvocation(
    roomId,
    localIdentity('web', 'operator'),
    'manage authored policy'
  )
  const args: { action: string; value?: string } = { action: input.action }
  if (input.value !== undefined) {
    args.value = input.value
  }
  return env.app.coordinator.plugins!.execute(
    {
      ...invocation,
      services: {
        authorize: invocation.authorize,
        history() {
          return []
        },
        async send() {
          throw new Error('admin fixture does not send')
        }
      }
    },
    'plugin:comfyui-pro/manage',
    args,
    crypto.randomUUID(),
    AbortSignal.timeout(10000)
  )
}
