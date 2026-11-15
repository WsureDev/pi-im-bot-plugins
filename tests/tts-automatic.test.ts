import { expect, test } from 'bun:test'
import { foundationFixture } from './foundation-fixture'
import { responsesReply } from '../../pi-im-bot/tests/responses-fixture'
import { untilJob } from '../../pi-im-bot/tests/job-harness'
import { parsePolicy, shouldRender, PolicySchema } from '../plugins/gsvi-tts/src/policy'

async function enabled(env: Awaited<ReturnType<typeof foundationFixture>>, limit = 100, probability = 100) {
  await env.app.coordinator.receive(
    env.app.room.id,
    `/usetts "花火" ${limit} ${probability}`,
    'alice',
    'Alice'
  )
  expect(env.app.store.listMessages(env.app.room.id).at(-1)?.text).toContain('开启')
}

async function run(env: Awaited<ReturnType<typeof foundationFixture>>) {
  const accepted = await env.app.coordinator.receive(env.app.room.id, 'respond', 'bob', 'Bob')
  return env.app.coordinator.waitRun(accepted!.id)
}

test('legacy grammar, codepoint boundary and exactly one random choice with deterministic zero/full probability', () => {
  expect(parsePolicy('"某个 角色" 2 50')).toEqual({
    action: 'configure',
    policy: { enabled: true, voice: '某个 角色', max_chars: 2, probability: 50 }
  })
  for (const invalid of ['花火 0 1', '花火 1 101', '花火 1 1.0', '"bad', '花火 -1 10']) {
    expect(() => {
      parsePolicy(invalid)
    }).toThrow()
  }
  let draws = 0
  const random = () => {
    draws += 1
    return 0.5
  }
  const p = PolicySchema.parse({ enabled: true, voice: '花火', max_chars: 2, probability: 100 })
  expect(shouldRender(p, ' 𠮷😀 ', random)).toBe(true)
  expect(shouldRender(p, '𠮷😀a', random)).toBe(false)
  expect(shouldRender({ ...p, probability: 0 }, 'a', random)).toBe(false)
  expect(draws).toBe(0)
  expect(shouldRender({ ...p, probability: 50 }, 'a', random)).toBe(false)
  expect(draws).toBe(1)
})

test('default off, /voice retention, offline status/off, quoted policy and group persistence across /new and restart', async () => {
  const env = await foundationFixture(() => {
    return responsesReply({ kind: 'text', text: 'hello' })
  })
  try {
    await env.app.coordinator.receive(env.app.room.id, '/voice 第二音色')
    await env.app.coordinator.receive(env.app.room.id, '/usetts')
    expect(env.app.store.listMessages(env.app.room.id).at(-1)?.text).toContain('关闭\n音色：第二音色')
    await run(env)
    expect(env.posts).toBe(0)
    await env.app.coordinator.receive(env.app.room.id, '/usetts on')
    await env.app.coordinator.receive(env.app.room.id, '/new')
    await env.app.restart()
    const result = await run(env)
    expect(result.rawReply).toBe('hello')
    await env.settled((await env.latestJob()).id)
    expect(env.calls).toEqual([{ text: 'hello', voice: '第二音色' }])
    const reads = env.modelReads
    env.app.config.resources.config.services[0].enabled = false
    await env.app.coordinator.receive(env.app.room.id, '/usetts off')
    await env.app.coordinator.receive(env.app.room.id, '/usetts')
    expect(env.app.store.listMessages(env.app.room.id).at(-1)?.text).toContain('关闭')
    expect(env.modelReads).toBe(reads)
  } finally {
    await env.close()
  }
})

