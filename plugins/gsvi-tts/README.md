# GSVI 语音

绑定 Bot 具名 `gsvi@1` 服务别名 `speech`。上游地址/认证只由 Bot 持有，Worker 不接触 URL、宿主环境或秘密。插件默认不启用自动语音。

- `/voices` 实时音色，`/voice 音色名` 保留显式选择，`/tts 文字` 显式后台合成。
- `/usetts` 查看本聊天范围状态，`on` 首次复制预设（含已有 /voice 选择）并开启，`off` 保留参数关闭，`list` 实时列表。
- `/usetts "带空格音色" 80 50` 保存并开启。字数为正整数，概率为 0–100 整数。

同群成员共享政策，跨 `/new` 和重启保留。状态和关闭不要求上游在线，speech 是可选连接以保留离线政策指令；实际查询/合成仍须绑定已启用服务及授权。

只转换 Core 确认来自 Agent 的完整纯文本，任何 Artifact 整条跳过。trim 后按 Unicode 码点计数，超长/0% 不合成，100% 必尝试，中间概率只选一次。普通指令、插件业务通知和未知来源不转换。模型历史及 rawReply 保留原文。typed forward也由Core整条标记mixed并跳过TTS；任意出站mention/引用API尚未提供。

长合成由持久呈现 Job 继续原 Outbox，主会话无需等待。页面/工具的“已受理”还不是“已发送”。已选计划固定音色与参数，政策变更只影响新决定；`/stop`、`/new`、模式/目标切换和撤权可停止旧计划。已知合成失败回退文字；未知合成不重提，回退一次文字并保留 outcome_unknown。取消/撤权不发送迟到原文或音频。

原同步 `chat_send` 和Agent工具内的插件 `delivery.send` 按原条件参与短时语音呈现，最多10秒/剩余预算并等待真实ACK；普通指令/插件通知不转换。`chat_present` 保留为另一种显式异步入口。无需额外 LLM，不逐 token 合成，不在 import/Hook 挂后台任务。

具名服务安全契约见 `docs/bot-api/managed-media-and-speech.md`；异步呈现、actions 和无数据 Worker 见 `docs/bot-api/managed-presentation.md`。

第一轮审核回修：自动呈现至少需要2个业务Worker。1 Worker 时状态/开关回执明示容量不足，政策可保存，实际回复封存拒绝后保持原文且不调用GSVI。2 Worker 时后台stateless合成串行；更多Worker也保留一个前台活动槽，未扩大总内存/容器预算。Job全局/范围/每run容量明确拒绝同样只回退一次原文；受理结果未知则按原键核对，不能当成“未受理”重发。

0.3.0 将原 GSVI v1.4.1 的全部配置直接放回本插件配置页：api_base、version、API Key、两组 secret JSON Header、timeout_ms、语言、emotion、可空 prompt_text_lang、一次 refresh_voices，以及原嵌套 preset。凭据仍由Core托管，页面支持替换／保留／清除，不发给Worker。无需去另一个服务页猜配缺项。

配置页会显示匹配地址/版本的缓存下拉；无缓存可手填。启用实例的保存／初始化接线会有界刷新，refresh_voices消费后复位；停用实例或执行后端关闭时不会请求上游。0.2 flat配置需按 MIGRATION 一次转换，voice.json/policy.json和渠道状态保留。

本轮用户禁止音色测试，未执行查询／刷新／合成／音频下载，也未更新正式实例。字段和功能逐项落点见 MIGRATION.md；构建／安装不能单独证明动态可用。

第二稿移除GSVI自设2000字符和独立HTTP/音频限额，补原有工具发送路径；outgoing/streaming逐分支和通用平台剩余未完成项见 docs/bot-api/gsvi-outgoing-parity.md。不能将有限平台上的静态实现表述为全部1:1动态验收通过。
