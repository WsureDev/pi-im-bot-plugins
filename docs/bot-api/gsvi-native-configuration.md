# GSVI 原生配置页

`gsvi-tts` 0.3.0 的实例配置页直接呈现部署源 v1.4.1 的全部 13 个叶字段及 `preset` 对象。无需另开服务页补连接配置。包声明 `configurationProjection:"gsvi@1"`，必须有 `speech:gsvi@1` 连接；这是固定协议投影，不提供任意 HTTP 能力。

| 原字段 | 同页保存与消费者 |
| --- | --- |
| api_base | Core 服务 url；保留反向代理路径前缀 |
| version | v1/v2/v4；查询版本、合成载荷、缓存来源 |
| api_key | secret 编辑／保留／清除；Core 自动 Bearer |
| request_headers | secret JSON 字符串；Core 大小写不敏感合并，显式 Authorization 覆盖自动值 |
| download_headers | secret JSON 字符串；只给首次下载 origin，跨源重定向重新计算认证 |
| timeout_ms | 正整数且至少 1000；查询／合成／下载共用服务总截止时间，还受调用入口剩余预算约束 |
| text_lang、emotion | Worker 非秘密业务参数，映射固定合成载荷 |
| prompt_text_lang | 可空；空串不发送该载荷键 |
| refresh_voices | 保存时消费并复位；已启用实例在保存／启用／应用初始化时有界刷新 |
| preset.voice | 缓存下拉与空缓存手填；首次渠道初始化的音色 |
| preset.max_chars | 正整数；首次渠道政策的 Unicode 码点界限 |
| preset.probability | 0–100 整数及 slider；首次渠道政策的概率 |

静态 schema 保留原字段名、层次、默认值、选项、说明与 hint。Core 配置校验落实源 settings.py 的正整数／范围约束。敏感字段在读取时只返回是否已设置；保存必须使用 secret 的 set/clear 动作，省略则保留。Worker invocation、模型配置和公开实例 settings 只含 version、语言、emotion 和 preset，不含端点、凭据、headers 或刷新开关。

新安装会建立本实例的托管 speech 服务，但实例仍停用，安装不执行入口或请求上游。编辑共享绑定会创建独立服务，不覆盖另一实例。已有服务的请求头通过该页投影保留。删除服务仍受 Core 的引用检查约束。

刷新由Core拥有的 GsviConfigurationRefresh 接在配置／启用／初始化路径中调度，保存不等待网络；同实例后继取消旧刷新，应用退出取消并等待全部刷新（含被替换的旧任务）。单次最多 min(10000,timeout_ms) 毫秒，无 import 计时器或后台悬空 Promise。实例或执行后端停用时直接跳过，不请求上游；开关仍复位。缓存位于 Core dataDir/resources/gsvi-choices，按服务地址／版本匹配。失败保留列表与当前选择；服务／版本／release／grant 变化会阻止迟到缓存写入。页面读取缓存本身不发 HTTP；没有缓存允许手填。

固定协议保留 /models/{version}、/infer_single 和返回 URL 下载，逐跳重算认证。原生投影按源处理显式 HTTP 重定向（301/302/303 的 POST 转 GET，307/308 保留方法），不重试丢失响应或未知合成。未选择原生投影的旧服务保留原保守重定向契约。原生投影按源校验RIFF/WAVE，不使用旧8MiB音频限制；共享Artifact预算继续生效。尚未复刻的通用上限详见第二稿矩阵，不将其称为用户同意的例外。

## 0.2 → 0.3 一次迁移

发布时只将实例 voice/max_chars/probability 移入 preset，已存在的 preset 值优先，不改 policy.json、voice.json、渠道启用状态或旧 KV。运行时仅消费新结构。回选旧 schema 的 release 时有对应的发布阶段反向转换，不在 Worker 维护双结构。

账号／群／conversation 与全局覆盖必须先记录、在 disabled 实例上暂存清除，再安装、按同一形状转换恢复。工作区 scripts/upgrade-gsvi.ts 提供明确的备份／上传原作业核对／恢复步骤；只用于主审批准的 GSVI disabled 更新，不启用后端，不调用音色接口。它不重启 Core；先由主审更新必要 Core/UI。回滚清除新覆盖、选原 release、还原原实例／范围覆盖，删除本次新增且无引用的服务。复用原服务时会保留等效认证，但新增 Core 表示字段可能保留，不宣称回滚字节相同。

本轮仅静态对照、纯配置检查、typecheck、GSVI 单包构建／打包及 disabled 页面验证。用户禁止的音色查询／刷新／合成／下载均未执行；动态行为有实现接线，不标注运行验收通过。

## 第二稿审核修正

原有可信 Agent 工具 chat_send 和工具内 delivery.send 已接短时呈现，不再要求改用chat_present；普通指令/插件通知仍排除。详见 [outgoing／streaming静态对应与剩余差异](gsvi-outgoing-parity.md)。GSVI自加2000字符、请求体16KiB、JSON/models响应专有额度、8MiB音频和URL长度限制已去除；通用RPC/呈现/产物/操作期限仍有限，超边界无损传输等未完成项按表列出，不能称用户已同意的1:1替代。API配置响应的 inlinePresentationContract=tool-send@1仅表示Core有此协议实现，不是动态验收或上游健康证明。
