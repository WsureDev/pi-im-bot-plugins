import { readdir, mkdir, cp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { frameworkDirectory } from './framework'
import { z } from 'zod'

const PreviousSnapshotSchema = z.object({
  source: z.string().optional(),
  digest: z.string(),
  gitRevision: z.string().nullable().optional(),
  workingTreeDirty: z.boolean().optional()
})

const root = resolve(import.meta.dir, '..')
const framework = frameworkDirectory()
const source = join(framework, 'docs/plugins')
const target = join(root, 'docs/bot-api')
await mkdir(target, { recursive: true })
for (const file of await readdir(source)) {
  if (file.endsWith('.md')) {
    const content = await readFile(join(source, file), 'utf8')
    await writeFile(
      join(target, file),
      content.replaceAll('(../configuration.md', '(../../../pi-im-bot/docs/configuration.md')
    )
  }
}
await cp(join(framework, 'docs/framework/live-control-plane.md'), join(target, 'live-control-plane.md'))
const packageGuide = join(target, 'package-and-config.md')
await writeFile(
  packageGuide,
  (await readFile(packageGuide, 'utf8')).replace(
    '../framework/live-control-plane.md',
    'live-control-plane.md'
  )
)
const contracts = [
  'docs/framework/resource-providers.md',
  'src/resource-providers/protocol.ts',
  'src/resource-providers/registry.ts',
  'src/resource-providers/service.ts',
  'src/resource-providers/plugin-rpc.ts',
  'src/resource-providers/commands/schema.ts',
  'src/plugins/sdk/resources.ts',
  'docs/framework/live-control-plane.md',
  'src/resource-providers/contracts.ts',
  'src/resource-providers/definition.ts',
  'src/resource-providers/context.ts',
  'src/resource-providers/http.ts',
  'src/plugins/sdk/resource-http.ts',
  'src/permissions/capability-policy.ts',
  'src/permissions/identity.ts',
  'src/plugins/contracts.ts',
  'src/services/comfy/resources.ts',
  'src/services/comfy/catalog.ts',
  'src/services/comfy/errors.ts',
  'src/services/comfy/broker.ts',
  'src/services/comfy/http.ts',
  'src/services/comfy/documents.ts',
  'src/services/comfy/protocol.ts',
  'src/services/comfy/compile.ts',
  'src/services/comfy/budgets.ts',
  'src/services/comfy/outputs.ts',
  'src/services/comfy/configuration.ts',
  'src/services/resources.ts',
  'src/domain/message-format.ts',
  'src/runtime/transport.ts',
  'src/plugins/comfy-rpc.ts',
  'src/plugins/comfy-delivery.ts',
  'src/plugins/managed.ts',
  'src/plugins/state/store.ts',
  'src/plugins/state/rpc.ts',
  'src/plugins/hooks/model-history.ts',
  'src/domain/presentation.ts',
  'src/runtime/coordinator.ts',
  'src/plugins/runtime/manager.ts',
  'src/domain/rendering.ts',
  'src/jobs/presentation.ts',
  'src/jobs/service.ts',
  'src/jobs/worker.ts',
  'src/runtime/execute-run.ts',
  'src/services/gsvi/schema.ts',
  'src/services/gsvi/identity.ts',
  'src/services/gsvi/http.ts',
  'src/services/gsvi/client.ts',
  'src/services/gsvi/deadline.ts',
  'src/services/gsvi/wav.ts',
  'src/services/gsvi/configuration.ts',
  'src/services/gsvi/headers.ts',
  'src/services/gsvi/plugin-config/definition.ts',
  'src/services/gsvi/plugin-config/values.ts',
  'src/services/gsvi/plugin-config/cache.ts',
  'src/services/gsvi/plugin-config/refresh.ts',
  'src/plugins/media-rpc.ts',
  'src/plugins/service-rpc.ts',
  'src/plugins/sdk/services.ts',
  'src/plugins/artifact-access.ts',
  'src/media/dependencies.ts',
  'src/media/service.ts',
  'src/artifacts/store.ts',
  'src/artifacts/quota.ts',
  'src/storage/delivery-merge.ts',
  'src/agent/host-tools.ts',
  'src/artifacts/access.ts',
  'src/plugins/manifest.ts',
  'src/plugins/config.ts',
  'src/plugins/install/origin.ts',
  'src/plugins/market/contracts.ts',
  'src/plugins/sdk/index.ts',
  'src/plugins/sdk/worker.ts',
  'src/plugins/rpc/protocol.ts',
  'src/plugins/rpc/services.ts',
  'src/plugins/host.ts',
  'src/plugins/commands.ts',
  'src/plugins/service.ts',
  'src/plugins/connectors.ts',
  'src/plugins/operations-rpc.ts',
  'src/plugins/points.ts',
  'src/plugins/hooks/points.ts',
  'src/plugins/hooks/presentation.ts',
  'src/plugins/hooks/inline-render.ts',
  'src/plugins/observations/worker.ts',
  'src/plugins/runtime/config.ts',
  'src/plugins/runtime/contracts.ts',
  'src/plugins/runtime/editor.ts',
  'src/plugins/pipeline/contracts.ts',
  'src/plugins/configuration/contracts.ts',
  'src/plugins/configuration/editor.ts',
  'src/plugins/runtime/container-spec.ts',
  'src/plugins/configuration/schema.ts',
  'src/plugins/jobs/context.ts',
  'src/permissions/catalog.ts',
  'src/permissions/authorize.ts',
  'src/plugins/jobs/runner.ts',
  'src/runtime/trigger.ts',
  'src/runtime/status/schema.ts',
  'src/runtime/status/collect.ts',
  'src/domain/message.ts',
  'src/domain/delivery.ts',
  'src/domain/channel-media.ts',
  'src/messages/admission.ts',
  'src/jobs/schema.ts',
  'src/jobs/external/outcome.ts',
  'src/jobs/external/state.ts',
  'src/jobs/external/reconcile.ts',
  'src/jobs/index.ts',
  'src/jobs/history.ts',
  'src/jobs/commands.ts',
  'src/runtime/delivery.ts',
  'src/http/job-routes.ts'
]
await cp(join(framework, 'docs/framework/resource-providers.md'), join(target, 'resource-provider-design.md'))
const resourceGuide = join(target, 'resource-providers.md')
await writeFile(
  resourceGuide,
  (await readFile(resourceGuide, 'utf8')).replace(
    '../framework/resource-providers.md',
    'resource-provider-design.md'
  )
)
const files: Record<string, string> = {}
for (const path of contracts) {
  files[path] = createHash('sha256')
    .update(await readFile(join(framework, path)))
    .digest('hex')
}
for (const file of await readdir(source)) {
  if (file.endsWith('.md')) {
    files['docs/plugins/' + file] = createHash('sha256')
      .update(await readFile(join(source, file)))
      .digest('hex')
  }
}
const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex')
const gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: framework, encoding: 'utf8' }).trim()
const workingTreeDirty =
  execFileSync('git', ['status', '--porcelain'], { cwd: framework, encoding: 'utf8' }).trim().length > 0
const snapshotPath = join(target, 'snapshot.json')
if (await Bun.file(snapshotPath).exists()) {
  const previous = PreviousSnapshotSchema.parse(await Bun.file(snapshotPath).json())
  if (
    previous.source === 'pi-im-bot' &&
    previous.digest === digest &&
    previous.gitRevision === gitRevision &&
    previous.workingTreeDirty === workingTreeDirty
  ) {
    console.log('Bot API docs unchanged · ' + digest.slice(0, 12))
    process.exit(0)
  }
}
await writeFile(
  snapshotPath,
  JSON.stringify(
    {
      apiVersion: 1,
      generatedAt: new Date().toISOString(),
      source: 'pi-im-bot',
      gitRevision,
      workingTreeDirty,
      reason:
        'Exact contract and documentation digests identify the source; Git revision is the base when the working tree is dirty',
      digest,
      files
    },
    null,
    2
  ) + '\n'
)
console.log('Synced Bot API docs · ' + digest.slice(0, 12))
