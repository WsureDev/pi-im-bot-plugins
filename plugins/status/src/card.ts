import type { RuntimeStatus } from '@pi-im-bot/plugin-sdk'
import type { StatusSettings } from './settings'
import { bytes, duration, gpuText } from './format'

function xml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
function metric(
  x: number,
  y: number,
  label: string,
  value: string,
  ratio: number | null,
  accent: string,
  warning: number
) {
  let width = 0
  let color = accent
  if (ratio !== null) {
    width = Math.max(0, Math.min(100, ratio)) * 2.35
    if (ratio >= warning) {
      color = '#e8a87c'
    }
  }
  return `<g transform="translate(${x} ${y})"><rect width="271" height="128" rx="15" fill="#203334"/><text x="19" y="32" fill="#a8bcbb" font-size="13" letter-spacing="2">${xml(label)}</text><text x="19" y="69" fill="#f2f8f5" font-size="22">${xml(value)}</text><rect x="18" y="99" width="235" height="5" rx="2.5" fill="#344849"/><rect x="18" y="99" width="${width.toFixed(2)}" height="5" rx="2.5" fill="${color}"/></g>`
}
export function statusCard(status: RuntimeStatus, settings: StatusSettings) {
  const accents = { teal: '#7dc9ad', blue: '#8abbe5', rose: '#e6a5b2' }
  const accent = accents[settings.theme]
  let cpu = 'N/A'
  if (status.cpu.usagePercent !== null) {
    cpu = status.cpu.usagePercent.toFixed(1) + '%'
  }
  let disk = 'N/A'
  let diskRatio: number | null = null
  if (status.disk) {
    disk = status.disk.usedPercent.toFixed(1) + '%'
    diskRatio = status.disk.usedPercent
  }
  let swapping = 'N/A'
  if (status.swap) {
    swapping =
      bytes(status.swap.totalBytes - status.swap.availableBytes) + ' / ' + bytes(status.swap.totalBytes)
  }
  let incoming = 'N/A'
  let outgoing = 'N/A'
  if (status.network) {
    incoming = bytes(status.network.receivedBytes)
    outgoing = bytes(status.network.sentBytes)
  }
  const gpu = status.gpu ? gpuText(status).replaceAll('\n', ' | ').slice(0, 92) : 'N/A'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="650" viewBox="0 0 960 650"><rect width="960" height="650" rx="24" fill="#142627"/><g font-family="DejaVu Sans, sans-serif"><text x="44" y="53" fill="${accent}" font-size="12" letter-spacing="4">PI IM BOT / RUNTIME</text><text x="42" y="104" fill="#eef7f2" font-size="34" font-weight="bold">SYSTEM STATUS</text><text x="44" y="137" fill="#9fb6b1" font-size="13">${xml(status.system.platform + ' / ' + status.system.architecture + ' / ' + status.cpu.logicalCpus + ' visible CPU threads')}</text><text x="44" y="166" fill="#9fb6b1" font-size="12">${xml(status.cpu.model.slice(0, 110))}</text>${metric(44, 194, 'CPU', cpu, status.cpu.usagePercent, accent, settings.warn_percent)}${metric(344, 194, 'RAM', status.memory.usedPercent.toFixed(1) + '%', status.memory.usedPercent, accent, settings.warn_percent)}${metric(644, 194, 'DATA FILESYSTEM', disk, diskRatio, accent, settings.warn_percent)}<g fill="#9fb6b1" font-size="12"><text x="46" y="361">MEMORY / SWAP</text><text x="346" y="361">VISIBLE NETWORK COUNTERS</text><text x="646" y="361">BOT PROCESS</text></g><g fill="#f0f6f3" font-size="16"><text x="46" y="395">${xml(bytes(status.memory.usedBytes) + ' / ' + bytes(status.memory.totalBytes))}</text><text x="46" y="425">Swap: ${xml(swapping)}</text><text x="46" y="451" fill="#acc1ba" font-size="12">GPU: ${xml(gpu)}</text><text x="346" y="395">Download: ${xml(incoming)}</text><text x="346" y="425">Upload: ${xml(outgoing)}</text><text x="646" y="395">Uptime: ${xml(duration(status.bot.uptimeSeconds))}</text><text x="646" y="425">RSS: ${xml(bytes(status.bot.rssBytes))}</text></g><line x1="44" x2="916" y1="475" y2="475" stroke="#344849"/><text x="44" y="510" fill="${accent}" font-size="15">${status.bot.pluginsEnabled} plugins enabled / ${status.bot.pluginsInstalled} installed</text><text x="44" y="541" fill="#acc1ba" font-size="13">${status.bot.providersEnabled} providers / ${status.bot.modelsEnabled} enabled models / Bun ${xml(status.bot.runtimeVersion)}</text><text x="44" y="582" fill="#809b94" font-size="11">Observed by Bot control plane. OS-visible metrics; not Worker or Agent sandbox.</text><text x="44" y="608" fill="#809b94" font-size="11">${xml(new Date(status.measuredAt).toISOString())} / No extra model request</text></g></svg>`
}
