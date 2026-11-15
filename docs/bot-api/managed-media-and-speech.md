# 具名 GSVI 服务与入站媒体（foundation A）

本页是已实现契约。Pi 管 Agent 循环；Bot 管凭据、身份、授权、Job、Artifact 与发送；Worker 只实现业务。局域网工作台沿用直接访问，不新增入口密钥。

## GSVI 具名服务

GSVI 0.3 的全部原字段在插件配置页直接编辑，见 [原生配置](gsvi-native-configuration.md)。也可通过资源管理编辑独立服务。Core保存端点/Key/两组Headers，公共读取掩码，Worker只得服务引用和非秘密参数。保存停用实例不连接上游。

固定连接为 speech:gsvi@1。查询需要 tts_voices，合成需要 tts_synthesize；operation与实例均须声明service:speech，合成还需artifact.write。每次最多4动作、1合成，共享2个服务HTTP并发。没有任意URL fetch、宿主Cookie/环境或其他实例数据权限。

服务动作仍为voices/synthesize；text/voice/语言/情绪不再加GSVI专有长度上限，参考语言空串不发送。models不存在专有100项限制；成功音频返回Core artifactId、bytes、audio/wav，失败/未知返回脱敏状态。取消和撤权抛出，不当成文字回退。原生投影按源校验RIFF/WAVE至少12字节，不另加codec/HTTP MIME限制；旧未投影服务保留旧严格WAV校验。

删除独立的POST16KiB、models128KiB、infer16KiB和8MiB音频限制，接收数据使用通用Artifact单文件额度及服务总期限；旧maxAudioBytes只为读取旧资源文档保留，原生配置发布清除。请求/下载/写入和排队使用同一总预算，长timer不受32位timer调用溢出影响。源URL/audio_url没有GSVI自设2048/4096字符上限；共享Comfy服务URL契约未变。

原生投影逐跳按源重定向规则，明确301/302/303令POST转GET，307/308保留方法，未知响应不重试。每跳服务认证仅基址同源，下载Header仅首次返回URL的origin，跨源不转发旧认证。URL内Basic凭据在Core处理，不交Worker/模型/日志。显式Header大小写不敏感覆盖自动Bearer；两组Header各自JSON对象按原配置入口编辑。

通用512KiB RPC帧、maxPointBytes、100000字符结果/呈现、摘要投影、配置/secret预算和后台操作最大300000ms仍有限。超大catalog无损分页与超过通用界限的分块/长等待尚未完成，详见 [静态对应与缺口](gsvi-outgoing-parity.md)。这些不作为已经得到用户同意的1:1例外。

## 本聊天 mediaId

`readMedia(context,{mediaId,offset?,limit?,maxBytes?})` 调用 `media.read`；需要 handler/实例 `media.read` grant 和业务 `media_read`。mediaId 来自规范化附件或 `history.read` 的 `{source:'media',id}`，后者另需 history.read/chat_history。

返回 `{mediaId,name,mimeType,bytes,offset,base64,hasMore}`，不返回下载 URL、签名、宿主路径或入站媒体的 backing artifact ID。limit 0–196608（默认65536），0 用于元数据；maxBytes 1–8 MiB（默认8 MiB）。MIME 规范化去参数并验证语法，图片仍复用 MediaService 内容识别。每次 invocation 最多128次读取、累计请求切片预算8 MiB、最多16个不同来源；间接产物来源也算入16个。来源在 I/O 前同步预留，同一ID并发块只占一位。失败/取消保留额度与来源预留直至本次结束，不能借失败循环换来源。超限在下载前拒绝。

复用 MediaService：scope 校验、源消息撤回、平台来源限制、15秒下载预算、8 MiB单文件上限、最多2个并发下载。同ID读者共享下载；取消一名读者不取消其他读者，最后一名退出才取消底层请求；取消不写入永久错误。来源过期/格式/预算错误保持脱敏缓存，用户显式 retry 后才重新下载。RPC 不提供自动重试。

## 来源传播与归档读取

新入站媒体 backing artifact 和消费者产物保留 access.mediaIds。受管 media.read、artifact.read（包括间接复制）、同次调用内跨插件 operation、其后 MCP 产物和 Pi toolkit 的 artifact_read/media_read → 发布链路合并来源。读取前后、发布前后、Worker 返回及每段新交付均复核；并发读取的来源预留不超过16。业务权限与实例 grant 分别复核，后台沿用原始身份和范围。

归档查看/下载只检查聊天范围、内容存在及媒体来源撤回，不要求原生产插件继续启用，也不因服务名称/认证调整失效。在途发布/新交付另外检查当前实例、grant、绑定及业务授权。普通旧卡片/WAV 保持可查看。复制旧产物仍须传播其媒体来源，不能去掉撤回约束。

这不是任意信息流追踪：插件可长期保存已读内容、远端可记住请求、模型历史可已有文字；Bot 无法推导所有业务数据依赖。A 只跟踪上述受管当前调用链，不推断旧正式 artifact 的未知历史来源，不回写/删除旧数据。更通用持久数据流和生命周期归 B/C 后另审。

## 示例消费者与诊断

迁移工作区的 gsvi-tts 提供 /voices、/voice、/tts；media-inspect 提供 /media-inspect 和同名 Pi operation，读取≤2MiB PNG/WAV/UTF-8并导出原字节及JSON报告。gsvi-tts 在 T 增加 /usetts 与短文本概率/受管自动呈现；media-inspect 是新消费者，不是 kuang 整体迁移。

media-inspect 在公共发布前已确认的本地拒绝（超过2MiB、不支持 MIME、PNG/WAV 结构损坏、非法 UTF-8/JSON）返回明确 failed outcome。其元数据读取沿用宿主8MiB上限，再按消费者2MiB限制拒绝，避免把已知尺寸错误当成外部不确定。格式检查之外的宿主/授权/来源失败、取消和开始 artifact.publish 后的中断不被该错误处理捕获；部分产物保留且可记 outcome_unknown，不自动重发。

安装快照、实例启用、服务绑定、宿主运行环境、handler grant 和触发权限是不同状态。资源页显示已配置/停用，实例页显示未绑定/绑定服务停用，能力页显示 operation 缺少的grant；就绪只代表实例条件满足，调用时仍复核实际身份/范围。显式 /voices 可验证服务连通性，不启动模型或合成。

自动语音迁移已作为源码实现：`gsvi-tts` 的 /usetts 管理范围政策，短时 Hook 只决定是否呈现，长合成由持久 Job 执行并继续原 Outbox。见 [受管异步呈现](managed-presentation.md)。这不代表正式部署已更新。
