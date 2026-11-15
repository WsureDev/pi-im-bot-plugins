import { expect, test } from 'bun:test'
import { z } from 'zod'
import { comfyFixture, authoredWorkflow } from './comfy-fixture'
import { convertWorkflow } from '../src/comfy-import/convert'
import { compileWorkflow } from '../../pi-im-bot/src/services/comfy/compile'
import { ArtifactStore } from '../../pi-im-bot/src/artifacts/store'
import { WorkflowSchema } from '../../pi-im-bot/src/services/comfy/resources'
import { localIdentity } from '../../pi-im-bot/src/permissions/identity'

function toolInvocation(env: Awaited<ReturnType<typeof comfyFixture>>) {
  const invocation = env.app.coordinator.jobInvocation(
    env.app.room.id,
    localIdentity('web', 'records-reader'),
    'authored catalog'
  )
  return {
    ...invocation,
    services: {
      authorize: invocation.authorize,
      history() {
        return []
      },
      async send() {
        throw new Error('tool fixture returns only')
      }
    }
  }
}

test('legal multi-workflow catalogs larger than one RPC frame are paged and exported through the actual Worker without widening frames', async () => {
  const env = await comfyFixture()
  try {
    const large = Array.from({ length: 3 }, (_value, index) => {
      return WorkflowSchema.parse({
        ...authoredWorkflow('large-' + index),
        loras: Array.from({ length: 64 }, (_item, item) => {
          return {
            id: 'lora-' + item,
            name: 'large-' + item,
            filename: 'large-' + item + '.safetensors',
            description: '文'.repeat(1300),
            triggers: ['hint'],
            strength: 1
          }
        })
      })
    })
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(512 * 1024)
    env.app.config.resources.config.workflows.push(...large)
    env.app.config.resources.config.comfyServices[0].workflows.push(
      ...large.map((workflow) => {
        return workflow.id
      })
    )
    for (const workflow of large) {
      let count = 0
      for (const cursor of [0, 32]) {
        const outcome = await env.app.coordinator.plugins!.execute(
          toolInvocation(env),
          'plugin:comfyui-pro/workflows',
          { workflow: workflow.id, section: 'loras', cursor },
          crypto.randomUUID(),
          AbortSignal.timeout(10000)
        )
        expect(outcome.status).toBe('done')
        if (outcome.status !== 'done') {
          throw new Error('catalog unexpectedly pending')
        }
        expect(outcome.result.artifactIds).toHaveLength(1)
        const file = await new ArtifactStore(env.app.config.dataDir, env.app.room.id).content(
          outcome.result.artifactIds[0]
        )
        const page = z
          .object({ items: z.array(z.object({ id: z.string() })), total: z.number() })
          .parse(JSON.parse(await file.file.text()))
        expect(file.file.size).toBeLessThan(196608)
        count += page.items.length
      }
      expect(count).toBe(64)
    }
    expect(env.remote.calls).toHaveLength(0)
    expect(env.app.requests).toHaveLength(0)
  } finally {
    await env.close()
  }
}, 15000)

