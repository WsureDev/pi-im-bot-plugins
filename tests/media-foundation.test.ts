import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { foundationFixture } from './foundation-fixture'
import { ArtifactStore } from '../../pi-im-bot/src/artifacts/store'
import { pngImage } from '../../pi-im-bot/tests/image-fixture'
import { createMockAdapter } from '../../pi-im-bot/src/channels/mock'
import { registerArtifactRoutes } from '../../pi-im-bot/src/http/artifact-routes'
import { untilJob } from '../../pi-im-bot/tests/job-harness'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'

test('actual media consumer discovers normalized attachments and exports exact bytes/report via Worker, Artifact and one delivery', async () => {
  const env = await foundationFixture()
  const { app } = env
  try {
    app.config.framework.defaults.behavior.agentEnabled = false
    const input = pngImage(32, 16)
    const attachment = await app.media.upload(app.room, new File([input], 'input.png', { type: 'image/png' }))
    await app.coordinator.receive(app.room.id, '/help', 'alice', 'Alice', [attachment.mediaId!])
    await app.coordinator.receive(app.room.id, '/media-inspect', 'bob', 'Bob')
    const job = await env.latestJob()
    const value = await env.settled(job.id)
    expect(value.state).toBe('succeeded')
    expect(value.result?.artifactIds).toHaveLength(2)
    const artifacts = new ArtifactStore(app.config.dataDir, app.room.id)
    const exported = await artifacts.content(value.result!.artifactIds[0])
    expect(Buffer.from(await exported.file.arrayBuffer()).equals(input)).toBe(true)
    const report = await artifacts.content(value.result!.artifactIds[1])
    const json = await report.file.json()
    expect(json).toMatchObject({
      mediaId: attachment.mediaId,
      width: 32,
      height: 16,
      bytes: input.length,
      sha256: createHash('sha256').update(input).digest('hex')
    })
    expect(exported.metadata.access?.mediaIds).toEqual([attachment.mediaId!])
    expect(JSON.stringify(json)).not.toContain('/tmp/')
    expect(app.requests).toHaveLength(0)
    await app.restart()
    expect(
      app.store.listOutbound(app.room.id).filter((item) => {
        return item.artifactIds.length === 2 && item.state === 'sent'
      })
    ).toHaveLength(1)
    const source = app.store.listMessages(app.room.id).find((message) => {
      return message.attachments.some((item) => {
        return item.mediaId === attachment.mediaId
      })
    })!
    app.store.saveMessage({ ...source, recalled: true })
    const http = new Hono()
    http.onError((_error, c) => {
      return c.text('source unavailable', 409)
    })
    registerArtifactRoutes(http, app.coordinator, () => {
      return app.config
    })
    expect(
      (
        await http.request(
          '/api/rooms/' + encodeURIComponent(app.room.id) + '/artifacts/' + exported.metadata.id + '/content'
        )
      ).status
    ).toBe(409)
    await expect(
      app.coordinator.delivery.send(
        app.room,
        'do not send recalled export',
        undefined,
        'assistant',
        'recalled-export',
        { artifactIds: [exported.metadata.id], authorize() {} }
      )
    ).rejects.toThrow('交付')
  } finally {
    await env.close()
  }
})