test('real Pi final releases foreground while one render Job owns the original outbound and preserves rawReply', async () => {
  const env = await foundationFixture(() => {
    return responsesReply({ kind: 'text', text: '𠮷😀' })
  })
  try {
    await enabled(env, 2)
    env.mode = 'wait'
    const result = await run(env)
    expect(result.status).toBe('completed')
    expect(result.presentation?.state).toBe('accepted')
    expect(result.rawReply).toBe('𠮷😀')
    await env.started
    expect(
      env.app.store.listOutbound(env.app.room.id).filter((o) => {
        return o.state === 'rendering'
      })
    ).toHaveLength(1)
    // Policy operations use a separate data-bearing Worker while synthesis has no private data mount.
    await env.app.coordinator.receive(env.app.room.id, '/usetts off')
    expect(env.app.store.listMessages(env.app.room.id).at(-1)?.text).toContain('关闭')
    env.release()
    const value = await env.settled((await env.latestJob()).id)
    expect(value.delivery).toBe('sent')
    expect(env.posts).toBe(1)
    expect(env.app.requests).toHaveLength(1)
    const outbound = env.app.store.listOutbound(env.app.room.id).find((o) => {
      return o.render
    })!
    expect(outbound.text).toBe('𠮷😀')
    expect(outbound.renderedText).toBe('')
    expect(outbound.artifactIds).toHaveLength(1)
    expect(env.app.store.getRun(result.id)?.presentation?.state).toBe('sent')
    await env.app.restart()
    expect(env.posts).toBe(1)
    expect(env.app.requests).toHaveLength(1)
  } finally {
    await env.close()
  }
})

test('overlength, zero probability and synthesis rejection preserve full text without changing the model request count', async () => {
  for (const mode of ['over', 'zero', 'reject']) {
    const env = await foundationFixture(() => {
      return responsesReply({ kind: 'text', text: '𠮷😀a' })
    })
    try {
      let limit = 100
      let probability = 100
      if (mode === 'over') {
        limit = 2
      }
      if (mode === 'zero') {
        probability = 0
      }
      await enabled(env, limit, probability)
      if (mode === 'reject') {
        env.mode = 'reject'
      }
      await run(env)
      if (mode === 'reject') {
        await env.settled((await env.latestJob()).id)
      }
      expect(env.app.store.listMessages(env.app.room.id).at(-1)?.text).toBe('𠮷😀a')
      expect(env.app.requests).toHaveLength(1)
      let posts = 0
      if (mode === 'reject') {
        posts = 1
      }
      expect(env.posts).toBe(posts)
    } finally {
      await env.close()
    }
  }
})

test('Core producer and whole-message media eligibility control automatic presentation independently of phase, origin and text', async () => {
  const env = await foundationFixture()
  try {
    await enabled(env)
    const { localIdentity } = await import('../../pi-im-bot/src/permissions/identity')
    const invocation = env.app.coordinator.jobInvocation(
      env.app.room.id,
      localIdentity('mock', 'mock-bot', 'alice', 'Alice'),
      'notification'
    )
    for (const producer of [
      'agent-final',
      'scheduled-agent',
      'background-agent',
      'agent-tool',
      'plugin',
      'control',
      'unknown'
    ] as const) {
      const presentation = env.app.coordinator.presentation(
        invocation.config,
        invocation.room,
        invocation.input,
        'fixture:' + producer,
        'final',
        new AbortController().signal,
        'command',
        producer,
        true
      )!
      const plain = await presentation.prepare('final answer', [])
      expect(Boolean(plain.render)).toBe(
        ['agent-final', 'scheduled-agent', 'background-agent', 'agent-tool'].includes(producer)
      )
      const { ArtifactStore } = await import('../../pi-im-bot/src/artifacts/store')
      const file = await new ArtifactStore(env.app.config.dataDir, env.app.room.id).save(
        'file.txt',
        'text/plain',
        'fixture',
        'attachment'
      )
      const mixed = await presentation.prepare('final answer', [file.id])
      expect(mixed.render).toBeUndefined()
      expect(mixed.artifactIds).toEqual([file.id])
      const sync = env.app.coordinator.presentation(
        invocation.config,
        invocation.room,
        invocation.input,
        'sync:' + producer,
        'tool-direct',
        new AbortController().signal,
        'tool',
        producer,
        false
      )!
      expect((await sync.prepare('final answer', [])).render).toBeUndefined()
    }
    expect(env.posts).toBe(0)
    expect(env.app.requests).toHaveLength(0)
  } finally {
    await env.close()
  }
})

