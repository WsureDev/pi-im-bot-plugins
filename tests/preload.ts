import { join } from 'node:path'

const child = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, '../scripts/build.ts')], {
  stdout: 'ignore',
  stderr: 'pipe',
  stdin: 'ignore'
})
if ((await child.exited) !== 0) {
  throw new Error(await new Response(child.stderr).text())
}
