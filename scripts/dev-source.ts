import { DevPluginSource } from '../src/dev-source/service'
import { devSourceConfiguration } from '../src/dev-source/config'
import { workspaceProducer } from '../src/dev-source/producer'
import { devSourceApp } from '../src/dev-source/http'

const config = devSourceConfiguration()
if (process.argv.includes('--once')) {
  config.watch = false
}
const source = new DevPluginSource(config, workspaceProducer(config))
await source.open()
if (process.argv.includes('--once')) {
  await source.idle()
  console.log(JSON.stringify(source.status(), null, 2))
  await source.close()
  if (
    source.status().plugins.some((plugin) => {
      return plugin.state === 'failed'
    })
  ) {
    process.exit(1)
  }
} else {
  const server = Bun.serve({ hostname: '0.0.0.0', port: config.port, fetch: devSourceApp(source).fetch })
  console.log('监听：0.0.0.0:' + server.port)
  console.log('本地插件源：' + config.publicUrl)
  console.log('Bot 目录地址：' + source.status().indexUrl)
  let closing = false
  async function shutdown() {
    if (closing) {
      return
    }
    closing = true
    await source.close()
    await server.stop(true)
    process.exit(0)
  }
  process.on('SIGTERM', () => {
    void shutdown()
  })
  process.on('SIGINT', () => {
    void shutdown()
  })
}
