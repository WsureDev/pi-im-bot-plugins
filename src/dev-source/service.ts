import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { lstat, mkdir } from 'node:fs/promises'
import { RuntimeOwner } from '../../../pi-im-bot/src/storage/owner'
import { PluginIndexSchema } from '../../../pi-im-bot/src/plugins/market/contracts'
import {
  SourceStateSchema,
  ReleasedPackageSchema,
  SourceDirectorySchema,
  type BuildStatus,
  type SourceState
} from './contracts'
import type { DevSourceConfig } from './config'
import { sourceDirectories, sourceFingerprint } from './fingerprint'
import { atomicFile, packageBytes } from './files'
import type { PackageProducer } from './producer'

interface PendingBuild {
  digest: string
  due: number
  first: number
}
export class DevPluginSource {
  private state: SourceState = { version: 1, releases: [] }
  private readonly statuses = new Map<string, BuildStatus>()
  private readonly attempted = new Map<string, string>()
  private readonly pending = new Map<string, PendingBuild>()
  private active?: Promise<void>
  private activeDirectory?: string
  private timer?: ReturnType<typeof setTimeout>
  private polling?: ReturnType<typeof setInterval>
  private scanning = false
  private closed = false
  private owner?: RuntimeOwner
  constructor(
    readonly config: DevSourceConfig,
    private readonly produce: PackageProducer
  ) {}

