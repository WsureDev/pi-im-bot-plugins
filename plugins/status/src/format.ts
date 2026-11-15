import type { RuntimeStatus } from '@pi-im-bot/plugin-sdk'

export function bytes(value: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let amount = value
  let index = 0
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }
  return amount.toFixed(1) + ' ' + units[index]
}
export function duration(seconds: number) {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return days + 'd ' + hours + 'h ' + minutes + 'm'
}
export function gpuText(status: RuntimeStatus) {
  if (!status.gpu || status.gpu.devices.length === 0) {
    return '不可用'
  }
  return status.gpu.devices
    .map((device) => {
      let utilization = 'N/A'
      if (device.utilizationPercent !== null) {
        utilization = device.utilizationPercent.toFixed(0) + '%'
      }
      return (
        '#' +
        device.index +
        ' ' +
        device.name +
        ' · 显存 ' +
        bytes(device.memoryUsedBytes) +
        ' / ' +
        bytes(device.memoryTotalBytes) +
        ' · GPU ' +
        utilization
      )
    })
    .join('\n')
}
export function statusText(status: RuntimeStatus, name: string) {
  let cpu = '暂不可用'
  if (status.cpu.usagePercent !== null) {
    cpu = status.cpu.usagePercent.toFixed(1) + '%'
  }
  const lines = [
    name + ' · 系统状态',
    '观测来源：Bot 控制面可见系统，非插件/Agent 沙箱；Docker 部署时不等同于物理主机全量指标。',
    'CPU：' + cpu + ' · ' + status.cpu.logicalCpus + ' 线程',
    'RAM：' +
      bytes(status.memory.usedBytes) +
      ' / ' +
      bytes(status.memory.totalBytes) +
      ' (' +
      status.memory.usedPercent.toFixed(1) +
      '%)',
    '负载（1/5/15 分钟）：' +
      status.cpu.loadAverage
        .map((value) => {
          return value.toFixed(2)
        })
        .join(' / ')
  ]
  lines.push('GPU：' + gpuText(status))
  if (status.swap) {
    lines.push(
      'SWAP：' +
        bytes(status.swap.totalBytes - status.swap.availableBytes) +
        ' / ' +
        bytes(status.swap.totalBytes)
    )
  }
  if (status.disk) {
    lines.push(
      'Bot 数据所在文件系统：' +
        status.disk.usedPercent.toFixed(1) +
        '% 已用，剩余 ' +
        bytes(status.disk.availableBytes)
    )
  }
  if (status.network) {
    lines.push(
      '可见接口累计计数（非月流量）：↓ ' +
        bytes(status.network.receivedBytes) +
        ' / ↑ ' +
        bytes(status.network.sentBytes)
    )
  }
  lines.push(
    'Bot：v' +
      status.bot.version +
      ' · Bun ' +
      status.bot.runtimeVersion +
      ' · 已运行 ' +
      duration(status.bot.uptimeSeconds)
  )
  lines.push(
    '插件：' +
      status.bot.pluginsEnabled +
      ' 启用 / ' +
      status.bot.pluginsInstalled +
      ' 安装 · Provider：' +
      status.bot.providersEnabled +
      ' · 启用模型：' +
      status.bot.modelsEnabled
  )
  if (status.warnings.length) {
    lines.push('部分指标不可用：' + status.warnings.join('、'))
  }
  return lines.join('\n')
}
