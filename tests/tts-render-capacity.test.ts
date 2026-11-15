import { expect, test } from 'bun:test'
import { foundationFixture } from './foundation-fixture'
import { responsesReply } from '../../pi-im-bot/tests/responses-fixture'
import { untilJob } from '../../pi-im-bot/tests/job-harness'

async function respond(env: Awaited<ReturnType<typeof foundationFixture>>, roomId: string) {
  const run = await env.app.coordinator.receive(roomId, 'respond')
  return env.app.coordinator.waitRun(run!.id)
}

test('one Worker diagnoses render refusal before POST and retains policy control after cold start, idle cleanup and restart', async () => {
  const env = await foundationFixture(
    () => {
      return responsesReply({ kind: 'text', text: 'one worker text' })
    },
    { maxWorkers: 1, idleMs: 1000 }
  )
  try {
    await env.app.coordinator.receive(env.app.room.id, '/usetts on')
    expect(env.app.store.listMessages(env.app.room.id).at(-1)?.text).toContain('自动呈现当前不可用')
    await untilJob(() => {
      return env.worker.manager.status().workers.length === 0
    }, 'data Worker did not idle out')
    const run = await respond(env, env.app.room.id)
    expect(run.status).toBe('completed')
    expect(run.rawReply).toBe('one worker text')
    const outbound = env.app.store.listOutbound(env.app.room.id).find((o) => {
      return o.render
    })!
    expect(outbound.renderFallback?.code).toBe('worker_capacity')
    expect(outbound.state).toBe('sent')
    expect(env.posts).toBe(0)
    env.app.config.framework.defaults.behavior.timeoutMs = 1000
    await env.app.coordinator.receive(env.app.room.id, '/usetts off')
    expect(env.app.store.listMessages(env.app.room.id).at(-1)?.text).toContain('关闭')
    await env.app.restart()
    await env.app.coordinator.receive(env.app.room.id, '/usetts')
    expect(env.app.store.listMessages(env.app.room.id).at(-1)?.text).toContain('关闭')
    expect(env.worker.manager.status().workers.length).toBeLessThanOrEqual(1)
    expect(env.posts).toBe(0)
  } finally {
    await env.close()
  }
})

test('multiple live synthesis scopes preserve bounded Worker capacity for cold policy commands and idle recovery', async () => {
  const env = await foundationFixture(
    () => {
      return responsesReply({ kind: 'text', text: 'multiple voice scopes' })
    },
    { maxWorkers: 4, idleMs: 1000 }
  )
  let peak = 0
  const active = new Set<string>()
  const create = env.worker.backend.create.bind(env.worker.backend)
  const destroy = env.worker.backend.destroy.bind(env.worker.backend)
  env.worker.backend.create = async (name, spec) => {
    const id = await create(name, spec)
    active.add(id)
    peak = Math.max(peak, active.size)
    return id
  }
  env.worker.backend.destroy = async (id, name) => {
    await destroy(id, name)
    active.delete(id)
  }
  try {
    const second = env.app.coordinator.createMockRoom('second', 'group')
    const control = env.app.coordinator.createMockRoom('cold control', 'group')
    const rooms = [env.app.room.id, second.id, control.id]
    for (const id of rooms) {
      env.app.store.saveRoom({ ...env.app.coordinator.requireRoom(id), mode: 'live' })
      await env.app.coordinator.receive(id, '/usetts on')
    }
    await untilJob(() => {
      return env.worker.manager.status().workers.length === 0
    }, 'initial Workers did not idle out')
    env.mode = 'wait'
    const results = await Promise.all([respond(env, rooms[0]), respond(env, rooms[1])])
    expect(
      results.every((run) => {
        return run.presentation?.state === 'accepted'
      })
    ).toBe(true)
    await untilJob(() => {
      return env.posts === 2
    }, 'test prerequisite: two actual GSVI POSTs must be waiting')
    expect(
      env.worker.manager.status().workers.filter((worker) => {
        return worker.mode === 'stateless' && worker.busy
      })
    ).toHaveLength(2)
    env.app.config.framework.defaults.behavior.timeoutMs = 1000
    const controlTimes: number[] = []
    for (const id of rooms) {
      const started = performance.now()
      await env.app.coordinator.receive(id, '/usetts off')
      controlTimes.push(Number((performance.now() - started).toFixed(2)))
      expect(env.app.store.listMessages(id).at(-1)?.text).toContain('关闭')
    }
    env.release()
    for (const result of results) {
      await env.settled(result.presentation!.jobId!)
    }
    await untilJob(() => {
      return env.worker.manager.status().workers.length === 0
    }, 'render Workers did not idle out')
    for (const id of rooms) {
      await env.app.coordinator.receive(id, '/usetts')
      expect(env.app.store.listMessages(id).at(-1)?.text).toContain('关闭')
    }
    console.log(
      JSON.stringify({
        renderCapacity: { maxWorkers: 4, waitingPosts: 2, peakWorkers: peak, controlTimesMs: controlTimes }
      })
    )
    expect(peak).toBeLessThanOrEqual(4)
    expect(env.posts).toBe(2)
    expect(env.app.requests).toHaveLength(2)
  } finally {
    await env.close()
  }
}, 15000)

test('two Workers serialize stateless renderers instead of occupying both foreground slots', async () => {
  const env = await foundationFixture(
    () => {
      return responsesReply({ kind: 'text', text: 'two workers bounded' })
    },
    { maxWorkers: 2 }
  )
  try {
    const second = env.app.coordinator.createMockRoom('second', 'group')
    env.app.store.saveRoom({ ...second, mode: 'live' })
    for (const id of [env.app.room.id, second.id]) {
      await env.app.coordinator.receive(id, '/usetts on')
    }
    env.mode = 'wait'
    await respond(env, env.app.room.id)
    await env.started
    const other = await respond(env, second.id)
    expect(other.presentation?.state).toBe('accepted')
    await untilJob(async () => {
      return (await env.app.jobs.repository.list()).length === 2
    }, 'second render Job not accepted')
    expect(env.posts).toBe(1)
    expect(
      env.worker.manager.status().workers.filter((w) => {
        return w.mode === 'stateless' && w.busy
      })
    ).toHaveLength(1)
    env.app.config.framework.defaults.behavior.timeoutMs = 1000
    await env.app.coordinator.receive(second.id, '/usetts off')
    expect(env.app.store.listMessages(second.id).at(-1)?.text).toContain('关闭')
    env.release()
    for (const job of await env.app.jobs.repository.list()) {
      await env.settled(job.id)
    }
    expect(env.posts).toBe(2)
  } finally {
    await env.close()
  }
})
