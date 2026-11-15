import { expect, test } from 'bun:test'
import { foundationFixture } from './foundation-fixture'
import { responsesReply } from '../../pi-im-bot/tests/responses-fixture'
import { JobActivity, JobAdmissions, JobRequests } from '../../pi-im-bot/src/jobs/index'
import { JobSummarySchema } from '../../pi-im-bot/src/jobs/schema'
import { untilJob, BACKGROUND_CONTEXT } from '../../pi-im-bot/tests/job-harness'

for (const limit of ['global', 'scope', 'run'] as const) {
  test(
    'known ' +
      limit +
      ' render refusal delivers normal text once and seals its request across quota release and restart',
    async () => {
      const answer = 'normal answer after ' + limit + ' quota refusal'
      const providerRelease = Promise.withResolvers<void>()
      const env = await foundationFixture(async () => {
        await providerRelease.promise
        return responsesReply({ kind: 'text', text: answer })
      })
      try {
        await env.app.coordinator.receive(env.app.room.id, '/usetts on')
        await env.app.jobs.repository.initialize()
        if (limit === 'global') {
          env.app.config.bot.agent.maxOutstandingJobs = 1
        }
        if (limit === 'scope') {
          env.app.config.framework.defaults.behavior.maxOutstandingJobs = 1
        }
        await env.app.runtime.native.commit(async (tx) => {
          const activity = await tx.doc(JobActivity)
          const id = crypto.randomUUID()
          activity.jobs[id] = JobSummarySchema.parse({
            id,
            roomId: env.app.room.id,
            title: 'quota fixture',
            revision: 1,
            state: 'running',
            delivery: 'pending',
            createdAt: 1,
            updatedAt: 1
          })
        }, BACKGROUND_CONTEXT)
        const run = await env.app.coordinator.receive(env.app.room.id, 'respond')
        if (limit === 'run') {
          await env.app.runtime.native.commit(async (tx) => {
            const admissions = await tx.doc(JobAdmissions, run!.id, null)
            admissions.count = env.app.config.framework.defaults.behavior.maxJobsPerRun
          }, BACKGROUND_CONTEXT)
        }
        providerRelease.resolve()
        const finished = await env.app.coordinator.waitRun(run!.id)
        expect(finished.status).toBe('completed')
        expect(finished.rawReply).toBe(answer)
        const original = env.app.store.listOutbound(env.app.room.id).find((outbound) => {
          return outbound.render
        })!
        expect(original).toMatchObject({ state: 'sent', renderFallback: { code: limit + '_capacity' } })
        expect(original.renderJobId).toBeUndefined()
        expect(env.posts).toBe(0)
        const key = run!.id + ':' + original.id + ':render'
        const receipt = await env.app.runtime.native.snapshot(JobRequests, key, BACKGROUND_CONTEXT)
        expect(receipt?.jobId).toBeNull()
        expect(String(receipt?.renderRejection?.code)).toBe(limit + '_capacity')
        await env.app.runtime.native.commit(async (tx) => {
          const activity = await tx.doc(JobActivity)
          activity.jobs = {}
          const admissions = await tx.doc(JobAdmissions, run!.id, null)
          admissions.count = 0
        }, BACKGROUND_CONTEXT)
        await env.app.restart()
        expect(env.posts).toBe(0)
        expect(env.app.requests).toHaveLength(1)
        expect(
          env.app.store.listMessages(env.app.room.id).filter((m) => {
            return m.role === 'assistant' && m.text === answer
          })
        ).toHaveLength(1)
        expect((await env.app.jobs.repository.list()).length).toBe(0)
      } finally {
        await env.close()
      }
    }
  )
}

test('lost rejection response recovers the durable refusal after quota release without reselecting or creating a Job', async () => {
  for (const prepared of [false, true]) {
    const env = await foundationFixture(() => {
      return responsesReply({ kind: 'text', text: 'recover refused answer' })
    })
    try {
      await env.app.coordinator.receive(env.app.room.id, '/usetts on')
      env.app.config.bot.agent.maxOutstandingJobs = 1
      await env.app.jobs.repository.initialize()
      await env.app.runtime.native.commit(async (tx) => {
        const activity = await tx.doc(JobActivity)
        const id = crypto.randomUUID()
        activity.jobs[id] = JobSummarySchema.parse({
          id,
          roomId: env.app.room.id,
          title: 'quota',
          revision: 1,
          state: 'running',
          delivery: 'pending',
          createdAt: 1,
          updatedAt: 1
        })
      }, BACKGROUND_CONTEXT)
      const present = env.app.jobs.present.bind(env.app.jobs)
      env.app.jobs.present = async (outbound) => {
        try {
          return await present(outbound)
        } catch {
          throw new Error('authored lost admission response')
        }
      }
      const run = await env.app.coordinator.receive(env.app.room.id, 'respond')
      const finished = await env.app.coordinator.waitRun(run!.id)
      expect(finished.status).toBe('completed')
      expect(finished.presentation?.state).toBe('unknown')
      expect(
        env.app.store.listOutbound(env.app.room.id).find((o) => {
          return o.render
        })?.state
      ).toBe('rendering')
      expect(
        env.app.store.listMessages(env.app.room.id).filter((m) => {
          return m.role === 'assistant'
        })
      ).toHaveLength(1) // policy ACK only
      await env.app.runtime.native.commit(async (tx) => {
        const activity = await tx.doc(JobActivity)
        activity.jobs = {}
      }, BACKGROUND_CONTEXT)
      if (prepared) {
        const outbound = env.app.store.listOutbound(env.app.room.id).find((o) => {
          return o.render
        })!
        const key = run!.id + ':' + outbound.id + ':render'
        const receipt = await env.app.runtime.native.snapshot(JobRequests, key, BACKGROUND_CONTEXT)
        // Authored exit window after fallback preparation, before any platform request or ACK.
        env.app.store.saveOutbound({
          ...outbound,
          state: 'prepared',
          renderFallback: receipt!.renderRejection
        })
      }
      await env.app.restart()
      await untilJob(() => {
        return env.app.store.getRun(run!.id)?.presentation?.state === 'sent'
      }, 'refusal recovery did not deliver text')
      await env.app.restart()
      expect(env.posts).toBe(0)
      expect(env.app.requests).toHaveLength(1)
      expect(await env.app.jobs.repository.list()).toHaveLength(0)
      expect(
        env.app.store.listMessages(env.app.room.id).filter((m) => {
          return m.text === 'recover refused answer'
        })
      ).toHaveLength(1)
    } finally {
      await env.close()
    }
  }
})