test('media consumer rejects cross-scope IDs, unsupported MIME and configured size overflow without exporting data', async () => {
  const env = await foundationFixture()
  const { app } = env
  try {
    const other = app.coordinator.createMockRoom('other', 'group')
    const foreign = await app.media.upload(other, new File(['not yours'], 'text.txt', { type: 'text/plain' }))
    const large = await app.media.upload(
      app.room,
      new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.txt', { type: 'text/plain' })
    )
    const unsupported = await app.media.upload(
      app.room,
      new File(['<svg/>'], 'input.svg', { type: 'application/xml' })
    )
    const damaged = await app.media.upload(
      app.room,
      new File(['broken WAV'], 'bad.wav', { type: 'audio/wav' })
    )
    const invalidJson = await app.media.upload(
      app.room,
      new File(['{"missing":'], 'bad.json', { type: 'application/json' })
    )
    const invalidText = await app.media.upload(
      app.room,
      new File([new Uint8Array([255, 254])], 'bad.txt', { type: 'text/plain' })
    )
    for (const [attachment, expected] of [
      [foreign, 'outcome_unknown'],
      [large, 'failed'],
      [unsupported, 'failed'],
      [damaged, 'failed'],
      [invalidJson, 'failed'],
      [invalidText, 'failed']
    ] as const) {
      await app.coordinator.receive(app.room.id, '/media-inspect ' + attachment.mediaId)
      const result = await env.settled((await env.latestJob()).id)
      expect(result.state).toBe(expected)
      expect(result.result?.artifactIds ?? []).toHaveLength(0)
    }
    expect(
      app.store.listOutbound(app.room.id).some((item) => {
        return item.artifactIds.length > 0
      })
    ).toBe(false)
  } finally {
    await env.close()
  }
})

test('an interruption after the first public artifact remains unknown with its retained artifact and no automatic export replay', async () => {
  const env = await foundationFixture()
  let publications = 0
  const open = env.worker.manager.openDataFile.bind(env.worker.manager)
  env.worker.manager.openDataFile = async (...args) => {
    publications += 1
    if (publications === 2) {
      throw new Error('authored interruption after public export')
    }
    return open(...args)
  }
  try {
    const { app } = env
    const attachment = await app.media.upload(
      app.room,
      new File(['actual export'], 'input.txt', { type: 'text/plain' })
    )
    await app.coordinator.receive(app.room.id, '/media-inspect ' + attachment.mediaId)
    const job = await env.latestJob()
    const result = await env.settled(job.id)
    expect(result.state).toBe('outcome_unknown')
    expect(
      await new ArtifactStore(app.config.dataDir, app.room.id).owned('job:' + job.id + ':1')
    ).toHaveLength(1)
    await app.restart()
    expect(publications).toBe(2)
    expect(result.result?.artifactIds ?? []).toHaveLength(0)
  } finally {
    await env.close()
  }
})

test('the supported 2 MiB limit crosses real RPC chunk boundaries and exports unchanged bytes under the existing Worker budget', async () => {
  const env = await foundationFixture()
  try {
    const { app } = env
    const bytes = Buffer.alloc(2 * 1024 * 1024, 65)
    const attachment = await app.media.upload(
      app.room,
      new File([bytes], 'bounded.txt', { type: 'text/plain' })
    )
    const started = performance.now()
    await app.coordinator.receive(app.room.id, '/media-inspect ' + attachment.mediaId)
    const result = await env.settled((await env.latestJob()).id)
    expect(result.state).toBe('succeeded')
    const exported = await new ArtifactStore(app.config.dataDir, app.room.id).content(
      result.result!.artifactIds[0]
    )
    expect(Buffer.from(await exported.file.arrayBuffer()).equals(bytes)).toBe(true)
    await writeFile(
      join(app.config.dataDir, 'media-budget-measurement.json'),
      JSON.stringify(
        {
          inputBytes: bytes.length,
          rpcChunkBytes: 131072,
          expectedDataReads: 16,
          metadataReads: 1,
          artifacts: result.result!.artifactIds.length,
          milliseconds: performance.now() - started,
          workerMemoryMiB: env.worker.manager.config.memoryMiB,
          backend: 'authored-worker-fixture',
          limitation: 'Single local fixture measurement; not a production throughput or RSS benchmark'
        },
        null,
        2
      ) + '\n'
    )
  } finally {
    await env.close()
  }
})

