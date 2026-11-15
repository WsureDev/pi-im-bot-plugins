import {gsviCatalogue,gsviCataloguePage,gsviCatalogueMatch,textResult,type PluginContext} from '@pi-im-bot/plugin-sdk'
import {TtsSettingsSchema} from './settings'
export async function currentCatalogue(context:PluginContext){
 const settings=TtsSettingsSchema.parse(context.invocation.settings)
 return gsviCatalogue(context,'speech',settings.version)
}
export async function requireChoice(context:PluginContext,voice:string){
 const settings=TtsSettingsSchema.parse(context.invocation.settings)
 const catalogue=await currentCatalogue(context)
 const result=await gsviCatalogueMatch(context,'speech',catalogue.reference,voice,settings.emotion)
 context.signal.throwIfAborted()
 if(!result.exists || !result.emotion){throw new Error('音色不存在或不支持当前情绪，请先 /usetts list')}
}
export async function listChoices(context:PluginContext){
 const catalogue=await currentCatalogue(context)
 const page=await gsviCataloguePage(context,'speech',catalogue.listReference)
 context.signal.throwIfAborted()
 const names=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(page.base64,'base64'),{stream:page.hasMore})
 if(!page.hasMore && names.length<=8000){
  if(!catalogue.count){return textResult('当前 GSVI 服务没有可用音色。')}
  return textResult('可用音色（'+catalogue.count+' 个，'+catalogue.version+'）：\n'+names+'\n\n使用：/usetts 音色名 字数 概率')
 }
 return textResult('可用音色共 '+catalogue.count+' 个（'+catalogue.version+'）。完整有序列表见文本附件；全部语言/情绪数据见JSON附件，未截断。\n使用：/usetts 音色名 字数 概率',[catalogue.listReference,catalogue.reference])
}
