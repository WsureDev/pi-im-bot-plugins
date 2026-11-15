# ComfyUI Pro

安装包提供 usage/workflows/generate/record/manage 与画图、画图no、comfy_history、comfy_lock、comfy_use、comfy_steps、违禁级别等指令。绑定 Core 的 comfy@1 服务别名 render；模板/模型/LoRA 元数据由受管资源提供。群默认无白名单，先将目标 Bot room UUID 明确加入 allowed_scopes，选择 default_workflow。私聊由 allow_private 控制。

Core 服务与模板管理在「服务与技能 → ComfyUI 服务与工作流」。端点及认证只由 Core 保存，不进入插件配置。受管模板为 API-format graph + 明确参数路径/类型范围/输出节点和静态 LoRA/模型声明。导入工具默认 dry-run，不修改 AstrBot 资源或正式状态。

Pi 按需使用只读 usage/workflows 编写提示词，generate 后台返回受理信息，Core 轮询原 receipt，统一交付。默认画图为 forward；画图no 为按图 direct。无forward能力的平台在发送前降级为direct，未知发送不会切换格式重发。大结果和完整提交JSON在scope Artifact/任务页，模型只获得摘要。

comfy_history on/off/status 管理后续模型投影是否保留本插件生成工具参数；不会改写Pi审计、用户正文或恢复receipt。管理需要Core明确 comfy_manage 授权，Mock名字/角色不授予管理权限。全局锁是instance状态，history/workflow/steps/sensitive是scope状态，跨new保留。

详细配置、迁移差异与验收见 MIGRATION.md 和 docs/bot-api/managed-comfy.md。本包是源码迁移，不代表已部署或正式旧配置已转换。