test('ring20 FIFO removes only debug records; original receipt can reconcile without reappend, repost or resend', async () => {
  const env = await comfyFixture()
  try {
    await env.app.coordinator.receive(env.app.room.id, '/画图no first -c 16')
    await env.settled((await env.latestJob()).id)
    env.remote.mode = 'partial-unknown'
    env.remote.unknownIndex = 17
    await env.app.coordinator.receive(env.app.room.id, '/画图no second -c 8')
    const job = await env.latestJob()
    await env.settled(job.id)
    const store = env.app.coordinator.plugins!.managed!.state
    const schema = z.object({
      records: z.array(
        z.object({
          recordId: z.string(),
          item: z.number(),
          status: z.string(),
          requestArtifactId: z.string()
        })
      )
    })
    const read = async () => {
      return schema.parse(
        (await store.read('comfyui-pro', env.app.room.id, { area: 'scope', key: 'comfy.records' })).value
      ).records
    }
    const before = await read()
    expect(before).toHaveLength(20)
    const invocation = toolInvocation(env)
    const result = await env.app.coordinator.plugins!.execute(
      invocation,
      'plugin:comfyui-pro/record',
      { action: 'pop', count: 20 },
      crypto.randomUUID(),
      AbortSignal.timeout(10000)
    )
    expect(result.status).toBe('done')
    if (result.status !== 'done') {
      throw new Error('record unexpectedly pending')
    }
    const file = await new ArtifactStore(env.app.config.dataDir, env.app.room.id).content(
      result.result.artifactIds[0]
    )
    const exportRows = z
      .array(
        z.object({
          record: z.object({ recordId: z.string() }),
          payload: z.object({ prompt: z.record(z.string(), z.unknown()) })
        })
      )
      .parse(JSON.parse(await file.file.text()))
    expect(
      exportRows.map((row) => {
        return row.record.recordId
      })
    ).toEqual(
      before.map((row) => {
        return row.recordId
      })
    )
    expect(await read()).toHaveLength(0)
    env.remote.mode = 'ok'
    const recovered = await env.app.jobs.reconcile(job.id, env.app.room.id, false)
    expect(recovered.state).toBe('succeeded')
    expect(recovered.result?.artifactIds).toHaveLength(8)
    expect(await read()).toHaveLength(0)
    expect(env.remote.submissions).toHaveLength(24)
    await env.app.restart()
    expect(env.remote.submissions).toHaveLength(24)
  } finally {
    await env.close()
  }
}, 15000)

test('LoraManager array/object conversion preserves string encodings, sidecar aliases, per-node steps and rejects unsafe or WS-only input', () => {
  for (const wrapped of [false, true]) {
    const original = authoredWorkflow().graph
    original['2'] = {
      class_type: 'Lora Loader (LoraManager)',
      inputs: { loras: [{ name: 'default.safetensors', strength: '0.7', clipStrength: '0.5', active: true }] }
    }
    if (wrapped) {
      original['2'].inputs.loras = { __value__: original['2'].inputs.loras }
    }
    delete original['3']
    const before = JSON.stringify(original)
    const imported = convertWorkflow('authored.json', original, {
      loras: {
        'folder/default.safetensors': {
          aliases: ['default'],
          trigger_options: ['a', 'b'],
          prompt_hints: ['preferred']
        },
        'selected.safetensors': { aliases: ['chosen'], trigger_words: ['only'] }
      }
    })
    expect(imported.diagnostics).toEqual([])
    expect(JSON.stringify(original)).toBe(before)
    const workflow = imported.workflow!
    expect(workflow.bindings.loras).toHaveLength(5)
    expect(workflow.loras).toHaveLength(2)
    expect(workflow.loras[0].aliases).toContain('default.safetensors')
    const first = workflow.bindings.loras[0]
    const second = workflow.bindings.loras[1]
    const compiled = compileWorkflow(workflow, {
      positive: 'new',
      steps_7: 25,
      [first.strength]: 0.8,
      [second.name]: 'selected.safetensors',
      [second.strength]: 1,
      [second.enabled!]: true
    })
    const stack = z
      .union([
        z.array(z.object({ strength: z.string() })),
        z.object({ __value__: z.array(z.object({ strength: z.string() })) })
      ])
      .parse(compiled['2'].inputs.loras)
    let rows = stack
    if (!Array.isArray(stack)) {
      rows = stack.__value__
    }
    expect(z.array(z.object({ strength: z.string() })).parse(rows)[0].strength).toBe('0.8')
    expect(compiled['7'].inputs.steps).toBe(25)
  }
  const graph = authoredWorkflow().graph
  graph['9'].class_type = 'SaveImageWebsocket'
  expect(convertWorkflow('ws.json', graph).diagnostics.join(' ')).toContain('Websocket')
  graph['9'].inputs.path = '/example-private-models'
  const refused = convertWorkflow('secret.json', graph, { api_key: 'PRIVATE_SENTINEL' })
  expect(refused.workflow).toBeUndefined()
  expect(refused.diagnostics.join(' ')).not.toContain('PRIVATE_SENTINEL')
})
