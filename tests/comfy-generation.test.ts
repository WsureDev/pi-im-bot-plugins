import { expect, test } from 'bun:test'
import { comfyFixture } from './comfy-fixture'
import { ArtifactStore } from '../../pi-im-bot/src/artifacts/store'
test('real package command compiles the registered API workflow and delivers each generated item once', async () => {
  const env = await comfyFixture()
  try {
    await env.app.coordinator.receive(env.app.room.id, '/画图no blue sky -n blurry -c 2')
    const job = await env.latestJob()
    const result = await env.settled(job.id)
    expect(result.state).toBe('succeeded')
    expect(result.result?.businessStatus).toBe('succeeded')
    expect(result.result?.artifactIds).toHaveLength(2)
    expect(env.remote.submissions).toHaveLength(2)
    const graph = env.remote.submissions[0].payload.prompt
    expect(graph['4'].inputs.text).toBe('blue sky')
    expect(graph['5'].inputs.text).toBe('original negative, blurry')
    const outbound = env.app.store.getOutbound('job:' + job.id + ':1:result')!
    expect(outbound.platformMessageIds).toHaveLength(2)
    expect(outbound.deliveryParts).toHaveLength(2)
    const artifact = await new ArtifactStore(env.app.config.dataDir, env.app.room.id).content(
      result.result!.artifactIds[0]
    )
    expect(Buffer.from(await artifact.file.arrayBuffer()).equals(env.remote.png)).toBe(true)
    expect(JSON.stringify(artifact.metadata)).not.toContain('AUTHORED_COMFY_PRIVATE')
    expect(artifact.metadata.access?.plugin?.services.render.id).toBe('comfy-local')
    expect(env.app.requests).toHaveLength(0)
    await env.app.restart()
    expect(env.remote.submissions).toHaveLength(2)
    expect(env.app.store.getOutbound(outbound.id)?.platformMessageIds).toHaveLength(2)
  } finally {
    await env.close()
  }
})

test('successful and unknown items remain independently reconcilable without reposting or resending the delivered success', async () => {
  const env = await comfyFixture()
  try {
    env.remote.mode = 'partial-unknown'
    await env.app.coordinator.receive(env.app.room.id, '/画图no blue sky -c 2')
    const job = await env.latestJob()
    const result = await env.settled(job.id)
    expect(result.state).toBe('outcome_unknown')
    expect(result.result?.businessStatus).toBe('partial')
    expect(result.result?.factsComplete).toBe(false)
    expect(
      result.result?.items?.map((item) => {
        return item.status
      })
    ).toEqual(['succeeded', 'outcome_unknown'])
    expect(result.result?.artifactIds).toHaveLength(1)
    const original = env.app.store.getOutbound('job:' + job.id + ':1:result')!
    expect(original.platformMessageIds).toHaveLength(1)
    env.remote.mode = 'ok'
    const updated = await env.app.jobs.reconcile(job.id, env.app.room.id, false)
    expect(updated.state).toBe('succeeded')
    expect(updated.result?.factsComplete).toBe(true)
    expect(updated.result?.artifactIds).toHaveLength(2)
    expect(updated.delivery).toBe('sent')
    expect(env.remote.submissions).toHaveLength(2)
    expect(env.app.store.getOutbound(original.id)?.platformMessageIds).toEqual(original.platformMessageIds)
    expect(env.app.store.getOutbound(original.id)?.artifactIds).toHaveLength(1)
    await env.app.restart()
    expect(env.remote.submissions).toHaveLength(2)
    expect(env.app.store.getOutbound(original.id)?.platformMessageIds).toEqual(original.platformMessageIds)
  } finally {
    await env.close()
  }
})

test('count16 reaches sixteen distinct platform ACK parts and preserves all per-item receipts', async () => {
  const env = await comfyFixture()
  try {
    await env.app.coordinator.receive(env.app.room.id, '/usetts on')
    await env.app.coordinator.receive(env.app.room.id, '/画图no blue sky --count 16')
    const job = await env.latestJob()
    const result = await env.settled(job.id)
    expect(result.state).toBe('succeeded')
    expect(result.result?.items).toHaveLength(16)
    expect(result.result?.artifactIds).toHaveLength(16)
    const outbound = env.app.store.getOutbound('job:' + job.id + ':1:result')!
    expect(outbound.state).toBe('sent')
    expect(outbound.deliveryParts).toHaveLength(16)
    expect(new Set(outbound.platformMessageIds).size).toBe(16)
    expect(
      new Set(
        env.remote.submissions.map((item) => {
          return item.id
        })
      ).size
    ).toBe(16)
    expect(env.posts).toBe(0)
    expect(env.app.requests).toHaveLength(0)
    await env.app.restart()
    expect(env.remote.submissions).toHaveLength(16)
    expect(env.app.store.getOutbound(outbound.id)?.platformMessageIds).toEqual(outbound.platformMessageIds)
  } finally {
    await env.close()
  }
}, 15000)

test('a text-only typed forward from a trusted Agent is mixed before Mock fallback and never becomes automatic TTS', async () => {
  const env = await comfyFixture()
  try {
    const { localIdentity } = await import('../../pi-im-bot/src/permissions/identity')
    await env.app.coordinator.receive(env.app.room.id, '/usetts on')
    const invocation = env.app.coordinator.jobInvocation(
      env.app.room.id,
      localIdentity('web', 'operator'),
      'forward fixture'
    )
    const id = 'authored-text-forward'
    await env.app.coordinator.delivery.send(invocation.room, 'typed forward', undefined, 'assistant', id, {
      format: 'forward',
      presentation: env.app.coordinator.presentation(
        invocation.config,
        invocation.room,
        invocation.input,
        id,
        'final',
        AbortSignal.timeout(10000),
        undefined,
        'agent-final',
        true
      )
    })
    const outbound = env.app.store.getOutbound(id)!
    expect(outbound.state).toBe('sent')
    expect(outbound.effectiveFormat).toBe('direct')
    expect(outbound.render).toBeUndefined()
    expect(outbound.renderAdmission).toBeUndefined()
    expect(env.posts).toBe(0)
  } finally {
    await env.close()
  }
})
