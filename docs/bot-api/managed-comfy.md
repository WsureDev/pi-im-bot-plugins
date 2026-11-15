# 具名 ComfyUI、受管资源与恢复

C 提供 `comfy@1`，由 Core 保存端点、认证、workflow 和逐 item 回执。Worker 无网络、宿主路径或凭据。插件负责提示词、LoRA 选择、业务政策；Pi 仍拥有对话、工具循环、压缩和请求级 fallback。此接口不提供任意 HTTP、上传图片或全局 interrupt。

## 安装与配置路径

1. 构建插件工作区，安装 `comfyui-pro` ZIP，审查 grants。包内含 README、MIGRATION、MIT/NOTICE、词库、usage 和自编 `assets/example-workflow.json`。示例模型名必须替换，不能据此认为模型已安装。
2. 在「服务与技能 → ComfyUI 服务与工作流」粘贴已审查受管模板 JSON。导入只保存资源，不访问 Comfy/GPU。可查看/更新；绑定中的模板不能删除。
3. 新增 ComfyUI 服务：`kind:comfy`，唯一 ID、URL、私有 headers、enabled 和允许的 workflow IDs。编辑页面用占位符保留旧 headers；展示名不属于执行版本。不同服务种类共享 ID 命名空间。
4. 在「插件 → 实例配置」把 `render` 绑定到此服务，设置 default_workflow、allowed_scopes 等政策。群白名单用 Bot room ID 显式映射；不能猜旧 QQ 群号与管理员身份。未配置时不会对群开放。
5. `comfy_catalog`、`comfy_generate`、操作 ID、实例 grants 和目标权限共同约束执行；管理需要 **明确匹配的 comfy_manage allow 规则**。权限 default:allow 不授予此管理动作；Mock 昵称/角色永不作为平台管理员。LAN 管理页面沿用本地操作员身份，不增加登录 secret。

HTTP 管理入口：GET `/api/resources` 返回不含图的模板摘要与掩码服务；POST/PUT/DELETE `/api/resources/comfy[/:id]`；POST/GET/DELETE `/api/resources/workflows[/:id]`。写入需当前 revision，过期保存失败。单模板上限 512 节点/512KiB；模板导入 HTTP body 上限600KiB，RPC frame 上限保持512KiB。正式配置导入/启用不包含在源码验证中。

## 模板契约

模板为 `{id,name,description,graph,parameters,bindings,outputs,models,loras}`。graph 是 Comfy API format：node ID → `{class_type,inputs,_meta?}`，不是 UI workflow。Core 不解释每种自定义节点业务，只在 operator 登记的现有 inputs 标量路径写入值。

`parameters.NAME` 声明 paths、type(string/number/boolean)、default、min/max、maxLength、integer、encoding(identity/number-string)、offsets。路径不可越界/改原型，目标标量类型必须匹配，offsets 长度须匹配 paths；默认值和实际值都校验类型、范围、整数和编码。编译先应用默认值再应用输入，模板原图不修改。数值偏移用于登记的多个 seed，不接受插件脚本或任意节点 patch。

`bindings`：positive 必须为 string；negative 可选 string；seed/steps/stepNodes 为 number。stepNodes 将公开节点标识映射到已登记参数。LoRA 槽的 name/strength/clipStrength/enabled 分别映射 string/number/number/boolean。库存含 id、name、相对 filename、aliases、enabled、strength、clipStrength、triggers、promptHints；模型仅 role/相对 filename 声明。禁止 URL、签名链接、宿主绝对路径、秘密字段/明显凭据。资源/输入都过此校验。

outputs 必须是本图已登记节点，最多16个；SaveImageWebsocket 不能当文件输出。服务最多绑定64个模板。自定义节点是否安装、模型是否存在以及 GPU 兼容性需要另外验证；资源校验不是执行成功保证。LoRA 库存使用 operator manifest 或另行显式授权的 MCP，不提供 host scan path。

## Worker RPC

