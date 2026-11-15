import { expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { parseStatusArguments } from '../plugins/status/src/settings'
import { statusCard } from '../plugins/status/src/card'

import { pluginFixture } from '../../pi-im-bot/tests/plugin-fixture'
import { jobHarness } from '../../pi-im-bot/tests/job-harness'
import { responsesReply } from '../../pi-im-bot/tests/responses-fixture'
import { PluginService } from '../../pi-im-bot/src/plugins/service'
import { PluginInstanceSchema } from '../../pi-im-bot/src/plugins/config'
import { importPlugin } from '../../pi-im-bot/src/plugins/package'
import { fillConfigDefaults } from '../../pi-im-bot/src/plugins/configuration/values'
import { ResourcesConfigSchema } from '../../pi-im-bot/src/resources/schema'
import { ResourceLibrary } from '../../pi-im-bot/src/resources/library'
import { ArtifactStore } from '../../pi-im-bot/src/artifacts/store'
import { pluginToolName } from '../../pi-im-bot/src/plugins/identity'

test('the command parser handles documented forms and rejects arguments instead of falling through to an agent', () => {
  expect(parseStatusArguments('')).toEqual({ format: 'auto' })
  expect(parseStatusArguments('--json')).toEqual({ format: 'json' })
  expect(parseStatusArguments('help')).toEqual({ format: 'help' })
  expect(() => {
    parseStatusArguments('--unknown')
  }).toThrow('用法')
})

test('the migrated plugin uses real Bot routing/RPC/artifacts, preserves /status, shares preferences, and respects revocation', async () => {
  const env = await pluginFixture()
  const root = resolve(import.meta.dir, '..')
  const instance = PluginInstanceSchema.parse({
    id: 'system-status',
    name: '系统状态',
    sourceDir: join(root, 'plugins/status'),
    enabled: true,
    grants: ['system.status', 'artifact.write']
  })
  const bundle = await importPlugin(instance, root, env.manager.paths.packageDir)
  instance.settings = fillConfigDefaults(bundle.configuration!, {})
  const library = new ResourceLibrary(ResourcesConfigSchema.parse({ plugins: [instance] }), [], [], [bundle])
  const app = await jobHarness(
    (_raw: string, call: number) => {
      if (call === 1) {
        return responsesReply({
          kind: 'tool',
          name: pluginToolName('system-status', 'inspect'),
          arguments: { format: 'text' }
        })
      }
      return responsesReply({ kind: 'text', text: 'STATUS_TOOL_DONE' })
    },
    library,
    (coordinator, config) => {
      config.bot.plugins = env.manager.config
      config.framework.defaults.resources.tools = { mode: 'selected', ids: ['plugin:system-status/inspect'] }
      coordinator.plugins = new PluginService(() => {
        return config
      }, env.manager)
    }
  )
  try {
    app.config.framework.defaults.behavior.agentEnabled = false
    const room = app.coordinator.requireRoom(app.room.id)
    app.store.saveRoom({
      ...room,
      settings: { extensions: { settings: { 'system-status': { bot_name: 'Shared Group Bot' } } } }
    })
    await app.coordinator.receive(app.room.id, '/状态 --card', 'alice', 'Alice')
    const outbound = app.store.listOutbound(app.room.id).find((item) => {
      return item.artifactIds.length === 1
    })
    expect(outbound?.state).toBe('sent')
    expect(outbound?.text).toBe('')
    const artifact = await new ArtifactStore(app.config.dataDir, app.room.id).content(
      outbound!.artifactIds[0]
    )
    expect(artifact.metadata.mimeType).toBe('image/png')
    const png = Buffer.from(await artifact.file.arrayBuffer())
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.readUInt32BE(16)).toBe(960)
    expect(png.readUInt32BE(20)).toBe(650)
    expect(app.requests).toHaveLength(0)
    await app.coordinator.receive(app.room.id, '/sysstatus --text', 'bob', 'Bob')
    const textMessage = app.store.listMessages(app.room.id).at(-1)
    expect(textMessage?.text).toContain('Shared Group Bot')
    expect(textMessage?.text).toContain('GPU：')
    expect(textMessage?.attachments).toHaveLength(0)
    await app.coordinator.receive(app.room.id, '/status', 'bob', 'Bob')
    expect(app.store.listMessages(app.room.id).at(-1)?.text).toContain('会话：')
    expect(app.store.listMessages(app.room.id).at(-1)?.attachments).toHaveLength(0)
    await app.coordinator.receive(app.room.id, '/sysstatus --unknown')
    expect(app.store.listMessages(app.room.id).at(-1)?.text).toContain('用法')
    expect(app.requests).toHaveLength(0)
    app.config.framework.defaults.permissions.rules = [
      { effect: 'deny', capabilities: ['runtime_status'], subjects: [{ kind: 'mock' }] }
    ]
    await app.coordinator.receive(app.room.id, '/sysstatus --text')
    expect(app.store.listMessages(app.room.id).at(-1)?.text).toContain('runtime_status')
    app.config.framework.defaults.permissions.rules = []
    app.config.framework.defaults.behavior.agentEnabled = true
    const run = await app.coordinator.receive(app.room.id, '请使用状态工具')
    expect((await app.coordinator.waitRun(run!.id)).status).toBe('completed')
    expect(app.requests).toHaveLength(2)
    expect(app.requests[1]).toContain('Bot 控制面')
    const output = await mkdtemp('/tmp/pi-status-migration-proof-')
    await Bun.write(join(output, 'status.png'), png)
    await Bun.write(
      join(output, 'result.json'),
      JSON.stringify({
        ok: true,
        width: 960,
        height: 650,
        bytes: png.length,
        backend: 'authored-child-process-fixture',
        realContainers: 0,
        paidModelCalls: 0,
        directCommandModelCalls: 0,
        toolFakeModelCalls: app.requests.length,
        reservedStatusPreserved: true,
        permissionRevocation: true
      })
    )
    console.log('Status migration proof: ' + output)
  } finally {
    await app.close()
    await env.close()
  }
})
