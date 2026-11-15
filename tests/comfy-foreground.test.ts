import { expect, test } from 'bun:test'
import { comfyFixture, manageComfy } from './comfy-fixture'
import { untilJob } from '../../pi-im-bot/tests/job-harness'
import { localIdentity } from '../../pi-im-bot/src/permissions/identity'

for (const maximum of [2, 4]) {
  test(
    'same-scope usage, catalog and authorized policy command stay responsive during held Comfy POST with maxWorkers=' +
      maximum,
    async () => {
      const env = await comfyFixture(undefined, { maxWorkers: maximum, idleMs: 1000 })
      const live = new Set<string>()
      let peak = 0
      const create = env.worker.backend.create.bind(env.worker.backend)
      const destroy = env.worker.backend.destroy.bind(env.worker.backend)
      env.worker.backend.create = async (name, spec) => {
        const id = await create(name, spec)
        live.add(id)
        peak = Math.max(peak, live.size)
        return id
      }
      env.worker.backend.destroy = async (id, name) => {
        await destroy(id, name)
        live.delete(id)
      }
      try {
        env.remote.mode = 'hold-submit'
        await env.app.coordinator.receive(env.app.room.id, '/画图no held request')
        await env.remote.started
        const job = await env.latestJob()
        const core = env.app.coordinator.plugins!
        await manageComfy(env, { action: 'history', value: 'on' })
        const input = env.app.coordinator.jobInvocation(
          env.app.room.id,
          localIdentity('web', 'operator'),
          'foreground policy'
        )
        const invocation = {
          ...input,
          services: {
            authorize: input.authorize,
            history() {
              return []
            },
            async send() {
              throw new Error('foreground fixture returns only')
            }
          }
        }
        async function controls() {
          const usage = await core.execute(
            invocation,
            'plugin:comfyui-pro/usage',
            {},
            crypto.randomUUID(),
            AbortSignal.timeout(1000)
          )
          expect(usage.status).toBe('done')
          const catalog = await core.execute(
            invocation,
            'plugin:comfyui-pro/workflows',
            {},
            crypto.randomUUID(),
            AbortSignal.timeout(1000)
          )
          expect(catalog.status).toBe('done')
          const entry = core.operation(invocation, 'plugin:comfyui-pro/manage')
          const args = await core.parse(
            invocation,
            entry,
            'history',
            'status',
            crypto.randomUUID(),
            AbortSignal.timeout(1000)
          )
          const policy = await core.execute(
            invocation,
            entry.capabilityId,
            args,
            crypto.randomUUID(),
            AbortSignal.timeout(1000)
          )
          expect(policy.status).toBe('done')
          expect(env.remote.submissions).toHaveLength(1)
          expect((await env.app.jobs.repository.get(job.id)).revisions['1'].state).toBe('waiting_external')
        }
        await controls()
        await untilJob(() => {
          const workers = env.worker.manager.status().workers
          return workers.length === 1 && workers[0].busy
        }, 'idle foreground Worker was not reclaimed while background remained held')
        await controls()
        expect(peak).toBeLessThanOrEqual(maximum)
        expect(peak).toBeGreaterThanOrEqual(2)
        for (const spec of env.worker.backend.specifications.values()) {
          if (spec.Labels['io.pi-im.plugin-instance'] !== 'comfyui-pro') {
            continue
          }
          expect(
            spec.HostConfig.Mounts.some((mount) => {
              return mount.Target === '/data'
            })
          ).toBe(false)
        }
        await env.app.coordinator.receive(env.app.room.id, '/stop')
        env.remote.releaseSubmit()
        const result = await env.settled(job.id)
        expect(result.delivery).toBe('suppressed')
        expect(env.app.store.getOutbound('job:' + job.id + ':1:result')?.state).not.toBe('sent')
        await env.app.restart()
        expect(env.remote.submissions).toHaveLength(1)
        expect(env.app.requests).toHaveLength(0)
      } finally {
        env.remote.releaseSubmit()
        await env.close()
      }
    },
    15000
  )
}
