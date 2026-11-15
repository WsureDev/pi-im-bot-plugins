import { createHash } from 'node:crypto'

export class MediaValidationError extends Error {}

/** Bounded structural inspection only; no image/audio decoding or model inference. */
export function inspectMedia(bytes: Buffer, mimeType: string) {
  const common = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mimeType }
  if (mimeType === 'image/png') {
    if (
      bytes.length < 45 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(8) !== 13
    ) {
      throw new MediaValidationError('PNG 头部无效')
    }
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    if (!width || !height || width > 16384 || height > 16384) {
      throw new MediaValidationError('PNG 尺寸超过诊断预算')
    }
    let offset = 8
    let ended = false
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset)
      if (offset + size + 12 > bytes.length) {
        throw new MediaValidationError('PNG 内容截断')
      }
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'IEND') {
        ended = size === 0
      }
      offset += size + 12
      if (ended) {
        break
      }
    }
    if (!ended || offset !== bytes.length) {
      throw new MediaValidationError('PNG 缺少结束块')
    }
    return {
      ...common,
      format: 'png',
      extension: 'png',
      width,
      height,
      validation: '结构头与块边界；未解码像素或校验 CRC'
    }
  }
  if (['audio/wav', 'audio/x-wav', 'audio/wave'].includes(mimeType)) {
    if (
      bytes.length < 44 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WAVE' ||
      bytes.readUInt32LE(4) + 8 !== bytes.length
    ) {
      throw new MediaValidationError('WAV 头部无效或内容截断')
    }
    return { ...common, format: 'wav', extension: 'wav', validation: 'RIFF 容器头与长度；未解码音频' }
  }
  if (['text/plain', 'application/json'].includes(mimeType)) {
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (mimeType === 'application/json') {
        JSON.parse(text)
      }
    } catch {
      throw new MediaValidationError('文本不是有效 UTF-8 或 JSON 语法损坏')
    }
    if (text.includes('\0')) {
      throw new MediaValidationError('文本包含二进制空字节')
    }
    return {
      ...common,
      format: 'utf8',
      extension: 'txt',
      characters: [...text].length,
      validation: '完整 UTF-8；JSON 输入额外解析语法'
    }
  }
  throw new MediaValidationError('media-inspect 只支持 PNG、WAV、UTF-8 text/plain 或 application/json')
}
