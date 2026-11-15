import { expect, test } from 'bun:test'
import { comfyFixture } from './comfy-fixture'
import { untilJob, BACKGROUND_CONTEXT } from '../../pi-im-bot/tests/job-harness'
import { localIdentity } from '../../pi-im-bot/src/permissions/identity'
import { JobFacts } from '../../pi-im-bot/src/jobs/documents'

test('manual pending reconciliation and cancellation retain partial facts, then completion updates the original JobFacts without any new chat delivery', async () => {
  const env = await comfyFixture()
  try {
    env.remote.mode = 'partial-running'
    await env.app.coordinator.receive(env.app.room.id, '/画图no partial facts -c 2')
    const job = await env.latestJob()
    await untilJob(() => {
      return (
        env.remote.calls.some((call) => {
          return call.path === '/view'
        }) &&
        env.remote.tasks.get(env.remote.submissions[1]?.id)?.state === 'running' &&
        env.worker.manager.status().invocations === 0
      )
    }, 'one image and known running remainder not observed')
    await env.app.jobs.cancel(job.id, env.app.room.id)
    const stopped = await env.settled(job.id)
    expect(stopped.state).toBe('outcome_unknown')
    expect(stopped.result?.businessStatus).toBe('partial')
    expect(stopped.result?.factsComplete).toBe(false)
    expect(stopped.result?.artifactIds).toHaveLength(1)
    const messages = env.app.store.listMessages(env.app.room.id).map((message) => {
      return message.id
    })
    const invocation = env.app.coordinator.jobInvocation(
      env.app.room.id,
      localIdentity('web', 'reader'),
      'facts only'
    )
    const conversation = await env.app.runtime.ensureConversation(
      env.app.config,
      invocation.room,
      invocation.input
    )
    async function facts() {
      const snapshot = await env.app.runtime.native.snapshot(JobFacts, conversation, BACKGROUND_CONTEXT)
      return snapshot?.results.find((result) => {
        return result.id === job.id
      })
    }
    for (const cancel of [false, true, false]) {
      const updated = await env.app.jobs.reconcile(job.id, env.app.room.id, cancel)
      expect(updated.state).toBe('outcome_unknown')
      expect(updated.result?.businessStatus).toBe('partial')
      expect(updated.result?.artifactIds).toEqual(stopped.result?.artifactIds)
      expect(updated.result?.factsComplete).toBe(false)
      expect((await facts())?.artifactIds).toEqual(stopped.result?.artifactIds)
    }
    expect(env.remote.deletes).toHaveLength(0)
    await env.app.restart()
    env.remote.mode = 'ok'
    const completed = await env.app.jobs.reconcile(job.id, env.app.room.id, false)
    expect(completed.state).toBe('succeeded')
    expect(completed.result?.artifactIds).toHaveLength(2)
    expect(completed.result?.factsComplete).toBe(true)
    expect((await facts())?.artifactIds).toEqual(completed.result?.artifactIds)
    expect(completed.delivery).toBe('suppressed')
    expect(env.remote.submissions).toHaveLength(2)
    expect(
      env.app.store.listMessages(env.app.room.id).map((message) => {
        return message.id
      })
    ).toEqual(messages)
    expect(env.app.store.getOutbound('job:' + job.id + ':1:result')?.state).not.toBe('sent')
  } finally {
    await env.close()
  }
})