test('lost accepted response recovers the same Job even when current capacity is full; no text fallback or second POST', async () => {
  const env = await foundationFixture(() => {
    return responsesReply({ kind: 'text', text: 'unknown admission' })
  })
  try {
    await env.app.coordinator.receive(env.app.room.id, '/usetts on')
    env.mode = 'wait'
    const present = env.app.jobs.present.bind(env.app.jobs)
    env.app.jobs.present = async (outbound) => {
      await present(outbound)
      throw new Error('lost accepted response')
    }
    const run = await env.app.coordinator.receive(env.app.room.id, 'respond')
    expect((await env.app.coordinator.waitRun(run!.id)).presentation?.state).toBe('unknown')
    await env.started
    const job = await env.latestJob()
    env.app.config.bot.agent.maxOutstandingJobs = 1
    env.app.jobs.present = present
    const outbound = env.app.store.listOutbound(env.app.room.id).find((o) => {
      return o.render
    })!
    expect(await present(outbound)).toBe(job.id)
    env.release()
    expect((await env.settled(job.id)).delivery).toBe('sent')
    expect(env.app.store.getRun(run!.id)?.presentation?.state).toBe('sent')
    await env.app.restart()
    expect(env.posts).toBe(1)
    expect(env.app.requests).toHaveLength(1)
    expect(
      env.app.store.listOutbound(env.app.room.id).filter((o) => {
        return o.runId === run!.id
      })
    ).toHaveLength(1)
  } finally {
    await env.close()
  }
})

test('cancellation or revocation after a durable refusal cannot turn it into a late text fallback', async () => {
  for (const change of ['stop', 'revoke']) {
    const answer = 'do not deliver after ' + change
    const env = await foundationFixture(() => {
      return responsesReply({ kind: 'text', text: answer })
    })
    try {
      await env.app.coordinator.receive(env.app.room.id, '/usetts on')
      env.app.config.bot.agent.maxOutstandingJobs = 1
      await env.app.jobs.repository.initialize()
      await env.app.runtime.native.commit(async (tx) => {
        const id = crypto.randomUUID()
        const activity = await tx.doc(JobActivity)
        activity.jobs[id] = JobSummarySchema.parse({
          id,
          roomId: env.app.room.id,
          title: 'quota',
          revision: 1,
          state: 'running',
          delivery: 'pending',
          createdAt: 1,
          updatedAt: 1
        })
      }, BACKGROUND_CONTEXT)
      const present = env.app.jobs.present.bind(env.app.jobs)
      env.app.jobs.present = async (outbound) => {
        try {
          return await present(outbound)
        } catch (error) {
          if (change === 'stop') {
            await env.app.runtime.native.commit(async (tx) => {
              const activity = await tx.doc(JobActivity)
              activity.jobs = {}
            }, BACKGROUND_CONTEXT)
            env.app.coordinator.stop(env.app.room.id)
          } else {
            env.app.config.framework.defaults.permissions.rules = [
              { effect: 'deny', capabilities: ['tts_synthesize'], subjects: [{ kind: 'everyone' }] }
            ]
          }
          throw error
        }
      }
      const run = await env.app.coordinator.receive(env.app.room.id, 'respond')
      await env.app.coordinator.waitRun(run!.id)
      const outbound = env.app.store.listOutbound(env.app.room.id).find((o) => {
        return o.render
      })!
      expect(['suppressed', 'cancelled']).toContain(outbound.state)
      env.app.config.framework.defaults.permissions.rules = []
      await env.app.runtime.native.commit(async (tx) => {
        const activity = await tx.doc(JobActivity)
        activity.jobs = {}
      }, BACKGROUND_CONTEXT)
      await env.app.restart()
      expect(env.posts).toBe(0)
      expect(
        env.app.store.listMessages(env.app.room.id).filter((m) => {
          return m.role === 'assistant' && m.text === answer
        })
      ).toHaveLength(0)
    } finally {
      await env.close()
    }
  }
})
