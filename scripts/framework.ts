import { resolve } from 'node:path'
import { z } from 'zod'

export function frameworkDirectory() {
  const configured = z.string().min(1).optional().parse(process.env.PI_IM_BOT_SOURCE)
  if (configured) {
    return resolve(configured)
  }
  return resolve(import.meta.dir, '../../pi-im-bot')
}
