import { Hono } from 'hono'
import { html } from 'hono/html'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { bodyLimit } from 'hono/body-limit'
import { lstat } from 'node:fs/promises'
import type { DevPluginSource } from './service'
import { SourceDirectorySchema } from './contracts'

export function devSourceApp(source: DevPluginSource) {
  const app = new Hono()
  app.use('*', bodyLimit({ maxSize: 4096 }))
  app.onError((error, c) => {
    return c.json({ error: error.message }, 400)
  })
  app.get('/health', (c) => {
    return c.json({ ok: true, service: 'local-plugin-source' })
  })
  app.get('/index.json', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(source.index())
  })
  app.get('/status', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(source.status())
  })
  app.get(
    '/packages/:id/:file',
    sValidator(
      'param',
      z.object({
        id: SourceDirectorySchema,
        file: z
          .string()
          .regex(/^[a-f0-9]{64}\.zip$/u)
          .transform((value) => {
            return value.slice(0, -4)
          })
      })
    ),
    async (c) => {
      const input = c.req.valid('param')
      const path = source.packagePath(input.id, input.file)
      if (!path) {
        return c.notFound()
      }
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error('发布包文件无效')
      }
      c.header('Cache-Control', 'public, max-age=31536000, immutable')
      c.header('Content-Type', 'application/zip')
      c.header('ETag', '"' + input.file + '"')
      return c.body(Bun.file(path))
    }
  )
  app.post(
    '/publish/:directory',
    sValidator('param', z.object({ directory: SourceDirectorySchema })),
    async (c) => {
      return c.json(await source.request(c.req.valid('param').directory), 202)
    }
  )
  app.get('/', (c) => {
    const status = source.status()
    let watchLabel = '关闭'
    if (status.watch) {
      watchLabel = '启用'
    }
    return c.html(
      html`<!doctype html>
        <html lang="zh-CN">
          <meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>
            本地插件源</title
          ><style>
            body {
              font: 15px system-ui;
              max-width: 960px;
              margin: 48px auto;
              padding: 0 24px;
              color: #25493d;
              background: #f7faf8;
            }
            a {
              color: #267663;
            }
            section {
              background: white;
              border: 1px solid #dfe8e1;
              border-radius: 12px;
              padding: 24px;
              margin: 20px 0;
            }
            pre {
              white-space: pre-wrap;
              overflow-wrap: anywhere;
              color: #9b5c48;
            }
            code {
              overflow-wrap: anywhere;
            }
            li {
              margin: 12px 0;
            }
          </style>
          <h1>本地插件开发源</h1>
          <p>源码自动构建，发布固定摘要 ZIP。Bot 中手动刷新目录、安装或更新。</p>
          <p>
            目录地址：<a href="/index.json"><code>${status.indexUrl}</code></a> ·
            <a href="/status">构建状态 JSON</a>
          </p>
          <p>监听：${watchLabel} · 保留发布 ${status.releases} 次</p>
          ${status.plugins.map((plugin) => {
            return html`<section>
              <h2>${plugin.directory}</h2>
              <p>${plugin.state}</p>
              <p>${plugin.release?.entry.version ?? '尚无可用发布包'}</p>
              <code>${plugin.release?.entry.sha256 ?? ''}</code>
              <pre>${plugin.error ?? ''}</pre>
            </section>`
          })}
          <p>
            当前源码变化不会自动安装到 Bot；构建失败时上一份可用包仍能下载。源包仅包含声明的代码、资源和文档。
          </p>
        </html>`
    )
  })
  return app
}
