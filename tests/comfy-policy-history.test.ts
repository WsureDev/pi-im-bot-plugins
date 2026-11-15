import { expect, test } from 'bun:test'
import { comfyFixture, manageComfy } from './comfy-fixture'
import { responsesReply } from '../../pi-im-bot/tests/responses-fixture'
import { pluginToolName } from '../../pi-im-bot/src/plugins/identity'
import { untilJob } from '../../pi-im-bot/tests/job-harness'

test('workflow and node step overrides remain scope-shared, workflow-local and persistent, with explicit off/clear and range refusal', async () => {
  const env = await comfyFixture()
  try {
    await manageComfy(env, { action: 'steps', value: '7 25' })
    await manageComfy(env, { action: 'workflow', value: 'second' })
    await env.app.coordinator.receive(env.app.room.id, '/画图no blue sky')
    await env.settled((await env.latestJob()).id)
    expect(env.remote.submissions[0].payload.prompt['7'].inputs.steps).toBe(12)
    await manageComfy(env, { action: 'steps', value: '7 30' })
    await manageComfy(env, { action: 'workflow', value: 'fixture' })
    await env.app.coordinator.receive(env.app.room.id, '/new')
    await env.app.restart()
    await env.app.coordinator.receive(env.app.room.id, '/画图no blue sky')
    await env.settled((await env.latestJob()).id)
    expect(env.remote.submissions[1].payload.prompt['7'].inputs.steps).toBe(25)
    await expect(manageComfy(env, { action: 'steps', value: '999 20' })).rejects.toThrow('绑定')
    await manageComfy(env, { action: 'steps', value: '7 off' })
    await manageComfy(env, { action: 'workflow', value: 'second' })
    const listed = await manageComfy(env, { action: 'steps', value: 'list' })
    expect(JSON.stringify(listed)).toContain('30')
    await manageComfy(env, { action: 'steps', value: 'clear' })
    const cleared = await manageComfy(env, { action: 'steps', value: 'list' })
    expect(JSON.stringify(cleared)).not.toContain('"7":30')
  } finally {
    await env.close()
  }
}, 15000)

test('trusted management permission, instance lock and whitelist are real gates; Mock labels never become administrators', async () => {
  const env = await comfyFixture()
  try {
    await env.app.coordinator.receive(env.app.room.id, '/comfy_lock on', 'administrator', 'owner')
    expect(env.app.store.listMessages(env.app.room.id).at(-1)?.text).toContain('comfy_manage')
    expect(env.remote.submissions).toHaveLength(0)
    await manageComfy(env, { action: 'lock', value: 'on' })
    await env.app.coordinator.receive(env.app.room.id, '/画图no blue sky')
    expect((await env.settled((await env.latestJob()).id)).state).toBe('failed')
    expect(env.remote.submissions).toHaveLength(0)
    await manageComfy(env, { action: 'lock', value: 'off' })
    env.instance.settings.allowed_scopes = []
    await env.app.coordinator.receive(env.app.room.id, '/画图no blue sky')
    expect((await env.settled((await env.latestJob()).id)).state).toBe('failed')
    expect(env.remote.submissions).toHaveLength(0)
  } finally {
    await env.close()
  }
})

for (const entry of ['direct', 'start_job'] as const) {
  for (const keep of [false, true]) {
    test(
      'real Pi ' +
        entry +
        ' history projection keep=' +
        keep +
        ' preserves immutable trace and does not add model calls',
      async () => {
        const prompt = 'AUTHORED_GENERATED_PROMPT_SENTINEL'
        const env = await comfyFixture((_raw, call) => {
          if (call === 1) {
            if (entry === 'direct') {
              return responsesReply({
                kind: 'tool',
                name: pluginToolName('comfyui-pro', 'generate'),
                arguments: { prompt, direct_send: true }
              })
            }
            return responsesReply({
              kind: 'tool',
              name: 'start_job',
              arguments: {
                title: 'Comfy authored job',
                capability: 'plugin:comfyui-pro/generate',
                arguments: { prompt, direct_send: true }
              }
            })
          }
          return responsesReply({ kind: 'text', text: 'Task accepted' })
        })
        try {
          if (keep) {
            await manageComfy(env, { action: 'history', value: 'on' })
          }
          const run = await env.app.coordinator.receive(env.app.room.id, 'please render an authored image')
          expect((await env.app.coordinator.waitRun(run!.id)).status).toBe('completed')
          await untilJob(async () => {
            return (await env.app.jobs.repository.list(env.app.room.id)).length === 1
          }, 'Pi did not create owned Comfy job')
          const value = await env.settled((await env.latestJob()).id)
          expect(value.state).toBe('succeeded')
          expect(env.app.requests).toHaveLength(2)
          expect(env.app.requests[1].includes(prompt)).toBe(keep)
          expect(
            env.app.store.listTraces(env.app.room.id).some((trace) => {
              return trace.detail.includes(prompt)
            })
          ).toBe(true)
          expect(env.app.store.getRun(run!.id)?.rawReply).toBe('Task accepted')
          expect(env.remote.submissions[0].payload.prompt['4'].inputs.text).toBe(prompt)
        } finally {
          await env.close()
        }
      },
      10000
    )
  }
}

test('scope cooldown is atomic for simultaneous Jobs, validation does not consume it, and sensitive/private policies prevent GPU submission', async () => {
  const env = await comfyFixture()
  try {
    const { localIdentity } = await import('../../pi-im-bot/src/permissions/identity')
    env.instance.settings.cooldown_seconds = 60
    env.instance.settings.group_sensitive = 'lite'
    const invocation = env.app.coordinator.jobInvocation(
      env.app.room.id,
      localIdentity('web', 'caller'),
      'concurrent authored draw'
    )
    const blocked = await env.app.jobs.start(
      invocation,
      'sensitive',
      { kind: 'tool', capability: 'plugin:comfyui-pro/generate', arguments: { prompt: 'poop' } },
      'sensitive'
    )
    expect((await env.settled(blocked.id)).state).toBe('failed')
    expect(env.remote.submissions).toHaveLength(0)
    const jobs = await Promise.all(
      ['first', 'second'].map((id) => {
        return env.app.jobs.start(
          invocation,
          id,
          {
            kind: 'tool',
            capability: 'plugin:comfyui-pro/generate',
            arguments: { prompt: 'blue sky', direct_send: true }
          },
          id
        )
      })
    )
    const results = await Promise.all(
      jobs.map((job) => {
        return env.settled(job.id)
      })
    )
    expect(
      results
        .map((result) => {
          return result.state
        })
        .sort()
    ).toEqual(['failed', 'succeeded'])
    expect(env.remote.submissions).toHaveLength(1)
    const room = env.app.coordinator.createMockRoom('Private authored', 'direct')
    env.instance.settings.allow_private = false
    const privateInvocation = env.app.coordinator.jobInvocation(
      room.id,
      localIdentity('web', 'caller'),
      'private draw'
    )
    const denied = await env.app.jobs.start(
      privateInvocation,
      'private',
      { kind: 'tool', capability: 'plugin:comfyui-pro/generate', arguments: { prompt: 'blue sky' } },
      'private'
    )
    await untilJob(async () => {
      return (await env.app.jobs.repository.get(denied.id)).revisions['1'].delivery !== 'pending'
    }, 'private policy did not settle')
    expect((await env.app.jobs.repository.get(denied.id)).revisions['1'].state).toBe('failed')
    expect(env.remote.submissions).toHaveLength(1)
  } finally {
    await env.close()
  }
}, 15000)
