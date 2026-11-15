import { expect, test } from 'bun:test'
import { comfyFixture, fakeComfy } from './comfy-fixture'
import { untilJob } from '../../pi-im-bot/tests/job-harness'

test('known Core prompt receipt repairs a lost execute RPC response in the same process without another POST', async () => {
  const env = await comfyFixture()
  try {
    const broker = env.app.coordinator.plugins!.managed!.comfy
    const submit = broker.submit.bind(broker)
    let lost = false
    broker.submit = async (...args) => {
      const result = await submit(...args)
      if (!lost && result.hasReceipt) {
        lost = true
        throw new Error('authored lost Worker RPC reply')
      }
      return result
    }
    await env.app.coordinator.receive(env.app.room.id, '/画图no blue sky')
    const job = await env.latestJob()
    const value = await env.settled(job.id)
    expect(lost).toBe(true)
    expect(value.state).toBe('succeeded')
    expect(value.result?.artifactIds).toHaveLength(1)
    expect(env.remote.submissions).toHaveLength(1)
    expect(
      env.remote.calls.some((call) => {
        return call.path === '/history/' + env.remote.submissions[0].id
      })
    ).toBe(true)
  } finally {
    await env.close()
  }
})

test('display rename allows original receipt polling; endpoint rebinding and credential revocation never poll another server or send late results', async () => {
  for (const change of ['display', 'binding', 'credential'] as const) {
    const env = await comfyFixture()
    const other = await fakeComfy()
    try {
      env.remote.mode = 'wait'
      await env.app.coordinator.receive(env.app.room.id, '/画图no blue sky')
      await env.remote.started
      const job = await env.latestJob()
      await untilJob(async () => {
        return (await env.app.jobs.repository.get(job.id)).revisions['1'].external?.hasReceipt === true
      }, 'Core remote receipt was not saved')
      const service = env.app.config.resources.config.comfyServices[0]
      if (change === 'display') {
        service.name = 'renamed fake'
      }
      if (change === 'binding') {
        service.url = other.url
      }
      if (change === 'credential') {
        service.headers = { Authorization: 'Bearer ROTATED_FAKE' }
      }
      env.remote.mode = 'ok'
      const value = await env.settled(job.id)
      if (change === 'display') {
        expect(value.delivery).toBe('sent')
        expect(value.state).toBe('succeeded')
      } else {
        expect(value.delivery).toBe('suppressed')
      }
      expect(env.remote.submissions).toHaveLength(1)
      expect(other.calls).toHaveLength(0)
    } finally {
      await other.close()
      await env.close()
    }
  }
}, 15000)

test('queue deletion race keeps abandoned receipt reconcilable; exact queued cancellation never calls interrupt', async () => {
  for (const mode of ['queued', 'running', 'delete-race'] as const) {
    const env = await comfyFixture()
    try {
      env.remote.mode = mode
      await env.app.coordinator.receive(env.app.room.id, '/画图no blue sky')
      await env.remote.started
      const job = await env.latestJob()
      await untilJob(async () => {
        return (await env.app.jobs.repository.get(job.id)).revisions['1'].external?.hasReceipt === true
      }, 'receipt not saved before cancel')
      await env.app.jobs.cancel(job.id, env.app.room.id)
      await untilJob(async () => {
        return (await env.app.jobs.repository.get(job.id)).revisions['1'].delivery !== 'pending'
      }, 'cancel did not settle')
      const value = (await env.app.jobs.repository.get(job.id)).revisions['1']
      expect(value.delivery).toBe('suppressed')
      expect(
        env.remote.calls.some((call) => {
          return call.path === '/interrupt'
        })
      ).toBe(false)
      if (mode === 'queued') {
        expect(value.state).toBe('cancelled')
        expect(env.remote.deletes).toEqual([[env.remote.submissions[0].id]])
      } else {
        expect(value.state).toBe('outcome_unknown')
        if (mode === 'running') {
          expect(env.remote.deletes).toHaveLength(0)
        }
        env.remote.mode = 'ok'
        const reconciled = await env.app.jobs.reconcile(job.id, env.app.room.id, false)
        expect(reconciled.result?.artifactIds).toHaveLength(1)
        expect(reconciled.delivery).toBe('suppressed')
      }
      expect(env.remote.submissions).toHaveLength(1)
      expect(
        env.app.store.listOutbound(env.app.room.id).some((outbound) => {
          return outbound.id === 'job:' + job.id + ':1:result' && outbound.state === 'sent'
        })
      ).toBe(false)
    } finally {
      await env.close()
    }
  }
}, 15000)

test('stop/new and action revocation retire all future Comfy delivery while preserving owned remote receipts', async () => {
  for (const change of ['stop', 'new', 'permission'] as const) {
    const env = await comfyFixture()
    try {
      env.remote.mode = 'wait'
      await env.app.coordinator.receive(env.app.room.id, '/画图no blue sky')
      await env.remote.started
      const job = await env.latestJob()
      await untilJob(async () => {
        return (await env.app.jobs.repository.get(job.id)).revisions['1'].external?.hasReceipt === true
      }, 'receipt before retirement missing')
      if (change === 'stop') {
        await env.app.coordinator.receive(env.app.room.id, '/stop')
      }
      if (change === 'new') {
        await env.app.coordinator.receive(env.app.room.id, '/new')
      }
      if (change === 'permission') {
        env.app.config.framework.defaults.permissions.rules = [
          { effect: 'deny', capabilities: ['comfy_generate'], subjects: [{ kind: 'everyone' }] }
        ]
      }
      env.remote.mode = 'ok'
      const value = await env.settled(job.id)
      expect(value.delivery).toBe('suppressed')
      expect(env.remote.submissions).toHaveLength(1)
      expect(env.app.store.getOutbound('job:' + job.id + ':1:result')?.state).not.toBe('sent')
    } finally {
      await env.close()
    }
  }
}, 15000)

