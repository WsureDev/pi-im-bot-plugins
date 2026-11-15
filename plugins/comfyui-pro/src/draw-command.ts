import { z } from 'zod'
interface Token {
  value: string
  quoted: boolean
}
export function commandTokens(text: string): Token[] {
  const tokens: Token[] = []
  let value = ''
  let quote = ''
  let escaped = false
  let active = false
  let quoted = false
  function finish() {
    if (active) {
      tokens.push({ value, quoted })
      value = ''
      active = false
      quoted = false
    }
  }
  for (const char of text) {
    if (escaped) {
      value += char
      escaped = false
      active = true
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      active = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = ''
      } else {
        value += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      quoted = true
      active = true
      continue
    }
    if (/\s/u.test(char)) {
      finish()
    } else {
      value += char
      active = true
    }
  }
  if (quote || escaped) {
    throw new Error('画图引号或转义未闭合')
  }
  finish()
  return tokens
}
const options = new Set(['--neg', '--negative', '-n', '--count', '-c', '--workflow', '-wf', '--steps'])
export function parseDraw(text: string, direct: boolean) {
  const tokens = commandTokens(text)
  const prompt: string[] = []
  const negative: string[] = []
  const args: {
    prompt: string
    direct_send: boolean
    workflow?: string
    count?: number
    steps?: number
    negative_prompt?: string
  } = { prompt: '', direct_send: direct }
  const seen = new Set<string>()
  let neg = false
  let literal = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.quoted && !literal && token.value === '--') {
      literal = true
      continue
    }
    if (!token.quoted && !literal && options.has(token.value)) {
      if (['--neg', '--negative', '-n'].includes(token.value)) {
        if (
          !tokens[index + 1] ||
          (!tokens[index + 1].quoted && options.has(tokens[index + 1].value)) ||
          !tokens[index + 1].value.trim()
        ) {
          throw new Error('缺少负词；包含选项文本请使用引号')
        }
        neg = true
        continue
      }
      const next = tokens[++index]
      if (!next || (!next.quoted && options.has(next.value)) || !next.value.trim()) {
        throw new Error('缺少画图选项值')
      }
      let key = 'count'
      if (['--workflow', '-wf'].includes(token.value)) {
        key = 'workflow'
      }
      if (token.value === '--steps') {
        key = 'steps'
      }
      if (seen.has(key)) {
        throw new Error('重复画图选项：' + key)
      }
      seen.add(key)
      if (key === 'workflow') {
        args.workflow = next.value
      } else {
        if (!/^\d+$/u.test(next.value)) {
          throw new Error('数量/步数必须为正整数')
        }
        if (key === 'count') {
          args.count = z.number().int().min(1).max(16).parse(Number(next.value))
        } else {
          args.steps = z.number().int().min(1).max(200).parse(Number(next.value))
        }
      }
      continue
    }
    if (!token.quoted && !literal && /^--?[a-zA-Z]/u.test(token.value)) {
      throw new Error('未知画图选项；字面选项文本请加引号或使用 --')
    }
    if (neg) {
      negative.push(token.value)
    } else {
      prompt.push(token.value)
    }
  }
  args.prompt = prompt.join(' ').trim()
  if (negative.length) {
    args.negative_prompt = negative.join(' ').trim()
  }
  return args
}