test('source recall after Worker processing is checked again at actual artifact publication', async () => {
  const env = await foundationFixture()
  const opened = Promise.withResolvers<void>()
  let openedFile = false
  const release = Promise.withResolvers<void>()
  const original = env.worker.manager.openDataFile.bind(env.worker.manager)
  env.worker.manager.openDataFile = async (...args) => {
    const file = await original(...args)
    openedFile = true
    opened.resolve()
    await release.promise
    return file
  }
  try {
    const { app } = env
    const attachment = await app.media.upload(
      app.room,
      new File(['processed text'], 'input.txt', { type: 'text/plain' })
    )
    await app.coordinator.receive(app.room.id, '/media-inspect ' + attachment.mediaId, 'alice', 'Alice', [
      attachment.mediaId!
    ])
    await untilJob(async () => {
      if (openedFile) {
        return true
      }
      const state = (await app.jobs.repository.get((await env.latestJob()).id)).revisions['1']
      if (state.finishedAt) {
        throw new Error('media publication did not start: ' + state.error)
      }
      return false
    }, 'media publication did not open')
    const source = app.store.listMessages(app.room.id).find((item) => {
      return item.attachments.some((entry) => {
        return entry.mediaId === attachment.mediaId
      })
    })!
    app.store.saveMessage({ ...source, recalled: true })
    release.resolve()
    const value = await env.settled((await env.latestJob()).id)
    expect(value.state).not.toBe('succeeded')
    expect(value.result?.artifactIds ?? []).toHaveLength(0)
    expect(
      await new ArtifactStore(app.config.dataDir, app.room.id).owned(
        'job:' + (await env.latestJob()).id + ':1'
      )
    ).toHaveLength(0)
  } finally {
    release.resolve()
    await env.close()
  }
})

test('media recall, business revocation, instance grant revocation and cancellation during a download block publication', async () => {
  for (const change of ['recall', 'authority', 'grant', 'cancel']) {
    const env = await foundationFixture()
    const { app } = env
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let downloads = 0
    try {
      app.config.framework.defaults.behavior.agentEnabled = false
      app.channels.register({
        ...createMockAdapter(),
        async readMedia(_address, _record, signal) {
          downloads += 1
          started.resolve()
          await release.promise
          signal.throwIfAborted()
          return { data: Buffer.from('real attachment text'), mimeType: 'text/plain' }
        }
      })
      const sourceId = crypto.randomUUID()
      const attachment = app.media.capture(app.room, sourceId, {
        type: 'file',
        name: 'input.txt',
        reference: { id: 'PRIVATE_PLATFORM_HANDLE', url: 'https://signed.invalid/PRIVATE_SIGNATURE' }
      })
      app.store.saveMessage({
        id: sourceId,
        roomId: app.room.id,
        role: 'user',
        actorId: 'alice',
        actorName: 'Alice',
        text: 'input',
        attachments: [attachment],
        createdAt: Date.now(),
        platformMessageIds: [],
        recalled: false
      })
      await app.coordinator.receive(app.room.id, '/media-inspect ' + attachment.mediaId)
      await started.promise
      const job = await env.latestJob()
      if (change === 'recall') {
        app.store.saveMessage({ ...app.store.getMessage(sourceId)!, recalled: true })
      }
      if (change === 'authority') {
        app.config.framework.defaults.permissions.rules = [
          { effect: 'deny', capabilities: ['media_read'], subjects: [{ kind: 'mock' }] }
        ]
      }
      if (change === 'grant') {
        app.config.resources.config.plugins[1].grants = ['artifact.write']
      }
      if (change === 'cancel') {
        await app.jobs.cancel(job.id, app.room.id)
      }
      release.resolve()
      const value = await env.settled(job.id)
      expect(value.state).not.toBe('succeeded')
      expect(value.result?.artifactIds ?? []).toHaveLength(0)
      expect(JSON.stringify(value)).not.toContain('PRIVATE')
      expect(downloads).toBe(1)
      expect(
        app.store.listOutbound(app.room.id).some((item) => {
          return item.artifactIds.length > 0 && item.state === 'sent'
        })
      ).toBe(false)
      await untilJob(() => {
        return env.worker.manager.status().invocations === 0
      }, 'media worker leaked')
    } finally {
      release.resolve()
      await env.close()
    }
  }
})
