# 从 AstrBot Python 插件迁移

迁移目标是当前业务行为和明确的扩展契约，不是照搬框架 patch。先读取部署中实际启用的代码、metadata、schema 和近期使用；保留源码版本/文件摘要、许可证与本地变更来源。

## 映射表

| AstrBot 习惯                        | 本框架应使用的机制                                                         |
| ----------------------------------- | -------------------------------------------------------------------------- |
| command 装饰器、alias               | manifest.commands + operation + parser                                     |
| llm_tool / 动态 llm_tools 注册      | manifest.operations，tool=true；Core 生成 Pi 工具代理                      |
| Star.config / `_conf_schema.json`   | 静态 schema 和本次 invocation.settings；配置写入来自管理 API               |
| StarTools.get_data_dir              | context.dataDir，按实例和聊天范围隔离                                      |
| event/session 发消息                | return PluginResult；额外通知才申请 delivery.send                          |
| html_render                         | 当前无通用服务；可在 Worker 内使用已打包渲染库，或声明新的受管渲染服务     |
| event/Context 取主机指标            | 申请 system.status，不能拿 Worker 的 os 指标冒充宿主                       |
| context.llm_generate                | 当前没有通用插件 RPC；通常返回事实让 Pi 使用，确需独立模型时先设计受管能力 |
| asyncio.create_task / sleep 待结果  | background operation + pending/poll/cancel，或持久观察动作                 |
| 直接 OneBot / TG API                | 已有交付/回执/撤回能力；额外平台能力需显式增加 Core 服务                   |
| monkeypatch LLM / send / tool loop  | context、text、presentation、receipt 等固定切入点                          |
| Provider key、MCP Header 复制到插件 | Core 保管凭据，连接器只传结果                                              |

## 迁移前必须回答

1. 有哪些命令、工具、被动处理和后台行为？哪些实际开启？
2. 原来的状态归属全局、群、conversation 还是某成员？本项目群内共享 user 状态，不要无意改成个人 Agent。
3. 依赖哪些宿主服务、网络、数据、平台操作？当前 RPC 是否真的存在？
4. 操作有无外部副作用、未知提交、取消和结果恢复？不能只把 Python async 翻译成 JS Promise。
5. 配置哪些是偏好、哪些是资源绑定或凭据？不要保留没有功能的开关。
6. 哪些行为已经是 Bot 内置能力？例如 `/status` 是保留控制指令，不能通过插件覆盖。
7. 最小可交付行为和明确未迁移项是什么？保留差异表，不把部分迁移称作完全兼容。

## 首个案例：系统状态

实际旧插件不是只有一个 `/status`：还包含图卡、主机采集、月流量采样/阈值提醒、自定义背景、视觉与文本模型分析。首版迁移选择查询主线：

- 新增授权的 Core 系统快照。
- `/状态`、`/sysstatus` 与 Pi 工具共用 inspect 操作。
- 自定义 parser 分派 card/text/json/help，核心 `/status` 保留。
- Worker 内渲染 PNG，使用 artifact.publish 交回统一交付。
- 不额外调用 LLM，结构化 JSON 可供主 Agent 使用。

后台月统计、跨范围提醒、上传背景和额外模型编排应分别落入后续能力，不复制旧插件对宿主文件、事件对象和平台实例的直接访问。

## TTS 后续迁移检查

GSVI 旧插件包含渠道 gate、短文本限制、概率、动态音色、Header/API Key、重定向下载、主动发送和特定阶段 patch，并不只是 text → wav。

正确迁移方式：呈现阶段 select → 获准语音连接器 → 发布音频 → 返回呈现结果；回执和撤回继续由其他处理器消费。无适用条件返回 null，失败/超时按明确策略沿用文字，不改 Pi 原文，不直接拿平台对象发送。

目前通用 HTTP/语音连接器与动态配置操作尚未公开。MCP 服务桥接或新增受管语音接口应先明确目标、凭据、重定向、下载预算和取消，不开放任意宿主 fetch。不要为方便迁移把插件 Worker 开放到整个家用 LAN。