  async open() {
    await mkdir(this.config.storage, { recursive: true, mode: 0o700 })
    try {
      this.owner = new RuntimeOwner(this.config.storage)
    } catch (error) {
      throw new Error('本地插件源目录已有写入进程，不能同时启动 --once 或另一服务', { cause: error })
    }
    const file = Bun.file(join(this.config.storage, 'state.json'))
    if (await file.exists()) {
      this.state = SourceStateSchema.parse(await file.json())
    }
    for (const release of this.state.releases) {
      this.statuses.set(release.directory, {
        directory: release.directory,
        state: 'ready',
        updatedAt: release.publishedAt,
        release
      })
    }
    await this.scan()
    if (this.config.watch) {
      this.polling = setInterval(() => {
        void this.scan().catch((error) => {
          console.error('开发源扫描失败：' + String(error))
        })
      }, this.config.pollMs)
    }
  }
  private latest(directory: string) {
    return this.state.releases.findLast((entry) => {
      return entry.directory === directory
    })
  }
  async scan() {
    if (this.closed || this.scanning) {
      return
    }
    this.scanning = true
    try {
      const directories = await sourceDirectories(this.config.workspace)
      for (const directory of directories) {
        try {
          const digest = await sourceFingerprint(this.config.workspace, directory)
          if (digest === this.latest(directory)?.sourceDigest) {
            const status = this.statuses.get(directory)
            if (status?.state === 'failed' || status?.state === 'removed') {
              this.statuses.set(directory, {
                directory,
                state: 'ready',
                updatedAt: Date.now(),
                release: this.latest(directory)
              })
            }
            continue
          }
          if (this.attempted.get(directory) === digest || this.pending.get(directory)?.digest === digest) {
            continue
          }
          this.queue(directory, digest)
        } catch (error) {
          this.failed(directory, error)
        }
      }
      for (const [directory, status] of this.statuses) {
        if (!directories.includes(directory) && directory !== this.activeDirectory) {
          this.pending.delete(directory)
          const exists = await lstat(join(this.config.workspace, 'plugins', directory))
            .then((value) => {
              return value.isDirectory()
            })
            .catch(() => false)
          if (exists) {
            this.failed(directory, new Error('插件目录暂时缺少 plugin.json，保留上一份发布'))
          } else {
            this.statuses.set(directory, { ...status, state: 'removed', updatedAt: Date.now() })
          }
        }
      }
    } finally {
      this.scanning = false
    }
  }
  async request(directory: string) {
    SourceDirectorySchema.parse(directory)
    if (this.closed || !(await sourceDirectories(this.config.workspace)).includes(directory)) {
      throw new Error('开发插件目录不存在')
    }
    this.queue(directory, await sourceFingerprint(this.config.workspace, directory), true)
    return this.statuses.get(directory)!
  }
  private queue(directory: string, digest: string, immediate = false) {
    const now = Date.now()
    const first = this.pending.get(directory)?.first ?? now
    let due = Math.min(now + this.config.debounceMs, first + this.config.maxHoldMs)
    if (immediate) {
      due = now
    }
    this.pending.set(directory, { digest, due, first })
    this.statuses.set(directory, {
      directory,
      state: 'queued',
      updatedAt: now,
      release: this.latest(directory)
    })
    this.kick()
  }
  private kick() {
    if (this.closed || this.active || !this.pending.size) {
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
    }
    const next = [...this.pending.entries()].sort((a, b) => {
      return a[1].due - b[1].due
    })[0]
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.pending.delete(next[0])
        const operation = this.publish(next[0], next[1].digest).finally(() => {
          this.active = undefined
          this.activeDirectory = undefined
          this.kick()
        })
        this.active = operation
        this.activeDirectory = next[0]
        void operation.catch(() => {})
      },
      Math.max(0, next[1].due - Date.now())
    )
  }
  private failed(directory: string, error: unknown) {
    this.statuses.set(directory, {
      directory,
      state: 'failed',
      updatedAt: Date.now(),
      error: String(error).slice(0, 2000),
      release: this.latest(directory)
    })
  }
  private async publish(directory: string, digest: string) {
    this.attempted.set(directory, digest)
    this.statuses.set(directory, {
      directory,
      state: 'building',
      updatedAt: Date.now(),
      release: this.latest(directory)
    })
    try {
      const sequence = (this.latest(directory)?.sequence ?? 0) + 1
      const result = await this.produce(directory, sequence)
      const after = await sourceFingerprint(this.config.workspace, directory)
      if (after !== digest) {
        this.queue(directory, after)
        return
      }
      if (
        this.state.releases.some((entry) => {
          return entry.directory !== directory && entry.entry.id === result.manifest.id
        })
      ) {
        throw new Error('不同开发目录不能发布相同插件 ID')
      }
      const sha = createHash('sha256').update(result.content).digest('hex')
      const packageRoot = join(this.config.storage, 'packages')
      const path = join(packageRoot, result.manifest.id, sha + '.zip')
      if (!(await Bun.file(path).exists())) {
        if ((await packageBytes(packageRoot)) + result.content.length > this.config.maxBytes) {
          throw new Error('开发源容量已满，保留旧发布包；请整理历史后重新发布')
        }
        await atomicFile(path, result.content)
      }
      const release = ReleasedPackageSchema.parse({
        directory,
        sequence,
        sourceDigest: digest,
        publishedAt: Date.now(),
        bytes: result.content.length,
        entry: {
          id: result.manifest.id,
          name: result.manifest.name,
          description: result.manifest.description,
          version: result.manifest.version,
          author: result.manifest.author,
          categories: result.manifest.categories,
          apiVersion: 1,
          sha256: sha,
          url: this.packageUrl(result.manifest.id, sha)
        }
      })
      const next = SourceStateSchema.parse({ version: 1, releases: [...this.state.releases, release] })
      await atomicFile(join(this.config.storage, 'state.json'), JSON.stringify(next, null, 2))
      this.state = next
      this.statuses.set(directory, { directory, state: 'ready', updatedAt: Date.now(), release })
      console.log('Published ' + release.entry.id + ' ' + release.entry.version + ' ' + sha.slice(0, 12))
    } catch (error) {
      this.failed(directory, error)
    }
  }
  private packageUrl(id: string, sha: string) {
    return this.config.publicUrl.replace(/\/$/u, '') + '/packages/' + id + '/' + sha + '.zip'
  }
  index() {
    const releases = new Map(
      this.state.releases.map((release) => {
        return [release.directory, release]
      })
    )
    const plugins = [...releases.values()]
      .filter((release) => {
        return this.statuses.get(release.directory)?.state !== 'removed'
      })
      .map((release) => {
        return { ...release.entry, url: this.packageUrl(release.entry.id, release.entry.sha256) }
      })
      .sort((a, b) => {
        return a.id.localeCompare(b.id)
      })
    return PluginIndexSchema.parse({ version: 1, plugins })
  }
  status() {
    return {
      watch: this.config.watch,
      indexUrl: this.config.publicUrl.replace(/\/$/u, '') + '/index.json',
      active: this.activeDirectory,
      maxBytes: this.config.maxBytes,
      releases: this.state.releases.length,
      plugins: [...this.statuses.values()]
    }
  }
  packagePath(id: string, sha: string) {
    if (
      !this.state.releases.some((release) => {
        return release.entry.id === id && release.entry.sha256 === sha
      })
    ) {
      return undefined
    }
    return join(this.config.storage, 'packages', id, sha + '.zip')
  }
  async idle() {
    while (this.pending.size || this.active) {
      if (this.active) {
        await this.active
      } else {
        await Bun.sleep(20)
      }
    }
  }
  async close() {
    this.closed = true
    if (this.polling) {
      clearInterval(this.polling)
    }
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.pending.clear()
    await this.active
    this.owner?.close()
    this.owner = undefined
  }
}
