/** Reviewed metadata-only upgrade. Never invokes voices, refresh, synthesis, audio or a Worker. */
import { parseArgs, isDeepStrictEqual } from 'node:util'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { z } from 'zod'
import { migrateGsviFlat } from '../../pi-im-bot/src/services/gsvi/plugin-config/definition'
import { PluginEditorViewSchema } from '../../pi-im-bot/src/plugins/contracts'
import {
  PluginConfigViewSchema,
  PluginConfigTargetSchema
} from '../../pi-im-bot/src/plugins/configuration/contracts'
import { FrameworkConfigSchema } from '../../pi-im-bot/src/settings/schema'
import { ResourcesViewSchema } from '../../pi-im-bot/src/resources/contracts'
const args = parseArgs({
  options: {
    zip: { type: 'string' },
    sha: { type: 'string' },
    backup: { type: 'string' },
    apply: { type: 'boolean' },
    rollback: { type: 'boolean' }
  },
  strict: true
}).values
const backupRoot = join(tmpdir(), 'pi-gsvi-upgrade')
const backup = z
  .string()
  .min(1)
  .transform((value) => {
    return resolve(value)
  })
  .refine((value) => {
    const path = relative(backupRoot, value)
    return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)
  }, 'Backup must be a child directory of ' + backupRoot)
  .parse(args.backup)
