import {pythonDecimal,pythonStrip} from '@pi-im-bot/plugin-sdk'
/** POSIX shlex.split(..., comments=False), using the source's ASCII internal whitespace. */
export function shellWords(input: string) {
  const words: string[] = []
  let word = ''
  let quote = ''
  let started = false
  let escaped = false
  for (const char of pythonStrip(input)) {
    if (escaped) {
      if (quote === '"' && char !== '"' && char !== '\\') {word+='\\'}
      word+=char
      started=true
      escaped=false
    } else if (char==='\\' && quote!=="'") {
      escaped=true
    } else if (quote) {
      if(char===quote){quote=''}else{word+=char}
    } else if (char==='"' || char==="'") {
      quote=char
      started=true
    } else if (' \t\r\n'.includes(char)) {
      if(started){words.push(word);word='';started=false}
    } else {word+=char;started=true}
  }
  if(quote || escaped){throw new Error('Unclosed quote or escape')}
  if(started){words.push(word)}
  return words
}
export {pythonDecimal}
