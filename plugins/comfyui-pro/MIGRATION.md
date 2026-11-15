# ComfyUI Pro 业务迁移矩阵（C，源码与离线验收已独立接受）

> Historical validation note: ${VALIDATION_DIR} is a placeholder, not a published location. Local logs, patches and orchestration inputs are not included in this Git repository.

部署来源 **v2.4.2**：`comfy-deployed-2.4.2`。维护参考 v2.4.3：`comfy-reference-2.4.3`，其批交付修复只作参考，不冒充部署版本。作者 lumingya，MIT Copyright 2025 lumingya；WsureDev fork。逐文件 SHA/许可/作者记录在 Bot `docs/framework/tts-comfy-source-inventory-2026-11-13.json` 及框架报告；静态敏感词库按源 legacy_lite/full 适配，NOTICE 随包。

这是独立 TypeScript 业务实现。C 代码/离线验证与生产应用分开：未读取 root0600 正式配置，未应用旧 KV、服务绑定或资源，未部署、未发真实模型/TTS/GPU/QQ请求，未修改既有容器。来源只确认“当前未全局禁用”，不能推断 profile、渠道启用或运行健康。

| 源业务                          | 当前可用入口/语义                                                               | 适配与证据                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| comfyui_usage / 静态说明        | usage 工具，/comfy帮助、/comfyui_usage；包内 assets/usage.md                    | 不调用 LLM、Comfy 或模型目录；只读实时政策摘要                                                                                                                                |
| comfyui_workflows / 模型声明    | workflows 工具，/comfy_ls、/comfy_list、/comfyui_workflows；section/cursor 分页 | 模板摘要、模型/LoRA 元数据来自服务绑定；大页 scope Artifact，超过512KiB的合法组合已测；不批量灌入模型上下文                                                                   |
| comfyui_txt2img                 | generate 工具；/画图、/绘画、/comfyui_txt2img                                   | Pi 自行编写提示词/选择工具；直接命令使用提供的正文，不另启第二 LLM                                                                                                            |
| 画图 / 画图no                   | forward / 按图 direct，Core 唯一 Outbox                                         | OneBot 原子 forward 真 ACK；Mock 发送前降级直发；未知 forward 不切格式重发。typed forward 即使纯文字也 mixed，TTS 跳过                                                        |
| -n、-c、-wf 等                  | --neg/--negative/-n 为负词；--count/-c 为1..16；--workflow/-wf 为资源ID         | 带引号/转义支持；未知/重复/缺值/未闭合引号明确错误。包含普通选项文字时加引号或使用 --；负词绝不变 GPU 次数                                                                    |
| workflow 文件/别名/输入输出设置 | /comfy_use ID、generate.workflow；绑定 positive/negative/outputs                | 文件名转为稳定 wf-hash ID，name 保留文件名用于检索；MIGRATION/import-report 对应。旧别名需 operator 明确映射为资源 ID，不猜不可读配置。输入/输出节点改由模板允许路径/节点声明 |
| 每 workflow/node 步数           | /comfy_add list、clear、NODE off、NODE N [NODE N...]；/comfy_steps 同义         | scope.stepOverrides 按 workflow 与登记 stepNodes 保存；优先级 scope < 单次 steps < 单次 node_steps。切 workflow 不污染另一个；未登记/越界拒绝                                 |
| LoRA 名称/别名、禁用、数量      | generate.loras 或 `<lora picks="name:0.8@1+2,!clear_defaults">`                 | 库存 manifest 可禁用条目；匹配 ID/name/相对文件名/basename/aliases，歧义拒绝；max_loras 限选择数。lora_enabled 关闭显式选择/清默认，不偷偷改模板默认图                        |
| 默认 LoRA 保留/清除             | keep_defaults_when_selected / clear_defaults                                    | 先保留全部活跃默认，再分配空槽；同一 LoRA 不重复塞槽，超槽明确拒绝。禁用库存的默认关闭；独立 clip_strength 必须有登记绑定                                                     |
| 触发词                          | 显式1起始 @1+2；否则 promptHints 或唯一候选                                     | 多候选不猜第1项；inject_selected_prompt_hints 可关闭全部注入；去重后与提示词合并                                                                                              |
| LoraManager stack               | dry-run 支持数组及 **value** 对象、字符串 strength/clipStrength、active         | 转为受管标量路径/number-string 编码；副本默认加4个关闭空槽（总<=16），operator可映射数量，原文件不动；纯业务/真实编译回归覆盖                                                 |
| 负词/随机种子                   | 模板负词 + default_negative + 单次负词；随机seed及每item递增                    | 所有变换经Core参数类型/范围/整数校验。多个 seed 偏移只能由资源登记；无负词绑定而传负词拒绝                                                                                    |
| 多图/批次                       | 1..16 item，各自 Core receipt/请求JSON/状态/产物                                | 实际16项提交、16份产物、16个独立平台 ACK 已测；每item最多16图，总引用256。平台总媒体20MiB等预算继续有效，不能承诺任意256张大图都可直发                                        |
| 敏感词                          | 默认群full/私聊lite，none/lite/full；/违禁级别（banlevel/敏感级别）             | scope动态覆盖；NFKC/大小写标准化，英文单词边界，中文子串。与源 AstrBot 层过滤位置适配，非凭空声称过滤全部隐式提示词                                                           |
| 白名单/私聊                     | allowed_scopes 默认[]、allow_private                                            | 使用Bot scope ID显式映射，不自动读取群ID/正式配置。Core管理能力可显式配置旁路，默认均false                                                                                    |
| 冷却                            | scope按可信actor散列CAS占用，<=128活跃记录                                      | 校验不通过不占用；原token幂等；只在Core peek证实所有item未派发时退还。已派发拒绝/未知均保守保留；同actor并发仅一任务通过已测                                                  |
| 全局管理锁                      | /comfy_lock on/off/status（全局锁定/锁图/绘图锁定）                             | instance CAS跨scope共享；lockdown为无状态时默认，动态值优先；lockdown_command_enabled 控制动态命令。需Core明确comfy_manage allow，Mock昵称/角色无效                           |
| comfy_history                   | on/off/status（提示词历史/提示词保留），scope共享跨/new持久                     | 公共model.history@1在Pi请求前过滤本实例generate工具参数，包括实际start_job入口。真实Pi off/on各2模型调用验证；不改Pi内部历史/原审计/用户正文/恢复receipt                      |
| 最近20提交JSON / FIFO pop       | /comfy_record list、pop COUNT；完整JSON为scope Artifact                         | 只记实际派发尝试，不把intent/未知当成功；20条淘汰，FIFO顺序；UTF8按字节拼完再decode。与永久Core恢复回执分离；pop后核对不重新入队/POST/群发                                    |
| 后台、部分、恢复                | execute/poll/recover/cancel；手动任务核对                                       | prompt_id在RPC前由Core保存；同进程响应丢失、无handle、重启均恢复原ID。部分成功+未知 factsComplete:false，仍outcome_unknown可核对；已知失败partial可终态                       |
| 服务/取消                       | Core具名服务快照；只精确queue delete                                            | 展示名可变；URL/凭据/策略版本/权限撤销停止，旧ID不发B。排队转running竞态为abandoned，允许人工只读核对；运行任务无per-prompt取消，不承诺停止GPU；无interrupt                   |
| 2.4.3批交付修复                 | 采用Core Job/Outbox受管机制                                                     | 未复制Python daemon/后台Promise；批部分业务与传输状态分开；ACK未知不自动重发                                                                                                  |

