import { expect, test } from 'bun:test'
import { DevSourceConfigSchema } from '../src/dev-source/config'

function configuration(env: Record<string, string>) {
  const module = new URL('../src/dev-source/config.ts', import.meta.url).pathname
  const result = Bun.spawnSync(
    [
      process.execPath,
      '--no-env-file',
      '--eval',
      'import { devSourceConfiguration } from ' +
        JSON.stringify(module) +
        '\nconsole.log(JSON.stringify(devSourceConfiguration()))'
    ],
    { env, stdout: 'pipe', stderr: 'pipe' }
  )
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString())
  }
  return DevSourceConfigSchema.parse(JSON.parse(result.stdout.toString()))
}

test('source startup derives a harmless local URL from its port and honors one explicit public base', () => {
  const local = configuration({ PLUGIN_SOURCE_PORT: '19437' })
  expect(local.port).toBe(19437)
  expect(local.publicUrl).toBe('http://localhost:19437')
  const remote = configuration({
    PLUGIN_SOURCE_PORT: '19437',
    PLUGIN_SOURCE_PUBLIC_URL: 'https://plugins.example/development'
  })
  expect(remote.publicUrl).toBe('https://plugins.example/development')
})