test('channel switch cannot raise an actor TTS ceiling; a denied actor receives text and no synthesis', async () => {
  const env = await foundationFixture(() => {
    return responsesReply({ kind: 'text', text: 'text stays' })
  })
  try {
    await enabled(env)
    env.app.config.framework.defaults.permissions.rules = [
      { effect: 'deny', capabilities: ['tts_synthesize'], subjects: [{ kind: 'mock' }] }
    ]
    await run(env)
    expect(env.posts).toBe(0)
    expect(env.app.store.listMessages(env.app.room.id).at(-1)?.text).toBe('text stays')
  } finally {
    await env.close()
  }
})

test('stop, new, permission/grant/binding revocations suppress the pending render and all late fallback/audio', async () => {
  for (const change of ['stop', 'new', 'permission', 'grant', 'binding', 'credential', 'mode']) {
    const env = await foundationFixture(() => {
      return responsesReply({ kind: 'text', text: 'late result sentinel' })
    })
    try {
      await enabled(env)
      env.mode = 'wait'
      await run(env)
      await env.started
      const job = await env.latestJob()
      if (change === 'stop') {
        await env.app.coordinator.receive(env.app.room.id, '/stop')
      }
      if (change === 'new') {
        await env.app.coordinator.receive(env.app.room.id, '/new')
      }
      if (change === 'permission') {
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
      if (change === 'credential') {
        env.app.config.resources.config.services[0].headers = { Authorization: 'ROTATED_TEST_ONLY' }
      }
      if (change === 'mode') {
        env.app.coordinator.stop(env.app.room.id)
        env.app.store.saveRoom({ ...env.app.coordinator.requireRoom(env.app.room.id), mode: 'demo' })
      }
      env.release()
      await env.settled(job.id)
      const original = env.app.store.listOutbound(env.app.room.id).find((o) => {
        return o.render
      })!
      expect(original.state).not.toBe('sent')
      expect(original.platformMessageIds).toHaveLength(0)
      expect(env.posts).toBe(1)
      expect(env.app.requests).toHaveLength(1)
      expect(
        env.app.store.listMessages(env.app.room.id).filter((m) => {
          return m.role === 'assistant' && m.text === 'late result sentinel'
        })
      ).toHaveLength(0)
    } finally {
      await env.close()
    }
  }
}, 15000)

test('unknown synthesis and restart reuse the original decision without a second POST or model run', async () => {
  for (const mode of ['unknown', 'restart']) {
    const env = await foundationFixture(() => {
      return responsesReply({ kind: 'text', text: 'recover me' })
    })
    try {
      await enabled(env)
      env.mode = mode
      if (mode === 'restart') {
        env.mode = 'wait'
      }
      await run(env)
      await env.started
      const job = await env.latestJob()
      if (mode === 'restart') {
        await env.app.restart()
      }
      env.release()
      const result = await env.settled(job.id)
      expect(result.state).toBe('outcome_unknown')
      expect(result.delivery).toBe('sent')
      await env.app.restart()
      expect(env.posts).toBe(1)
      expect(env.app.requests).toHaveLength(1)
      expect(
        env.app.store.listOutbound(env.app.room.id).filter((o) => {
          return o.render && o.state === 'sent'
        })
      ).toHaveLength(1)
    } finally {
      await env.close()
    }
  }
})

test('real Agent tool notification has an explicit accepted receipt while chat_send retains platform ACK', async () => {
  for (const name of ['chat_present', 'chat_send']) {
    const env = await foundationFixture((_raw, call) => {
      if (call === 1) {
        return responsesReply({ kind: 'tool', name, arguments: { text: 'tool notification' } })
      }
      return responsesReply({ kind: 'text', text: '' })
    })
    try {
      await enabled(env)
      const result = await run(env)
      expect(result.status).toBe('completed')
      if (name === 'chat_present') {
        await env.settled((await env.latestJob()).id)
        expect(env.posts).toBe(1)
        expect(env.app.requests[1]).toContain('delivered\\\":false')
        expect(env.app.requests[1]).toContain('jobId')
      } else {
        expect(env.posts).toBe(0)
        expect(env.app.requests[1]).toContain('delivered\\\":true')
      }
      expect(env.app.requests).toHaveLength(2)
    } finally {
      await env.close()
    }
  }
})

test('foreground confirmation and delegated Agent result become independent single-owner presentations without replaying the tool', async () => {
  const { latestUser } = await import('../../pi-im-bot/tests/job-harness')
  let delegated = false
  const env = await foundationFixture((raw) => {
    if (latestUser(raw).includes('child-only-sentinel')) {
      return responsesReply({ kind: 'text', text: 'child result' })
    }
    if (!delegated) {
      delegated = true
      return responsesReply({
        kind: 'tool',
        name: 'delegate_task',
        arguments: { title: 'child', prompt: 'child-only-sentinel' }
      })
    }
    return responsesReply({ kind: 'text', text: 'foreground confirmation' })
  })
  try {
    await enabled(env)
    const result = await run(env)
    expect(result.status).toBe('completed')
    await untilJob(async () => {
      const jobs = await env.app.jobs.repository.list(env.app.room.id)
      return (
        jobs.length === 3 &&
        jobs.every((job) => {
          return job.delivery === 'sent'
        })
      )
    }, 'independent agent deliveries did not settle')
    expect(
      env.calls
        .map((call) => {
          return call.text
        })
        .sort()
    ).toEqual(['foreground confirmation', '任务「child」完成。\nchild result'].sort())
    expect(env.posts).toBe(2)
    expect(env.app.requests).toHaveLength(3)
    const foreground = env.app.store.getRun(result.id)!
    expect(foreground.toolCalls).toBe(1)
  } finally {
    await env.close()
  }
})

test('stop between outbox decision and Job admission cancels that decision instead of admitting it after stop', async () => {
  const env = await foundationFixture(() => {
    return responsesReply({ kind: 'text', text: 'pending admission' })
  })
  try {
    await enabled(env)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = env.app.jobs.present.bind(env.app.jobs)
    env.app.jobs.present = async (outbound) => {
      entered.resolve()
      await release.promise
      return original(outbound)
    }
    const received = await env.app.coordinator.receive(env.app.room.id, 'test')
    await entered.promise
    env.app.coordinator.stop(env.app.room.id)
    release.resolve()
    const result = await env.app.coordinator.waitRun(received!.id)
    expect(result.status).toBe('cancelled')
    expect(env.posts).toBe(0)
    expect(await env.app.jobs.repository.list(env.app.room.id)).toHaveLength(0)
    expect(
      env.app.store.listOutbound(env.app.room.id).find((o) => {
        return o.render
      })?.state
    ).toBe('cancelled')
    await env.app.restart()
    expect(env.posts).toBe(0)
  } finally {
    await env.close()
  }
})

test('render transport unknown/partial receipts remain owned by the original Outbox and never trigger text or audio replay', async () => {
  const { createMockAdapter } = await import('../../pi-im-bot/src/channels/mock')
  const { PartialDelivery, SendBlocked } = await import('../../pi-im-bot/src/domain/channel-media')
  for (const mode of ['unknown', 'partial'] as const) {
    const env = await foundationFixture(() => {
      return responsesReply({ kind: 'text', text: 'audio transport' })
    })
    try {
      await enabled(env)
      let sends = 0
      env.app.channels.register({
        ...createMockAdapter(),
        async send(_address, _text, _media, control) {
          sends += 1
          if (mode === 'unknown') {
            throw new Error('ACK lost')
          }
          control?.received?.(['confirmed-part'], Date.now())
          throw new PartialDelivery(
            ['confirmed-part'],
            Date.now(),
            new SendBlocked(new Error('next part cancelled'))
          )
        }
      })
      await run(env)
      const job = await env.latestJob()
      const result = await env.settled(job.id)
      expect(result.delivery).toBe(mode)
      const outbound = env.app.store.listOutbound(env.app.room.id).find((o) => {
        return o.render
      })!
      expect(outbound.artifactIds).toHaveLength(1)
      expect(outbound.renderedText).toBe('')
      await env.app.restart()
      expect(sends).toBe(1)
      expect(env.posts).toBe(1)
      expect(env.app.requests).toHaveLength(1)
    } finally {
      await env.close()
    }
  }
})