## 安装配置与资源转换

在工作区运行 `bun run docs:sync`、`bun run build`、`bun run pack comfyui-pro /tmp/任务目录/comfyui-pro.zip`。ZIP导入 Bot 插件管理后，在「服务与技能」先导入模板，再建 comfy 服务，再在实例配置把 render 绑定到服务。服务端点和headers只在Core；插件只看到别名和非秘密目录。完整API与管理JSON见 `docs/bot-api/managed-comfy.md`。

自编示例 `assets/example-workflow.json` 可演示管理入口，模型名须明确替换。真实来源19份资源只读转换工具：

```sh
bun scripts/import-comfy.ts --input /明确来源/workflow --out /tmp/任务目录/proposals
```

默认 dryRun:true/applied:false；不传 --out 只报摘要。--mapping 可按源文件名指定 positive/negative 标量路径数组、outputs 节点列表、extraLoraSlots。禁止/诊断秘密字段、明显凭据、URL/签名链接、宿主路径、非法图、不能推断的输入、仅WS输出、LoRA形状或配额不支持。不会读取不可读配置、历史图片/对话/模型；不会自动应用正式资源或发GPU请求。

本轮实际13 workflow +6 sidecar均得到 **待operator审查** 候选，不等于13份可运行验证。LoraManager副本加关闭空槽有注记；含 SaveImageWebsocket 的图只登记既有文件输出并明确提示 operator 重配/确认，不能宣称支持WS收图。源SHA与文件名→资源ID/诊断/变换在 c/import-proposals/import-report.json；不把生产原图/模型文件带进Git。