manifest 连接：`{alias:'render',kind:'service',service:'comfy@1'}`；调用 `context.host('service:render', input)`。

| action | 输入 | 效果 |
| --- | --- | --- |
| catalog | workflow?、section(workflows/parameters/models/loras)、cursor(默认0) | 无上游请求；返回 items/total/可选 nextCursor，每页最多32项、192KiB。详情必须给 workflow。不会把全目录拼成大 RPC |
| submit | item(0..15)、workflow、parameters(登记标量) | 仅可信 execute 阶段且有 Job 所有者可用；一次不可盲重放的 POST /prompt |
| recover / poll | item | 从 Core 原回执只读查询原服务 /history/{id} 与受限 /view，无新 POST |
| peek | item | 仅本地回执元数据，不做 HTTP；帮助区分明确未派发与未知提交 |
| cancel | item | 只取消可确认属于本任务的排队 ID；其他情况停止本地等待 |
| reconcile | item | 显式只读核对，允许核对 abandoned；不获得交付所有权 |

每 item 返回 item、recordId、attempted、hasReceipt、status、artifactIds，以及可选 requestArtifactId/workflow/workflowDigest/error。不会把 prompt_id、端点、headers 或服务快照交给 Worker。not_started 表示无登记；submitted/running 需要继续等待；succeeded/failed/cancelled 是已知事实；outcome_unknown/abandoned 保留未知。attempted 是派发尝试，不表示远端接纳。

## 提交、恢复和取消

Core 从真实调用构造 owner(instance/room/job/revision/item/alias)，散列稳定键；插件不能选择其他所有者。POST 前持久保存原服务/凭据执行快照、模板与参数摘要、允许输出节点、请求 JSON Artifact、未知状态。prompt_id 在返回 Worker RPC 前保存。按键互斥覆盖所有后继 poll/cancel；原键重复提交只返回原记录，参数/模板/服务不符拒绝。

Job operation 可声明 recover、handleSchema、pollInputSchema、cancelInputSchema、recoverInputSchema。execute RPC 丢失、dispatching 重启或缺句柄时，Core 调用 recover `{input:原参数,handle:原handle或null,intent:resume|cancel|reconcile}`。正常 poll/cancel 输入为 `{handle}`。这些阶段按声明校验，Core 禁止非 execute 再 submit。Comfy 插件 handle 只有 count/direct，恢复全部依靠 Core 回执。未知 /prompt 无 ID 不能猜测查询，永不自动重提。

有 ID 的查询始终使用 **原服务快照**。展示名变更允许继续；端点、认证、enabled、模板允许列表等执行版本改变，或操作/动作/grants/实例/目标撤销则停止。不会向服务B发送服务A的 ID；恢复不会混用新 URL 与旧凭据。资源编辑影响新任务；原提交的图/参数/输出节点不重新编译。

/history 只查本任务 ID，显式 completed:false 仍 running；空完成或 error 为 failed。只接受已登记输出节点的文件，最多16图/item。filename 无目录；subfolder 相对且禁止 .、..、反斜杠、空字节、编码/查询片段；type 必须 output。/view 固定原服务，无重定向，限制 body、MIME 和 PNG/JPEG/WebP 签名。Artifact 保存前重新检查权限，保留原生产者/服务/动作来源依赖。

取消先记意图，不使用 /interrupt。GET /queue 确认本任务 pending 且非 running 后才 POST `/queue {delete:[ownID]}`，随后重新读 queue/history。已转 running/完成时记 abandoned，不能把 HTTP200 当取消成功。未知 delete 不自动重复；无 per-prompt 运行取消时只能停止本地等待，不能承诺 GPU 已停。abandoned 可手动事实核对。

Core receipt 是独立 doc family，不建无限全局 history map。活动索引最多128全局/32范围，只存仍活跃 owner；未知已封存和终态从索引移除，原键回执仍永久保留。服务 HTTP 预算全局4/单服务2、最多64排队使用者；下载全局2，租约跨越字节读取与 Artifact 持久化，最多34使用者，受服务超时。插件串行提交不是这些全局上限的安全前提。

