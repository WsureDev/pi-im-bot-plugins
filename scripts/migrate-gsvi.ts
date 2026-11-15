import { z } from 'zod'
import { PolicySchema } from '../plugins/gsvi-tts/src/policy'

// Accept an explicitly exported, non-secret projection only. Never open AstrBot state or apply it.
const ExportSchema = z
  .object({
    preset: PolicySchema.omit({ enabled: true }).optional(),
    channels: z
      .array(z.object({ targetRoomId: z.uuid(), policy: PolicySchema }).strict())
      .max(10000)
      .default([])
  })
  .strict()
const input = z.string().min(1).parse(process.argv[2])
const exported = ExportSchema.parse(await Bun.file(input).json())
const rooms = new Set(
  exported.channels.map((entry) => {
    return entry.targetRoomId
  })
)
if (rooms.size !== exported.channels.length) {
  throw new Error('目标范围重复，未生成转换')
}
console.log(
  JSON.stringify(
    {
      dryRun: true,
      applied: false,
      channelCount: rooms.size,
      enabledCount: exported.channels.filter((entry) => {
        return entry.policy.enabled
      }).length,
      preset: exported.preset,
      targetIdsPrinted: false,
      sourceKeys: 'channel:<source-resolved-channel-key>; voice_choices is a cache and is not imported',
      next: 'Review explicit room mapping and policy schema. This tool does not write Bot or AstrBot state.'
    },
    null,
    2
  )
)