## 分层差异和限制

- 旧 AstrBot Context、adapter monkeypatch、自动二次LLM补图/改写控制标签不迁入；Pi通过usage/workflows/generate统一编排，不新增第二Agent/LLM循环。直接命令不会额外写一次提示词。
- history off是模型可见工具参数政策，不是删原始审计。用户消息、已生成压缩摘要、提交JSON及Core恢复账本保留；停用对应Hook会停止过滤。ring保存/关闭history互不影响。
- 默认与动态政策作用于新请求。已受理任务使用原业务参数/模板决定；需停止原工作时用/stop、/new或Core权限/服务撤销。不能靠切workflow或关history删除已提交GPU任务。
- 源comfy_save/任意宿主扫描/模型下载、测试发送/探针、重绘旧控制标签和调试API入口不公开。管理编辑通过受管模板表单；重新绘图由明确新的generate参数请求，不能重POST未知旧意图。LoRA MCP须另行显式授权；不提供主机目录能力。
- 运行取消没有per-prompt保证；未实现跨服务接管、upload/img2img或WS输出。旧KV/管理员和别名映射需operator提供合法可读导出后审查，未自动应用正式状态。
- Worker execution/data隔离、前台容量、服务预算、权限上限、TTS混合跳过、Pi原文/历史和唯一Outbox契约保留。安装/配置不等于正式runtime已启用或生产连通。

离线自编Comfy/GSVI/模型 +真实包/Worker/RPC/Job/JSONL矩阵、浏览器组件、检查/包/回放精确收据见 Bot框架C报告及 `${VALIDATION_DIR}/c/`。C源码与离线验证已由WSL主审核者独立接受；正式生产配置、旧数据和部署未应用。

## C第二轮复审修复（待主审接受）

第一稿的两项真实链路问题已回修：pending/unknown/无新结果的手动核对不再抹除原partial、Artifact和factsComplete:false；按item合并已确认事实，随后完成补齐原JobFacts，始终不重POST、不重发原聊天、不恢复自动交付。取消/恢复/核对与外部收尾使用同一Core结果合并规则。

Core将data:none的可信foreground/background分成独立lane/key，同scopeusage/catalog/管理在后台HTTP等待时仍能用预留前台容量；状态通过受管CAS保持一致。没有把前台改成data:scope、没有私有卷或增加总Worker/内存预算。同lane和data:scope继续串行，嵌套后台依赖继承预算并按实际key拒绝重入。max2/max4真实包回归含冷启动/空闲回收与总槽峰值，maxWorkers1和noData文件拒绝继续由T有效脚本验证。

累计C补丁仍从接受T的两个实际HEAD导出；上一稿与原SHA保存在任务c/round1-handoff，新稿另附相对上一稿的增量和连续回放。完整验证数字以最新HANDOFF/框架报告为准，生产配置/数据仍未应用。
