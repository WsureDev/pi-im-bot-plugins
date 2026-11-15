# GSVI v1.4.1 → Pi 0.3.0

> Historical validation note: ${VALIDATION_DIR} is a placeholder, not a published location. Local logs, patches and orchestration inputs are not included in this Git repository.

本轮补齐此前 0.2 缺失的六个叶字段 api_base/api_key/request_headers/download_headers/timeout_ms/refresh_voices，并恢复 preset 对象。全部字段直接位于「插件 → GSVI → 配置 → 实例默认配置」，不是以另一个服务页替代。0.3 源码待本轮独立审核，正式19335仍为 disabled 的0.2；19336不作交付证据。动态音色／合成验证被用户明确禁止，本轮没有执行。

来源：部署 `gsvi-deployed-1.4.1` v1.4.1，作者 wsure，https://github.com/WsureDev/astrbot_plugin_gsvi_short_tts。只静态读取 Python，未运行；未发现源 LICENSE，不推断其实现可再分发。本包为独立 TypeScript/MIT 实现。逐文件 SHA 与来源说明见 Bot `docs/framework/gsvi-complete-2026-11-14.md` 及本轮收据。

| 原 schema 字段     | 用户同页入口／实际代码消费者                                                             |
| ------------------ | ---------------------------------------------------------------------------------------- |
| api_base           | GSVI 服务地址；Core plugin-config/values.ts → GsviService.url → client.ts 路径前缀       |
| version            | 原 v1/v2/v4 下拉；src/settings.ts → models/version、infer_single.version、缓存来源       |
| api_key            | API Key，secret 替换／保留／清除；Core headers.ts 自动 Bearer                            |
| request_headers    | 原 secret JSON 字符串；Core values.ts 解析 → headers.ts 显式 Header 覆盖（大小写不敏感） |
| download_headers   | 原 secret JSON 字符串；Core http.ts 首次下载 origin 专用，重定向按目标重算               |
| timeout_ms         | 原默认180000、至少1000；Core client.ts 合成／下载／写入总预算                            |
| text_lang          | 合成文本语言；src/settings.ts → text_lang 载荷                                           |
| emotion            | 情绪／参考预设；settings.ts → emotion 及显式音色选择校验                                 |
| prompt_text_lang   | 原空串默认；settings.ts → 非空才发送 prompt_text_lang                                    |
| refresh_voices     | 原一次性 bool；Core editor/cache.ts 保存消费并复位，启用与初始化自动刷新接线             |
| preset             | 原「渠道初始化预设」对象、原说明／提示、未拆平                                           |
| preset.voice       | 缓存下拉／无缓存手填；src/settings.ts、policy.ts 首次初始化                              |
| preset.max_chars   | 正整数，原默认100；policy.ts Unicode 码点整条计数                                        |
| preset.probability | 0–100 整数 slider，原默认100；policy.ts 一次概率决定                                     |

原 description、hint、default、secret、options、slider 均逐项保留。Core 只投影连接六字段，Worker 收到 version/text_lang/emotion/prompt_text_lang/preset。URL/Key/headers 不入 invocation、模型或日志。

| 原功能                                                         | 实现接线与当前验证范围                                                                                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| /usetts 状态、on/off、引号音色/正整数字数/0–100概率、实时 list | src/index.ts、policy.ts；status/off 不依赖上游；本轮未执行命令                                                                                             |
| /voices、/voice、/tts 三动作                                   | 既有显式实时查询／音色选择／后台合成保留；Core gsvi@1，未运行验证                                                                                          |
| 初始关闭、首次复制预设、群共享、跨/new与重启                   | 原 policy.json/voice.json 不动；已有 /voice 选择优先；本轮只验证配置形状迁移                                                                               |
| 加载／保存自动刷新、一次刷新开关、缓存下拉                     | Core plugin-config/cache.ts、PluginEditor.initialize/manage、配置 editor、main、web配置页；disabled 双保护，失败保留列表与当前选择；禁止执行的动态路径未测 |
| Bearer／显式认证／同源和跨源下载／路径前缀／空参考语言         | Core headers/http/client；逐键静态对照源 gsvi.py，纯 Header 合并检查无请求                                                                                 |
| Agent 来源／整条纯文本／码点／单次概率／0与100／混合媒体跳过   | 保留已接受 T；不改 rawReply、Pi 历史或模型循环，本轮不重跑音色 fixture                                                                                     |
| 错误保留原文／未知不重提／取消撤权不晚发                       | 保留受管 Job/Outbox；明确重定向按源处理，未知响应无重试                                                                                                    |
| 适配 AstrBot outgoing/monkeypatch                              | 使用公开可信 delivery.presentation；Pi 继续拥有会话，原先批准的无第二 LLM 和唯一交付契约保留                                                               |

