# GSVI outgoing／streaming 静态对应（第二稿）

源为部署 v1.4.1 的 origins.py、outgoing.py、reply_gate.py、streaming.py、main.py、gsvi.py。只静态读取。本文逐条标出实现、适配和未完成范围，不以旧T验收或包可安装代替源功能对照。

## 消息入口与所有权

| 源分支 | Bot 实际入口、实现与范围 |
| --- | --- |
| event_origin 识别真实模型最终链、CURRENT_ORIGIN | Coordinator 在实际 Agent 完成／Job Agent 完成的发送点构造 agent-final、scheduled-agent、background-agent；插件不能传入此标记 |
| event_origin 识别 tool_direct_result；实际 Tool executor 作用域 | 原 chat_send → executionHost.tools.send；Agent调用插件时的 Host RPC delivery.send 继承同一 Core 发送闭包。Core 构造 agent-tool/tool-direct，传递公开 tool AbortSignal 及 Core RPC deadlineAt；不依文字、nickname、runId前缀或插件自报识别 |
| event.send 与 platform.send_by_session 工具作用域转换，返回原发送结果 | 两条原入口均选择同一 GSVI automatic。Core在短 Hook结束后执行 inlinePresentation，仍在原 Delivery.send 内等待真实 sendTransport ACK；没有转换成Job受理回执或要求用chat_present |
| 工具最多10秒及剩余期限；留发送／记账余量 | 上限 min(10000ms,已知run/RPC剩余预算的75%)，包含选择、容量等待、合成、下载、写入和结果核验。未知的Pi工具期限不猜测，通过其公开AbortSignal即时取消；服务自己的timeout_ms仍取更早期限 |
| 后台工具派生上下文的截止时间 | 由真实Core Job/调用链继续继承background预算，不能用同步ACK入口提升lane。短时渲染也保留前台控制槽；maxWorkers1或无保留容量在POST前回退文字 |
| 失败、超时保留原链；外部取消不吞掉 | 本地短时预算／已知失败／未知RPC结果只回退一次原文字。再次检查根权限、插件release、grants、原服务ID/版本后才可发送；stop/new/撤权抛出取消，不晚发原文/音频 |
| Context.send_message 保留历史、adapter只改发送副本 | Pi工具参数、rawReply不改；inline Outbox保存原text与实际renderedText，deliveryMessage对inline保留原text，附件照常记录；平台收到音频副本 |
| nested()/SendScope 防二次概率和二次转换 | 单Outbox operationId排他，先持久选择计划，再标started，记录complete/fallback，原操作唯一发送。不存在renderer/parent/Job各发一次 |
| 响应丢失或重启 | 保存的inline计划不重选、不重抽、不重POST。进程中断保留未知并停止自动恢复发送；sending保持transport不确定性，已确认render事实不倒退成“未合成”。这与真实ACK要求一致，不能伪造delivered |
| 普通指令、插件通知、未知来源 | 原指令和普通插件Job完成仍为unknown/plugin/control，GSVI不参与；同一插件只有经真实Agent工具闭包发送的消息才有agent-tool来源 |
| 目的地、禁用插件/渠道、live模式 | 按Core实际Room/scope读取共享policy，当前实例/Hook/操作授权及权限天花板复核。Bot没有任意插件跨群send接口，不用来源群开关授权其他群；不假造不存在的目标入口 |

## 整条消息和流式分支

