import { expect, test } from 'bun:test'
import { foundationFixture } from './foundation-fixture'
import { ArtifactStore } from '../../pi-im-bot/src/artifacts/store'
import { validateWav } from '../../pi-im-bot/src/services/gsvi/wav'
import { wavAudio } from '../../pi-im-bot/tests/wav-fixture'
import { untilJob } from '../../pi-im-bot/tests/job-harness'
import { responsesReply } from '../../pi-im-bot/tests/responses-fixture'
import { pluginToolName } from '../../pi-im-bot/src/plugins/identity'
import { localIdentity } from '../../pi-im-bot/src/permissions/identity'
import { Hono } from 'hono'
import { registerArtifactRoutes } from '../../pi-im-bot/src/http/artifact-routes'

test('actual TTS package lists/selects voices, shares scope, creates a real WAV and delivers a Job once across restart', async () => {
  const env = await foundationFixture()
  const { app } = env
  try {
    app.config.framework.defaults.behavior.agentEnabled = false
    await app.coordinator.receive(app.room.id, '/voices', 'alice', 'Alice')
    expect(app.store.listMessages(app.room.id).at(-1)?.text).toContain('第二音色')
    await app.coordinator.receive(app.room.id, '/voice 第二音色', 'alice', 'Alice')
    await app.coordinator.receive(app.room.id, '/tts 你好', 'bob', 'Bob')
    const job = await env.latestJob()
    const value = await env.settled(job.id)
    expect(value.state).toBe('succeeded')
    expect(value.delivery).toBe('sent')
    expect(env.calls).toEqual([{ voice: '第二音色', text: '你好' }])
    expect(app.requests).toHaveLength(0)
    const artifacts = new ArtifactStore(app.config.dataDir, app.room.id)
    const artifact = await artifacts.content(value.result!.artifactIds[0])
    const audio = new Uint8Array(await artifact.file.arrayBuffer())
    validateWav(audio)
    expect(Buffer.from(audio).equals(wavAudio())).toBe(true)
    expect(JSON.stringify(artifact.metadata)).not.toContain('PRIVATE_SERVICE')
    expect(artifact.metadata.access?.capabilities).toEqual(['tts_synthesize'])
    await app.restart()
    expect(env.posts).toBe(1)
    expect(
      app.store.listOutbound(app.room.id).filter((item) => {
        return item.artifactIds.length > 0 && item.state === 'sent'
      })
    ).toHaveLength(1)
    const http = new Hono()
    registerArtifactRoutes(http, app.coordinator, () => {
      return app.config
    })
    app.config.resources.config.services[0].name = 'renamed'
    app.config.resources.config.services[0].headers = { Authorization: 'changed-private-value' }
    app.config.resources.config.plugins[0].enabled = false
    const archived = await http.request(
      '/api/rooms/' + app.room.id + '/artifacts/' + artifact.metadata.id + '/content'
    )
    expect(archived.status).toBe(200)
    expect(Buffer.from(await archived.arrayBuffer()).equals(wavAudio())).toBe(true)
    await expect(
      app.coordinator.delivery.send(app.room, 'new delivery', undefined, 'assistant', 'late-new-delivery', {
        artifactIds: [artifact.metadata.id],
        authorize() {}
      })
    ).rejects.toThrow('交付')
  } finally {
    await env.close()
  }
})

test('Pi tool and Job idempotency use the same TTS operation without resynthesis or model task replay', async () => {
  const env = await foundationFixture((_raw, call) => {
    if (call === 1) {
      return responsesReply({
        kind: 'tool',
        name: pluginToolName('gsvi-tts', 'speak'),
        arguments: { text: 'tool audio' }
      })
    }
    return responsesReply({ kind: 'text', text: 'job accepted' })
  })
  try {
    const { app } = env
    const run = await app.coordinator.receive(app.room.id, 'use speech tool')
    expect((await app.coordinator.waitRun(run!.id)).status).toBe('completed')
    await env.settled((await env.latestJob()).id)
    const invocation = app.coordinator.jobInvocation(
      app.room.id,
      localIdentity('mock', 'mock-bot', 'alice', 'Alice'),
      'dedupe'
    )
    const jobs = app.jobs.forInvocation(invocation)
    const first = await jobs.operation(
      'once',
      'plugin:gsvi-tts/speak',
      { text: 'second audio' },
      'stable-key'
    )
    const second = await jobs.operation(
      'once',
      'plugin:gsvi-tts/speak',
      { text: 'second audio' },
      'stable-key'
    )
    expect(first.id).toBe(second.id)
    await env.settled(first.id)
    expect(env.posts).toBe(2)
    expect(app.requests).toHaveLength(2)
  } finally {
    await env.close()
  }
})