test('remote unknown POST never resubmits after recovery/restart and local output refusal never downloads a foreign path', async () => {
  for (const mode of ['unknown', 'bad-path', 'bad-mime', 'oversize'] as const) {
    const env = await comfyFixture()
    try {
      env.remote.mode = mode
      if (mode === 'oversize') {
        env.app.config.resources.config.comfyServices[0].maxImageBytes = 1024
      }
      await env.app.coordinator.receive(env.app.room.id, '/画图no blue sky')
      const job = await env.latestJob()
      const result = await env.settled(job.id)
      if (mode === 'unknown') {
        expect(result.state).toBe('outcome_unknown')
      } else {
        expect(result.state).toBe('failed')
      }
      expect(result.result?.artifactIds ?? []).toHaveLength(0)
      if (mode === 'bad-path') {
        expect(
          env.remote.calls.some((call) => {
            return call.path === '/view'
          })
        ).toBe(false)
      }
      await env.app.restart()
      expect(env.remote.submissions).toHaveLength(1)
    } finally {
      await env.close()
    }
  }
}, 15000)

test('lost Worker checkpoint can be recovered after restart or manually reconciled/cancelled from the original Core receipt', async () => {
  for (const intent of ['restart', 'reconcile', 'cancel'] as const) {
    const env = await comfyFixture()
    try {
      env.remote.mode = 'wait'
      const plugins = env.app.coordinator.plugins!
      const execute = plugins.execute.bind(plugins)
      const saved = Promise.withResolvers<void>()
      let inject = true
      plugins.execute = async (...args) => {
        const phase = args[5] ?? 'execute'
        if (inject && args[1] === 'plugin:comfyui-pro/generate' && phase === 'recover') {
          throw new Error('authored recover transport unavailable')
        }
        const result = await execute(...args)
        if (inject && args[1] === 'plugin:comfyui-pro/generate' && phase === 'execute') {
          saved.resolve()
          if (intent === 'restart') {
            await new Promise<void>((_resolve, reject) => {
              args[4].addEventListener(
                'abort',
                () => {
                  reject(args[4].reason)
                },
                { once: true }
              )
            })
          }
          throw new Error('authored pending checkpoint lost after Core receipt')
        }
        return result
      }
      await env.app.coordinator.receive(env.app.room.id, '/画图no checkpoint loss')
      await saved.promise
      const job = await env.latestJob()
      if (intent === 'restart') {
        inject = false
        await env.app.restart()
        env.remote.mode = 'ok'
        const value = await env.settled(job.id)
        expect(value.state).toBe('succeeded')
        expect(value.result?.artifactIds).toHaveLength(1)
      } else {
        const value = await env.settled(job.id)
        expect(value.state).toBe('outcome_unknown')
        expect(value.external?.hasReceipt).toBe(true)
        inject = false
        if (intent === 'reconcile') {
          env.remote.mode = 'ok'
        }
        const updated = await env.app.jobs.reconcile(job.id, env.app.room.id, intent === 'cancel')
        if (intent === 'cancel') {
          expect(updated.state).toBe('cancelled')
          expect(env.remote.deletes).toEqual([[env.remote.submissions[0].id]])
        } else {
          expect(updated.state).toBe('succeeded')
          expect(updated.result?.artifactIds).toHaveLength(1)
        }
        expect(env.app.store.getOutbound('job:' + job.id + ':1:result')?.artifactIds ?? []).toHaveLength(0)
      }
      expect(env.remote.submissions).toHaveLength(1)
    } finally {
      await env.close()
    }
  }
}, 20000)

test('concurrent receipt inspection serializes every successor and publishes one artifact/view per owned output', async () => {
  const env = await comfyFixture()
  try {
    env.remote.mode = 'wait'
    await env.app.coordinator.receive(env.app.room.id, '/画图no concurrent poll')
    await env.remote.started
    const job = await env.latestJob()
    await untilJob(async () => {
      return (await env.app.jobs.repository.get(job.id)).revisions['1'].external?.hasReceipt === true
    }, 'receipt before concurrent poll missing')
    const { ArtifactStore } = await import('../../pi-im-bot/src/artifacts/store')
    env.remote.mode = 'ok'
    const broker = env.app.coordinator.plugins!.managed!.comfy
    const owner = { instance: 'comfyui-pro', room: env.app.room.id, job: job.id, revision: 1 }
    const results = await Promise.all(
      Array.from({ length: 12 }, () => {
        return broker.inspect(
          owner,
          'render',
          0,
          'poll',
          new ArtifactStore(env.app.config.dataDir, env.app.room.id),
          AbortSignal.timeout(10000),
          () => {}
        )
      })
    )
    expect(
      new Set(
        results.flatMap((result) => {
          return result.artifactIds
        })
      ).size
    ).toBe(1)
    expect(
      results.every((result) => {
        return result.status === 'succeeded'
      })
    ).toBe(true)
    expect(
      env.remote.calls.filter((call) => {
        return call.path === '/view'
      })
    ).toHaveLength(1)
    expect((await env.settled(job.id)).state).toBe('succeeded')
  } finally {
    await env.close()
  }
})