const base = 'http://127.0.0.1:19335'
const id = 'gsvi-tts'
const FrameworkViewSchema = z.object({ version: z.string(), config: FrameworkConfigSchema }).passthrough()
const JobSchema = z.object({ id: z.string(), stage: z.string(), pluginId: z.string().optional() })
async function api<T>(path: string, schema: z.ZodType<T>, body?: object, method = 'GET') {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) {
    throw new Error('Metadata API failed ' + response.status + ' ' + path)
  }
  return schema.parse(await response.json())
}
function query(target: z.infer<typeof PluginConfigTargetSchema>) {
  return '/api/plugins/' + id + '/configuration?' + new URLSearchParams(target).toString()
}
async function configuration(target: z.infer<typeof PluginConfigTargetSchema>) {
  return api(query(target), PluginConfigViewSchema)
}
async function values(
  target: z.infer<typeof PluginConfigTargetSchema>,
  value: Record<string, z.infer<ReturnType<typeof z.json>>>
) {
  const now = await configuration(target)
  await api(
    '/api/plugins/' + id + '/configuration',
    PluginConfigViewSchema,
    { revision: now.revision, release: now.release, target, values: value, secrets: [] },
    'PUT'
  )
}
async function disabled() {
  const view = await api('/api/plugins', PluginEditorViewSchema)
  const instance = view.plugins.find((entry) => entry.id === id)
  if (!instance || instance.enabled) {
    throw new Error(
      'GSVI instance must already be disabled; this script never enables/disables backend or runs business'
    )
  }
  const status = z
    .object({
      runs: z.array(z.object({ status: z.string() })),
      jobs: z.array(z.object({ state: z.string(), delivery: z.string() })).default([])
    })
    .parse(await (await fetch(base + '/api/state')).json())
  if (
    status.runs.some((run) => ['batching', 'queued', 'running', 'interrupted'].includes(run.status)) ||
    status.jobs.some(
      (job) =>
        !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(job.state) ||
        ['pending', 'accepted'].includes(job.delivery)
    )
  ) {
    throw new Error('Active work: stop and review before upgrade')
  }
  return { view, instance }
}
await mkdir(backup, { recursive: true, mode: 0o700 })
const metadata = await disabled()
const instanceTarget = { level: 'instance' as const }
const initial = await configuration(instanceTarget)
if (
  !initial.gsviConfiguration?.projectionSupported ||
  initial.gsviConfiguration.inlinePresentationContract !== 'tool-send@1'
) {
  throw new Error('Reviewed Core native configuration and tool-send@1 contract must be deployed first')
}
const save = async (name: string, value: unknown) => {
  await writeFile(backup + '/' + name, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}
const phase = async (value: object) => {
  await writeFile(backup + '/phase.json', JSON.stringify(value) + '\n', { mode: 0o600 })
}
const InstanceBackupSchema = z.object({
  view: PluginEditorViewSchema,
  config: PluginConfigViewSchema,
  framework: FrameworkViewSchema,
  scopes: z.array(PluginConfigViewSchema)
})
async function clearCurrentScopes() {
  const current = await configuration(instanceTarget)
  for (const entry of current.targets) {
    if (entry.target.level !== 'instance') {
      await values(entry.target, {})
    }
  }
  const framework = await api('/api/framework', FrameworkViewSchema)
  if (framework.config.defaults.extensions.settings[id]) {
    delete framework.config.defaults.extensions.settings[id]
    await api(
      '/api/framework',
      FrameworkViewSchema,
      { version: framework.version, config: framework.config },
      'PUT'
    )
  }
}
if (args.rollback) {
  const old = InstanceBackupSchema.parse(JSON.parse(await readFile(backup + '/before.json', 'utf8')))
  await clearCurrentScopes()
  const previous = old.view.plugins.find((entry) => entry.id === id)!
  const createdService = metadata.instance.services.speech
  const now = await api('/api/plugins', PluginEditorViewSchema)
  await api(
    '/api/plugins/' + id + '/releases/select',
    PluginEditorViewSchema,
    { revision: now.revision, release: previous.release },
    'POST'
  )
  const view = await api('/api/plugins', PluginEditorViewSchema)
  const { bundle: _bundle, state: _state, issues: _issues, ...raw } = previous
  await api(
    '/api/plugins/' + id,
    PluginEditorViewSchema,
    { revision: view.revision, plugin: { ...raw, enabled: false, settings: old.config.values } },
    'PUT'
  )
  for (const scope of old.scopes) {
    await values(scope.target, scope.values)
  }
  if (createdService && createdService !== previous.services.speech) {
    const resources = await api('/api/resources', ResourcesViewSchema)
    await api(
      '/api/resources/services/' + createdService,
      ResourcesViewSchema,
      { revision: resources.revision },
      'DELETE'
    )
  }
  const framework = await api('/api/framework', FrameworkViewSchema)
  const oldGlobal = old.framework.config.defaults.extensions.settings[id]
  if (oldGlobal) {
    framework.config.defaults.extensions.settings[id] = oldGlobal
    await api(
      '/api/framework',
      FrameworkViewSchema,
      { version: framework.version, config: framework.config },
      'PUT'
    )
  }
  await phase({ rolledBack: true, disabled: true, voiceAndPolicyFilesTouched: false })
  console.log('GSVI release and settings restored; no voice/refresh/audio operation executed')
  process.exit(0)
}
const zip = z.string().min(1).parse(args.zip)
if (initial.gsviConfiguration.projectionActive) {
  throw new Error('GSVI native configuration already installed; do not replay shape migration')
}
const sha = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .parse(args.sha)
const bytes = await Bun.file(zip).bytes()
if (createHash('sha256').update(bytes).digest('hex') !== sha) {
  throw new Error('ZIP SHA mismatch')
}
const scopes = []
for (const entry of initial.targets) {
  if (entry.target.level !== 'instance') {
    scopes.push(await configuration(entry.target))
  }
}
const framework = await api('/api/framework', FrameworkViewSchema)
const snapshot = { view: metadata.view, config: initial, framework, scopes }
if (await Bun.file(backup + '/before.json').exists()) {
  const saved = InstanceBackupSchema.parse(await Bun.file(backup + '/before.json').json())
  if (!isDeepStrictEqual(snapshot, saved)) {
    throw new Error('Prepared configuration changed; stop for a new review and backup')
  }
  if (await Bun.file(backup + '/upload-intent.json').exists()) {
    throw new Error('Existing upload intent: inspect the original receipt only; never repeat upload')
  }
  const plan = z.object({ zipSha256: z.literal(sha) }).parse(await Bun.file(backup + '/phase.json').json())
  void plan
} else {
  await save('before.json', snapshot)
}
await phase({
  prepared: true,
  applied: false,
  zipSha256: sha,
  scopeCount: scopes.length,
  voiceAndPolicyFilesTouched: false
})
if (!args.apply) {
  console.log('GSVI-only private migration backup prepared; --apply requires primary review')
  process.exit(0)
}
await clearCurrentScopes()
await phase({ scopeOverridesTemporarilyCleared: true, instanceDisabled: true })
const beforeJobs = await api('/api/plugins/installations', z.array(JobSchema))
await save('upload-intent.json', { beforeIds: beforeJobs.map((job) => job.id), sha, attempted: true })
const current = await api('/api/plugins', PluginEditorViewSchema)
const form = new FormData()
form.set('revision', current.revision)
form.set('targetId', id)
form.set('archive', new File([bytes], 'gsvi-tts.zip'))
let receipt: z.infer<typeof JobSchema> | undefined
try {
  const response = await fetch(base + '/api/plugins/install/upload', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(15000)
  })
  if (response.status === 202) {
    receipt = JobSchema.parse(await response.json())
    await save('upload-receipt.json', receipt)
  }
} catch {}
if (!receipt) {
  const jobs = await api('/api/plugins/installations', z.array(JobSchema))
  const created = jobs.filter((job) => !beforeJobs.some((before) => before.id === job.id))
  if (created.length !== 1) {
    throw new Error('Upload result unknown: retain original intent, inspect original job; never repeat POST')
  }
  receipt = created[0]
  await save('upload-receipt.json', receipt)
}
for (let count = 0; count < 300; count += 1) {
  const jobs = await api('/api/plugins/installations', z.array(JobSchema))
  const job = jobs.find((entry) => entry.id === receipt!.id)
  if (!job) {
    throw new Error('Original receipt unavailable')
  }
  if (job.stage === 'succeeded') {
    if (job.pluginId !== id) {
      throw new Error('Original receipt belongs to another plugin; stop without repeating upload')
    }
    break
  }
  if (['failed', 'cancelled', 'interrupted'].includes(job.stage)) {
    throw new Error('Original install failed; use reviewed rollback, never retry blindly')
  }
  if (count === 299) {
    throw new Error('Original install pending; query saved ID only')
  }
  await Bun.sleep(100)
}
const exported = await fetch(base + '/api/plugins/' + id + '/archive', { signal: AbortSignal.timeout(15000) })
if (
  !exported.ok ||
  createHash('sha256')
    .update(new Uint8Array(await exported.arrayBuffer()))
    .digest('hex') !== sha
) {
  throw new Error('Installed immutable package differs from reviewed ZIP; stop and use saved rollback')
}
for (const scope of scopes) {
  await values(scope.target, migrateGsviFlat(scope.values))
}
const oldGlobal = framework.config.defaults.extensions.settings[id]
if (oldGlobal) {
  const next = await api('/api/framework', FrameworkViewSchema)
  next.config.defaults.extensions.settings[id] = migrateGsviFlat(oldGlobal)
  await api('/api/framework', FrameworkViewSchema, { version: next.version, config: next.config }, 'PUT')
}
const after = await disabled()
if (after.instance.bundle?.manifest.version !== '0.3.0') {
  throw new Error('Installed manifest does not match reviewed GSVI 0.3.0')
}
const oldComfy = metadata.view.plugins.find((entry) => entry.id === 'comfyui-pro')
if (
  !isDeepStrictEqual(
    oldComfy,
    after.view.plugins.find((entry) => entry.id === 'comfyui-pro')
  )
) {
  throw new Error('Comfy metadata changed; stop for review')
}
if (!isDeepStrictEqual(after.instance.settings, migrateGsviFlat(initial.values))) {
  throw new Error('GSVI migrated instance values differ from preserved flat values')
}
await phase({
  completed: true,
  disabled: true,
  voiceAndPolicyFilesTouched: false,
  voiceOrSpeechRequests: 0,
  comfyUnchanged: true
})
console.log(
  'Only disabled GSVI release and config shape updated; other plugin metadata preserved; no voice/refresh/audio operation executed'
)