源的后台刷新由Core专用生命周期管理器调度，保存不等待网络；同实例后继取消旧刷新，退出取消并等待全部任务，单次最多10秒。没有 import 定时器或悬空 Promise，不把语音合成放在这里。查询缓存失败不修改业务设置。停用实例或停用执行后端时安装、页面读取与保存均不查询；无缓存可手填。原生配置服务逐跳按源认证与重定向规则，未知提交不自动重放。第二稿移除了GSVI自加的文本/请求/响应/音频限制，原生WAV按源签名；通用平台上限及未完成项另列，不把这些差异称为用户批准。

## 已保存设置迁移和回滚

0.2 的 flat7 在发布阶段一次迁为 version/语言/emotion/prompt_text_lang + preset{voice,max_chars,probability}；已有值和0%保留。Core服务字段从原已绑定服务投影，未绑定则原schema默认值。policy.json/voice.json/渠道状态不读写、不启用自动TTS；不导入 AstrBot root配置或KV。

先主审提交并更新必要 Core/UI，再由主审核对并运行工作区 `scripts/upgrade-gsvi.ts --zip <本轮包> --sha <SHA> --backup /tmp/pi-gsvi-upgrade/<私有备份>` 准备；`--apply` 才修改正式 disabled GSVI。脚本暂存范围覆盖，上传单个ZIP，只核对原安装job，转换恢复范围覆盖。`--rollback` 清除新覆盖后回选保存的旧release并恢复原实例／范围值，删除本次新增且未引用的服务。复用原服务的等效认证表示字段可能保留，不宣称字节级回滚。脚本不重启native、不启用后端、不操作容器、不查音色；本轮只准备未执行。

同群共享原政策、maxWorkers1自动呈现接纳前拒绝、真实平台ACK、未知接纳恢复、noData隔离和前后台lane、普通非render不复制快照均沿用已接受 T。不是本轮音色运行验证的证据。本轮证据严格区分静态实现／纯配置／disabled UI 与未执行的动态查询、刷新、合成、下载。

## 第二稿：原工具入口与完整静态矩阵

原chat_send和真实Agent工具内delivery.send已接短时呈现，Core构造可信来源，按min(10秒,已知剩余预算75%)及公开工具取消信号执行；Actor权限天花板、原插件/服务版本与grants全程复核。失败/本地超时保留原文，外部取消/撤权不晚发；一个持久Outbox负责最终发送，真实ACK后才返回发送成功，inline历史保留原text。不是强制改用chat_present。短时renderer仍走background/data:none预算，保留控制槽，容量不足在POST前回退。

逐分支审计覆盖origins/outgoing/reply_gate/streaming/main/gsvi，见 docs/bot-api/gsvi-outgoing-parity.md：最终Gate、整条混合内容、分段一次概率、工具独立发送、普通控制帧、Web附件、原始stream/break接口边界分别标明。**原始AstrBot多break generator兼容入口、超大catalog完整跨RPC分页，以及超过通用5分钟操作期限的等待尚未完成；不宣称所有源功能1:1完成。**

本轮只运行配置/静态检查和停用页；未构造或执行合成请求，未运行任何工具呈现、音色查询/刷新/合成/下载的真实或fake验证。safe更新工具还要求Core配置响应inlinePresentationContract=tool-send@1，防止只更新了首稿Core就上传第二稿包。正式19335未改。
