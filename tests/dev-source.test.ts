import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DevSourceConfigSchema } from '../src/dev-source/config'
import { DevPluginSource } from '../src/dev-source/service'
import { devSourceApp } from '../src/dev-source/http'
import { PluginManifestSchema } from '../../pi-im-bot/src/plugins/manifest'
import { pluginArchive } from '../../pi-im-bot/src/plugins/install/archive'
import type { PackageProducer } from '../src/dev-source/producer'

async function workspace() {
  const root = await mkdtemp('/tmp/pi-dev-source-fixture-')
  await mkdir(join(root, 'plugins/example/src'), { recursive: true })
  await mkdir(join(root, 'scripts'), { recursive: true })
  await mkdir(join(root, 'docs/bot-api'), { recursive: true })
  for (const name of ['bun.lock', 'tsconfig.json', 'scripts/build.ts', 'scripts/api-snapshot.ts']) {
    await Bun.write(join(root, name), 'owned fixture')
  }
  const manifest = JSON.stringify({
    apiVersion: 1,
    id: 'example',
    name: 'Example',
    version: '0.1.0',
    description: 'Owned fixture',
    entry: 'main.mjs',
    files: ['main.mjs']
  })
  await Bun.write(join(root, 'plugins/example/plugin.json'), manifest)
  await Bun.write(join(root, 'plugins/example/src/index.ts'), 'one')
  await Bun.write(join(root, 'docs/bot-api/snapshot.json'), JSON.stringify({ digest: 'a'.repeat(64) }))
  const config = DevSourceConfigSchema.parse({
    workspace: root,
    storage: join(root, '.dev-source'),
    publicUrl: 'http://127.0.0.1:19337',
    port: 19337,
    watch: false,
    debounceMs: 60
  })
  return { root, config, manifest }
}
function archive(sequence: number, content = 'export default {}') {
  const manifest = PluginManifestSchema.parse({
    apiVersion: 1,
    id: 'example',
    name: 'Example',
    version: '0.1.0-dev.' + sequence,
    description: 'Owned fixture',
    entry: 'main.mjs',
    files: ['main.mjs']
  })
  return {
    manifest,
    content: pluginArchive(
      new Map([
        ['plugin.json', Buffer.from(JSON.stringify(manifest))],
        ['main.mjs', Buffer.from(content)]
      ])
    )
  }
}

test('source edits coalesce into immutable releases, errors preserve the old catalog, and restart retains old URLs', async () => {
  const fixture = await workspace()
  let builds = 0
  const produce: PackageProducer = async (_directory, sequence) => {
    builds += 1
    const text = await Bun.file(join(fixture.root, 'plugins/example/src/index.ts')).text()
    if (text === 'broken') {
      throw new Error('owned compile failure')
    }
    return archive(sequence, text)
  }
  let source = new DevPluginSource(fixture.config, produce)
  try {
    await source.open()
    await source.idle()
    const initial = source.index().plugins[0]
    const app = devSourceApp(source)
    const first = await app.request(initial.url)
    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control')).toContain('immutable')
    expect(
      createHash('sha256')
        .update(new Uint8Array(await first.arrayBuffer()))
        .digest('hex')
    ).toBe(initial.sha256)
    for (const text of ['two', 'three', 'four']) {
      await Bun.write(join(fixture.root, 'plugins/example/src/index.ts'), text)
      await source.scan()
      await Bun.sleep(5)
    }
    await source.idle()
    expect(builds).toBe(2)
    const latest = source.index().plugins[0]
    expect(latest.version).toBe('0.1.0-dev.2')
    expect(latest.url).not.toBe(initial.url)
    expect((await app.request(initial.url)).status).toBe(200)
    await Bun.write(join(fixture.root, 'plugins/example/src/index.ts'), 'broken')
    await source.scan()
    await source.idle()
    expect(source.status().plugins[0].state).toBe('failed')
    expect(source.index().plugins[0]).toEqual(latest)
    await unlink(join(fixture.root, 'plugins/example/plugin.json'))
    await source.scan()
    expect(source.index().plugins[0]).toEqual(latest)
    await Bun.write(join(fixture.root, 'plugins/example/plugin.json'), fixture.manifest)
    await Bun.write(join(fixture.root, 'plugins/example/src/index.ts'), 'four')
    await source.scan()
    await source.idle()
    expect(source.status().plugins[0].state).toBe('ready')
    await source.close()
    source = new DevPluginSource(fixture.config, produce)
    await source.open()
    await source.idle()
    expect(source.index().plugins[0]).toEqual(latest)
    expect((await devSourceApp(source).request(initial.url)).status).toBe(200)
    expect((await devSourceApp(source).request('/publish/not-owned', { method: 'POST' })).status).toBe(400)
    expect((await devSourceApp(source).request('/packages/example/' + '0'.repeat(64) + '.zip')).status).toBe(
      404
    )
  } finally {
    await source.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('an edit during construction discards the mixed candidate, serializes builds, and capacity failure keeps the last good package', async () => {
  const fixture = await workspace()
  let builds = 0
  let active = 0
  let maximum = 0
  const produce: PackageProducer = async (_directory, sequence) => {
    builds += 1
    active += 1
    maximum = Math.max(maximum, active)
    try {
      if (builds === 1) {
        await Bun.write(join(fixture.root, 'plugins/example/src/index.ts'), 'changed-during-build')
      }
      await Bun.sleep(10)
      return archive(sequence)
    } finally {
      active -= 1
    }
  }
  const source = new DevPluginSource(fixture.config, produce)
  try {
    await source.open()
    await source.idle()
    expect(builds).toBe(2)
    expect(maximum).toBe(1)
    expect(source.status().releases).toBe(1)
    const latest = source.index().plugins[0]
    fixture.config.maxBytes = 1
    await source.request('example')
    await source.idle()
    expect(source.status().plugins[0].state).toBe('failed')
    expect(source.index().plugins[0]).toEqual(latest)
  } finally {
    await source.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