## 状态、结果与交付

公共 `state.read {area:scope|instance,key}` 返回 `{version,value}`，空值 version0/null；`state.compare {area,key,version,value}` 返回 applied/version。每值32KiB、命名空间64键/128KiB；实例与范围隔离、CAS 提交内复核当前授权。data:none 可以使用此 Core 状态，但不能 artifact.publish 私有卷文件。状态升级/清理仍是插件显式业务；停用不删除状态或原回执。

Comfy 调试 ring 保存最近20条实际派发尝试的 JSON Artifact 引用和状态；FIFO pop 不删不可变提交/恢复回执。`state.compare` 的可选 comfyReceipt 只允许当前 Job、scope 的 comfy.records 原子登记标记，防止 pop 后 recover 又重新入队。它不是任意文档或跨实例事务入口。

PluginResult 可附 format(direct/forward)、itemized、businessStatus、factsComplete、items。业务 partial 与平台 partial 分开：已有成功但仍有未知 item 时 factsComplete:false，Job 保持 outcome_unknown，可核对剩余事实；全部事实已知的部分失败可终态。手动核对只更新原事实/Artifact/JobFacts，不改原 Outbox、不重发。pending/unknown/无新result保留原结果；有新result时按item合并，已确认succeeded/failed/cancelled与Artifact引用不回退，仍有未解决项继续outcome_unknown。finish/cancel/recover/reconcile共用此合并规则，不重启自动等待或聊天交付。

Core 唯一 Outbox 交付。direct 按图记录真实平台 ACK 和每 part ID；forward 由支持的 adapter 原子翻译为合并转发，未知回执不降级再发。Mock 等无 forward 能力时 **发送前**明示 effectiveFormat:direct。forward 即使只有文字也整条 mixed，自动 TTS 跳过。每批1..16、每 item 最多16图、最多256引用；平台仍有既有总媒体20MiB等能力预算，大图保留 Artifact/可读错误，不承诺所有平台接受任意256张图。同步 chat_send 仍等真实 ACK。

任务页显示业务结果、未知事实、逐项请求 JSON、产物与发送回执；GET `/api/rooms/:room/jobs/:job/delivery` 仅返回发送格式/状态/已确认 part/ID，不暴露 renderAdmission。/stop、/new、模式/目标切换和撤权抑制未来交付；已确认/部分/未知发送均不自动重发。

## 模型历史投影

`model.history@1` 是公共 collect Hook：输入空对象，返回 `{hideArguments:[本实例已登记operation ID]}`，Worker 不接收历史正文。Core 仅在匹配本实例工具调用时复制该 assistant 消息及匹配 part；无匹配的大历史共享原引用。直接工具和受支持的 `start_job {title,capability,arguments}` 均验证归属，不能遮其他插件或 Agent 任务。

Pi 公共 beforeRequest/context 扩展在每次模型请求前应用投影；原 Pi 审计、IM 消息、用户输入、恢复 receipt 和提交 JSON 不变。comfy_history 关闭时隐藏 generate 的工具参数，开启时保留；停用此 Hook 会停止过滤。它不删除历史审计，不追溯修改已有压缩摘要，也不是秘密擦除功能。不增加第二轮 LLM 或 monkeypatch。

无数据调用按Core可信前台/后台使用独立lane/key；同scope的usage/catalog/管理可使用预留前台容量，在后台POST等待期间响应，不需抢占或取消后台调用。同一lane内仍串行，data:scope仍共用原私有数据串行锁。嵌套调用继承后台预算并使用相同实际key检测重入，业务参数不能升级；Validators仍独立。各lane共用原maxWorkers/内存/请求预算，清理完成才释放槽。maxWorkers1前台无数据合法，后台无数据呈现仍POST前拒绝。Core stop/new先封存交付再取消，不复活原任务。
