import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { join, resolve } from 'node:path'
import { pluginConsoleFixture } from '../../pi-im-bot/tests/plugin-console-fixture'
import { untilJob } from '../../pi-im-bot/tests/job-harness'
import { PluginInstaller } from '../../pi-im-bot/src/plugins/install/service'
import { PluginMarket } from '../../pi-im-bot/src/plugins/market/service'
import { registerPluginInstallRoutes } from '../../pi-im-bot/src/http/plugin-install-routes'
import { registerPluginRoutes } from '../../pi-im-bot/src/http/plugin-routes'
import { registerPluginConfigRoutes } from '../../pi-im-bot/src/http/plugin-config-routes'
import { PluginConfigurationEditor } from '../../pi-im-bot/src/plugins/configuration/editor'
import {
  PluginEditorViewSchema,
  type PluginManagementPatchSchema
} from '../../pi-im-bot/src/plugins/contracts'
import { PluginConfigViewSchema } from '../../pi-im-bot/src/plugins/configuration/contracts'
import { InstallationSchema } from '../../pi-im-bot/src/plugins/install/contracts'
import { requestedGrants } from '../../pi-im-bot/src/plugins/management'
import type { ConfigValues } from '../../pi-im-bot/src/plugins/configuration/schema'
import type { z } from 'zod'

for (const id of ['gsvi-tts', 'comfyui-pro']) {
  test(
    'installed ' + id + ' management changes only defined PATCH fields and supports deliberate clearing',
    async () => {
      const fixture = await pluginConsoleFixture()
      const installer = new PluginInstaller(fixture.editor)
      try {
        const archive = join(fixture.env.root, id + '.zip')
        const pack = Bun.spawn(
          [process.execPath, resolve(import.meta.dir, '../scripts/pack.ts'), id, archive],
          { stdout: 'ignore', stderr: 'pipe', stdin: 'ignore' }
        )
        expect(await pack.exited).toBe(0)
        const http = new Hono()
        http.onError((error, c) => {
          return c.json({ error: error.message }, 400)
        })
        registerPluginInstallRoutes(http, installer, new PluginMarket(installer), () => {})
        registerPluginRoutes(http, fixture.editor, () => {})
        registerPluginConfigRoutes(
          http,
          new PluginConfigurationEditor(fixture.editor, fixture.framework, fixture.app.coordinator),
          () => {}
        )
        async function view() {
          return PluginEditorViewSchema.parse(await (await http.request('/api/plugins')).json())
        }
        const initial = await view()
        const form = new FormData()
        form.set('revision', initial.revision)
        form.set('archive', Bun.file(archive), id + '.zip')
        const uploaded = await http.request('/api/plugins/install/upload', { method: 'POST', body: form })
        expect(uploaded.status).toBe(202)
        const receipt = InstallationSchema.parse(await uploaded.json())
        await untilJob(async () => {
          return (await installer.list()).some((job) => {
            return job.id === receipt.id && ['succeeded', 'failed'].includes(job.stage)
          })
        }, 'ZIP installation did not finish')
        expect((await installer.list())[0].stage).toBe('succeeded')
        const config = PluginConfigViewSchema.parse(
          await (await http.request('/api/plugins/' + id + '/configuration')).json()
        )
        let values: ConfigValues = { ...config.values, voice: 'saved voice' }
        if (id === 'comfyui-pro') {
          values = { ...config.values, default_negative: 'saved negative' }
        }
        const saved = await http.request('/api/plugins/' + id + '/configuration', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            revision: config.revision,
            release: config.release,
            target: { level: 'instance' },
            values
          })
        })
        expect(saved.status).toBe(200)
        function current() {
          return structuredClone(
            fixture.app.config.resources.config.plugins.find((plugin) => {
              return plugin.id === id
            })!
          )
        }
        let expected = current()
        const grants = requestedGrants((await view()).plugins[0].bundle!)
        const maps: {
          connectors: Record<string, string>
          services: Record<string, string>
          dependencies: Record<string, string>
        } = {
          connectors: { catalog: 'catalog-fixture' },
          services: { speech: 'speech-fixture' },
          dependencies: { helper: 'helper-fixture' }
        }
        if (id === 'comfyui-pro') {
          maps.services = { render: 'render-fixture' }
        }
        async function patch(update: z.infer<typeof PluginManagementPatchSchema>) {
          const state = await view()
          const response = await http.request('/api/plugins/' + id, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ revision: state.revision, patch: update })
          })
          expect(response.status).toBe(200)
          expected = { ...expected, ...update }
          expect(current()).toEqual(expected)
        }
        await patch({ grants, ...maps })
        for (const enabled of [false, true, true, false, false]) {
          await patch({ enabled })
        }
        await patch({ name: 'Renamed fixture' })
        await patch({ grants: ['artifact.read'] })
        for (const key of ['connectors', 'services', 'dependencies'] as const) {
          await patch({ [key]: { changed: 'changed-fixture' } })
        }
        const beforeUndefined = current()
        const state = await view()
        await fixture.editor.manage(state.revision, id, {
          name: undefined,
          enabled: undefined,
          grants: undefined,
          services: undefined,
          connectors: undefined,
          dependencies: undefined
        })
        expect(current()).toEqual(beforeUndefined)
        await fixture.editor.manage((await view()).revision, id, {
          name: 'Internal rename',
          grants: undefined,
          connectors: undefined,
          services: undefined,
          dependencies: undefined,
          enabled: undefined
        })
        expected.name = 'Internal rename'
        expect(current()).toEqual(expected)
        await fixture.editor.manage((await view()).revision, id, {
          services: {},
          grants: undefined,
          connectors: undefined,
          dependencies: undefined
        })
        expected.services = {}
        expect(current()).toEqual(expected)
        for (const key of ['grants', 'connectors', 'services', 'dependencies'] as const) {
          if (key === 'grants') {
            await patch({ grants: [] })
          } else {
            await patch({ [key]: {} })
          }
        }
        expect(current().settings).toEqual(beforeUndefined.settings)
        expect(current().release).toBe(beforeUndefined.release)
        for (const invalid of [
          { unexpected: true },
          { name: '' },
          { name: 'x'.repeat(101) },
          { grants: ['bad-grant'] },
          { services: { INVALID: 'value' } },
          { enabled: null }
        ]) {
          const state = await view()
          const before = current()
          const response = await http.request('/api/plugins/' + id, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ revision: state.revision, patch: invalid })
          })
          expect(response.status).toBe(400)
          expect(current()).toEqual(before)
        }
        const invalidInternal = { name: 'valid', unexpected: true }
        const invalidRevision = (await view()).revision
        expect(() => {
          fixture.editor.manage(invalidRevision, id, invalidInternal)
        }).toThrow()
        expect(current()).toEqual(expected)
        expect(fixture.app.requests).toHaveLength(0)
        expect(fixture.env.backend.specifications.size).toBe(0)
      } finally {
        await installer.close()
        await fixture.close()
      }
    }
  )
}
