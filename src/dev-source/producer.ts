import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PluginInstanceSchema } from '../../../pi-im-bot/src/plugins/config'
import { PluginManifestSchema, type PluginManifest } from '../../../pi-im-bot/src/plugins/manifest'
import { importPlugin, pluginPackageRoot } from '../../../pi-im-bot/src/plugins/package'
import { pluginArchive, maxArchiveBytes } from '../../../pi-im-bot/src/plugins/install/archive'
import { frameworkDirectory } from '../../scripts/framework'
import type { DevSourceConfig } from './config'

export interface ProducedPackage {
  manifest: PluginManifest
  content: Uint8Array
}
export type PackageProducer = (directory: string, sequence: number) => Promise<ProducedPackage>

export function workspaceProducer(config: DevSourceConfig): PackageProducer {
  return async (directory, sequence) => {
    const child = Bun.spawn(
      [process.execPath, '--no-env-file', join(config.workspace, 'scripts/build.ts'), directory],
      {
        cwd: config.workspace,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PI_IM_BOT_SOURCE: frameworkDirectory() },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe'
      }
    )
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, config.buildTimeoutMs)
    const error = (async () => {
      const reader = child.stderr.getReader()
      let message = ''
      try {
        for (;;) {
          const value = await reader.read()
          if (value.done) {
            break
          }
          if (message.length < 8000) {
            message += new TextDecoder().decode(value.value).slice(0, 8000 - message.length)
          }
        }
      } finally {
        reader.releaseLock()
      }
      return message
    })()
    const code = await child.exited
    clearTimeout(timeout)
    const detail = await error
    if (timedOut) {
      throw new Error('构建超过时间预算')
    }
    if (code !== 0) {
      throw new Error(detail || '构建失败')
    }
    const stagingRoot = join(config.storage, 'staging')
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
    const temporary = await mkdtemp(join(stagingRoot, 'publish-'))
    try {
      const source = join(config.workspace, 'plugins', directory)
      const definition = PluginManifestSchema.parse(await Bun.file(join(source, 'plugin.json')).json())
      const instance = PluginInstanceSchema.parse({
        id: definition.id,
        name: definition.name,
        sourceDir: source
      })
      const bundle = await importPlugin(instance, config.workspace, join(temporary, 'snapshots'))
      let version = definition.version + '-dev.' + sequence
      if (definition.version.includes('-')) {
        version = definition.version + '.dev.' + sequence
      }
      const manifest = PluginManifestSchema.parse({ ...definition, version })
      const files = new Map<string, Uint8Array>()
      for (const file of bundle.files) {
        if (file.path === 'plugin.json') {
          files.set(file.path, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))
        } else {
          files.set(
            file.path,
            await readFile(join(pluginPackageRoot(join(temporary, 'snapshots'), bundle), file.path))
          )
        }
      }
      const content = pluginArchive(files)
      if (content.length > maxArchiveBytes) {
        throw new Error('开发发布 ZIP 超过 32 MiB')
      }
      return { manifest, content }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
}