test('known rejection falls back to original text, while remote uncertainty never resubmits on recovery', async () => {
  const env = await foundationFixture()
  try {
    env.mode = 'reject'
    await env.app.coordinator.receive(env.app.room.id, '/tts fallback text')
    const first = await env.settled((await env.latestJob()).id)
    expect(first.state).toBe('succeeded')
    expect(first.result?.summary).toContain('保留原文：\nfallback text')
    expect(first.result?.artifactIds).toHaveLength(0)
    env.mode = 'unknown'
    await env.app.coordinator.receive(env.app.room.id, '/tts uncertain text')
    const id = (await env.latestJob()).id
    const second = await env.settled(id)
    expect(second.state).toBe('outcome_unknown')
    expect(JSON.stringify(second)).not.toContain('PRIVATE')
    await env.app.restart()
    expect(env.posts).toBe(2)
  } finally {
    await env.close()
  }
})

test('a real HTTP submission interrupted by Bot restart is unknown and never synthesized again', async () => {
  const env = await foundationFixture()
  try {
    env.mode = 'wait'
    await env.app.coordinator.receive(env.app.room.id, '/tts interrupted')
    await env.started
    const id = (await env.latestJob()).id
    await env.app.restart()
    env.release()
    const value = await env.settled(id)
    expect(value.state).toBe('outcome_unknown')
    expect(env.posts).toBe(1)
    expect(value.result?.artifactIds ?? []).toHaveLength(0)
    await expect(env.app.jobs.reconcile(id, env.app.room.id, false)).rejects.toThrow('回执')
    expect(env.posts).toBe(1)
  } finally {
    await env.close()
  }
})

test('renaming the bound service during a real HTTP synthesis preserves the pinned request, WAV and single delivery', async () => {
  const env = await foundationFixture()
  try {
    env.mode = 'wait'
    await env.app.coordinator.receive(env.app.room.id, '/tts rename still completes')
    await env.started
    const id = (await env.latestJob()).id
    env.app.config.resources.config.services[0].name = 'Only the display label changed'
    env.release()
    const result = await env.settled(id)
    expect(result.state).toBe('succeeded')
    expect(result.delivery).toBe('sent')
    expect(result.result?.artifactIds).toHaveLength(1)
    const artifact = await new ArtifactStore(env.app.config.dataDir, env.app.room.id).content(
      result.result!.artifactIds[0]
    )
    validateWav(new Uint8Array(await artifact.file.arrayBuffer()))
    expect(env.posts).toBe(1)
    expect(
      env.app.store.listOutbound(env.app.room.id).filter((outbound) => {
        return outbound.artifactIds.length === 1 && outbound.state === 'sent'
      })
    ).toHaveLength(1)
  } finally {
    await env.close()
  }
})

test('cancellation and authority/grant/binding revocation during synthesis suppress late audio', async () => {
  for (const change of ['cancel', 'authority', 'grant', 'binding', 'policy', 'credential', 'disable']) {
    const env = await foundationFixture()
    try {
      env.mode = 'wait'
      await env.app.coordinator.receive(env.app.room.id, '/tts late audio', 'alice', 'Alice')
      await env.started
      const job = await env.latestJob()
      if (change === 'cancel') {
        await env.app.jobs.cancel(job.id, env.app.room.id)
      }
      if (change === 'authority') {
        env.app.config.framework.defaults.permissions.rules = [
          { effect: 'deny', capabilities: ['tts_synthesize'], subjects: [{ kind: 'mock' }] }
        ]
      }
      if (change === 'grant') {
        env.app.config.resources.config.plugins[0].grants = ['storage.read', 'storage.write']
      }
      if (change === 'binding') {
        env.app.config.resources.config.plugins[0].services = {}
      }
      if (change === 'policy') {
        env.app.config.resources.config.services[0].timeoutMs = 1000
      }
      if (change === 'credential') {
        env.app.config.resources.config.services[0].headers = { Authorization: 'Bearer ROTATED_FAKE' }
      }
      if (change === 'disable') {
        env.app.config.resources.config.services[0].enabled = false
      }
      env.release()
      await env.settled(job.id)
      expect(env.posts).toBe(1)
      expect(
        env.app.store.listOutbound(env.app.room.id).some((item) => {
          return item.artifactIds.length > 0 && item.state === 'sent'
        })
      ).toBe(false)
      await untilJob(() => {
        return env.worker.manager.status().invocations === 0
      }, 'worker call leaked')
    } finally {
      await env.close()
    }
  }
})
