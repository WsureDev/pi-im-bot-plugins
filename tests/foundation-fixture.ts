import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { pluginFixture } from '../../pi-im-bot/tests/plugin-fixture'
import { jobHarness, untilJob } from '../../pi-im-bot/tests/job-harness'
import { wavAudio } from '../../pi-im-bot/tests/wav-fixture'
import { responsesReply } from '../../pi-im-bot/tests/responses-fixture'
import { PluginInstanceSchema } from '../../pi-im-bot/src/plugins/config'
import { importPlugin } from '../../pi-im-bot/src/plugins/package'
import { fillConfigDefaults } from '../../pi-im-bot/src/plugins/configuration/values'
import { gsviBusinessValues } from '../../pi-im-bot/src/services/gsvi/plugin-config/definition'
import { ResourceLibrary } from '../../pi-im-bot/src/resources/library'
import { ResourcesConfigSchema } from '../../pi-im-bot/src/resources/schema'
import { PluginService } from '../../pi-im-bot/src/plugins/service'
import type { JobRevision } from '../../pi-im-bot/src/jobs/schema'

export async function foundationFixture(
  reply?: Parameters<typeof jobHarness>[0],
  runtime?: Parameters<typeof pluginFixture>[0]
) {
  const worker = await pluginFixture(runtime)
  const packages = []
  const instances = []
  for (const id of ['gsvi-tts', 'media-inspect']) {
    let grants = ['service:speech', 'artifact.write', 'storage.read', 'storage.write']
    if (id === 'media-inspect') {
      grants = ['media.read', 'history.read', 'artifact.write']
    }
    const instance = PluginInstanceSchema.parse({
      id,
      name: id,
      sourceDir: resolve(import.meta.dir, '../plugins', id),
      enabled: true,
      grants
    })
    const bundle = await importPlugin(
      instance,
      resolve(import.meta.dir, '..'),
      worker.manager.paths.packageDir
    )
    instance.settings = gsviBusinessValues(bundle, fillConfigDefaults(bundle.configuration!, {}))
    packages.push(bundle)
    instances.push(instance)
  }
  let mode = 'ok'
  let posts = 0
  let modelReads = 0
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const calls: Array<{ voice: string; text: string }> = []
  const serverApp = new Hono()
  serverApp.get('/models/v4', (c) => {
    modelReads += 1
    return c.json({ models: { 花火: { 中文: ['默认'] }, 第二音色: { 中文: ['默认'] } } })
  })
  const PayloadSchema = z.object({ model_name: z.string(), text: z.string() })
  serverApp.post('/infer_single', sValidator('json', PayloadSchema), async (c) => {
    expectPrivate(c.req.header('authorization'))
    const payload = c.req.valid('json')
    calls.push({ voice: payload.model_name, text: payload.text })
    posts += 1
    started.resolve()
    if (mode === 'wait') {
      await release.promise
    }
    if (mode === 'unknown') {
      return c.text('PRIVATE_RESPONSE_SECRET', 503)
    }
    if (mode === 'reject') {
      return c.text('PRIVATE_RESPONSE_SECRET', 400)
    }
    return c.json({ msg: '合成成功', audio_url: '/audio' })
  })
  serverApp.get('/audio', () => {
    return new Response(wavAudio(), { headers: { 'content-type': 'audio/wav' } })
  })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: serverApp.fetch })
  instances[0].services = { speech: 'local-speech' }
  const library = new ResourceLibrary(
    ResourcesConfigSchema.parse({
      plugins: instances,
      services: [
        {
          id: 'local-speech',
          name: 'Local fake',
          kind: 'gsvi',
          enabled: true,
          url: 'http://127.0.0.1:' + server.port,
          headers: { Authorization: 'Bearer PRIVATE_SERVICE_SENTINEL' }
        }
      ]
    }),
    [],
    [],
    packages
  )
  const app = await jobHarness(
    reply ??
      (() => {
        return responsesReply({ kind: 'text', text: 'UNUSED_MODEL' })
      }),
    library,
    (coordinator, config) => {
      config.bot.plugins = worker.manager.config
      coordinator.plugins = new PluginService(() => {
        return config
      }, worker.manager)
    }
  )
  async function settled(id: string): Promise<JobRevision> {
    await untilJob(async () => {
      const value = (await app.jobs.repository.get(id)).revisions['1']
      return (
        ['sent', 'suppressed', 'unknown', 'partial'].includes(value.delivery) &&
        ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(value.state)
      )
    }, 'foundation job did not settle')
    return (await app.jobs.repository.get(id)).revisions['1']
  }
  return {
    app,
    worker,
    started: started.promise,
    release: () => {
      release.resolve()
    },
    calls,
    get posts() {
      return posts
    },
    get modelReads() {
      return modelReads
    },
    set mode(value: string) {
      mode = value
    },
    async latestJob() {
      return (await app.jobs.repository.list(app.room.id))[0]
    },
    settled,
    async close() {
      release.resolve()
      await app.close()
      await worker.close()
      await server.stop(true)
    }
  }
}

function expectPrivate(header: string | undefined) {
  if (header !== 'Bearer PRIVATE_SERVICE_SENTINEL') {
    throw new Error('upstream credential missing')
  }
}