| 源 outgoing／streaming／gate 分支 | Bot 对应与准确边界 |
| --- | --- |
| RespondStage入口先快照最终链；附件被adapter摘走后也不能误认纯文本 | Core在媒体投递前检查整条请求artifactIds及typed forward标志；任何混合内容整条跳过，后续平台降级或抽取附件不会重新选择 |
| Plain链拼接、trim、Unicode码点数、等于max_chars可触发 | policy.shouldRender只对完整逻辑text执行；上限仅用户max_chars，0不触发、100确定，中间概率一次。Core／插件已删除GSVI自加2000/100000文本上限 |
| 原生分段时presentation.evaluated只抽一次；成功后不再发其余原片段 | 一次逻辑Delivery只有一个选择与一个持久计划；平台自身分段在此之后执行，保留partial/sending/unknown账本，不给每段重新抽概率 |
| FinalReplyGate等待skills_like重询、合并回复、最终hooks结束 | Pi拥有工具循环和模型会话；execute-run仅把其完整最终结果提交Delivery，GSVI处理最终发送副本。不重跑模型/工具，不引入第二LLM循环 |
| streaming.convert_stream将连续无类型Plain帧积成一个逻辑消息，再转换 | Bot现有平台发送单位本来就是完整逻辑回复。Pi的token/delta只进入工作台进度，不逐token交给渠道或GSVI。此处是逻辑单位适配，不声称实现AstrBot原始generator API |
| 流中mixed组逐原帧回退，不提取其中某段纯文本 | Bot一个逻辑出站含任一附件/forward就整条跳过TTS，保留原正文和附件；相邻的独立工具通知具有自己的Outbox，不被另一个mixed结果污染 |
| tool_call/tool_call_result/agent_stats/reasoning/break控制帧跳过 | Pi控制/统计/推理事件作为UI事件/trace，未进入平台Delivery；普通工具结果仍给Pi，只有明确chat_send/delivery.send通知进入上述可信工具通路 |
| typed tool_direct_result与前后文本分开；迭代generator不借出递归守卫/来源 | Core以独立Tool callId/Outbox发送明确通知，最终回复另一个Outbox；Core闭包只给真正的工具执行上下文，UI delta不继承发送权限 |
| break分隔多条呈现消息，非webchat按顺序send；webchat保留completion帧 | Bot没有接收AstrBot任意stream/break/completion帧的公开入口。现有每次Delivery是有序完整消息，Mock/Web持久消息和附件在ACK后推送。**原始流帧协议兼容、多break generator逐帧消费入口未实现**，不能将它写成1:1流API已完成；也未虚造一个无消费者入口 |
| 路径清理与晚到音频 | Core Artifact持久受管，不使用Python临时WAV路径；合成/权限/信号检查和原Outbox唯一所有者阻止晚发。已保存Artifact是事实/受管数据，不由Worker直接访问宿主临时文件 |

## 限制逐项审计

| 项 | 源 | 当前与分类 |
| --- | --- | --- |
| preset.max_chars / text | 仅正整数；整条码点比较 | 3000合法。GsviInput、RenderInput、SpeakSchema及显式命令JSON schema不再有2000/100000专有text限制；静态检查不构造合成请求 |
| POST请求体 | 无插件固定字节限额 | 删除16KiB限额，固定infer_single各键与空prompt_text_lang省略不变。Worker输入仍受通用512KiB RPC帧及上下文预算限制 |
| JSON响应 | 源在总期限内读取完整响应 | 删除GSVI 128KiB models/16KiB infer限制；共享Artifact单文件额度作为受管接收内存边界，UTF-8严格解码，不输出响应体或凭据 |
| models键与情绪列表 | dict/list无专有数量限额 | 删除100情绪上限及非空模型键限制；Core缓存不再有256KiB专有文件限额。但**大catalog完整经过Worker RPC和通用插件结果投影的无损分页未实现**；512KiB帧、100000字符通用结果及12000摘要规则仍存在，不能宣称任意大源列表1:1 |
| 音频字节 | 总期限内读完，RIFF/WAVE至少12字节 | 删除独立8MiB音频限额；共享Artifact额度及平台媒体额度仍生效，超限失败回退。旧maxAudioBytes仅可读旧资源文件，原生配置发布清除该字段，传输不使用它 |
| WAV/MIME | 只检RIFF/WAVE签名，不限制codec/MIME | 原生投影照源签名，不再额外要求44字节、PCM/采样率/声道或HTTP MIME白名单；未迁移的旧服务仍保留旧严格WAV校验 |
| URL | HttpUrl / 非空audio_url，HTTP(S) | GSVI独立URL schema不再有2048/4096字符限额；返回URL/逐跳认证/路径前缀及Basic URL凭据在Core处理。共享Comfy ServiceUrlSchema未改 |
| timeout_ms | ≥1000，工具/自动刷新再压至10s | 服务不加240000/schema上限，长timer分段避免32位timer溢出；短工具≤10s。**后台操作通用最大300000ms仍限制更长合法服务预算**，当前未完全复刻无限长等待；不是用户已同意的差异 |
| 通用平台额度 | AstrBot部署与适配器自己的资源约束 | Bot还存在通用100000字符呈现类型、maxPointBytes、512KiB帧、配置/secret额度、Artifact与Worker/Job预算；没有将其改名成GSVI用户上限。越过这些边界的无损分块/流式传输未完成 |

本次实现两处审核缺项并明确剩余通用平台差异，不宣称全部运行场景1:1完成。禁止的动态音色查询、刷新、合成、下载以及上述工具呈现通路，真实或fake均未执行。只能以源/类型/配置/停用页证据评估本稿。
