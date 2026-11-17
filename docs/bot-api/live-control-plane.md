# 正式控制面：编排、资源与权限

本轮把已确认的预览改动合并进主线，并提供 `/api/control` 的真实数据与运行接口。`preview/` 和研究构建保留供复现；正式服务不启用 `BOT_PREVIEW_RESEARCH`，不装入样例提供者、模拟角色或两份演示预设。

## 页面与数据

- `/orchestration`：实际安装插件的切入点注册计划，沿用 Core 的依赖与优先级排序。支持全局及指定插件编辑，指定插件路由拒绝修改其他插件项。插件中心“编排”复用同一组件。自定义点展示声明，不推测插件内部调用连线。
- `/resource-providers`：已安装插件声明的操作；插件实例是默认资源。声明发现操作后，可以动态登记任意资源实例。配置通过现有 schema 表单与密码框编辑；真实调用选择聊天范围，用于授权和产物归属。后台操作进入现有持久 Job 并在该范围交付。
- `/capabilities`：核心、插件和已发现 MCP 的实际目录。选择全局默认或现有房间设置，编辑启停、Tool/指令入口及独立群聊/私聊角色策略。房间权限沿用原有完整覆盖语义，当前对话还可覆盖；Bot 管理员目录统一来自全局。
- `/trigger-context`：真实运行的身份、来源、捕获权限和资源引用。不是角色模拟器。旧记录缺少聊天类型时不补造平台身份。

普通状态和目录不返回秘密配置。资源配置只通过对应编辑接口私密读取，保留已上线的眼睛显隐方式。

## Provider 规范

Bot 没有资源业务类型枚举。所有操作使用 `PluginOperationSchema` 的输入/输出 JSON Schema，增加可选 `inputUiSchema`，复用现有 AstrBot 配置元数据。未提供 UI Schema 时可生成基本字段，复杂参数可直接编辑 JSON。

插件 manifest 可以声明：

```json
{
  "resourceProvider": {
    "apiVersion": 1,
    "title": "自定义 API",
    "discover": "discover",
    "tools": [],
    "http": { "baseUrlField": "endpoint", "headersField": "headers" },
    "resourceSchema": {
      "collection": { "type": "string", "description": "业务集合", "default": "default" }
    }
  }
}
```

操作和配置仍由插件自己的 `operations`、`_conf_schema.json` 声明。`discover` 必须是已声明的前台操作，其 `result.value` 形如：

```json
{
  "resources": [
    { "externalId": "remote-id", "name": "实例名称", "description": "说明", "operationIds": ["lookup"], "attributes": { "region": "example" } }
  ]
}
```

Host 生成带提供者命名空间的稳定 ID。记录保存在 `resources.json` 的 `provided` 中；再次发现保留配置与启停，缺失项标为 stale。配置与操作列表改变会使在途引用失效；仅更新时间、显示名称不会撤销调用。新接口不使用语音、图像、文件等固定种类。

调用时，拥有资源的 Worker 可读取 `context.invocation.resource` 的 id、externalId、configuration。其他插件不会获得这份私有资源配置。持久任务只公开引用 ID，秘密配置留在主机的固定配置快照及所属 Worker。

新声明 `resourceProvider` 的插件默认不向模型导出操作；`tools` 显式列出允许导出的操作 ID，并继续遵守操作 `tool` 属性和配置权限。通过 `start_job` 也不能绕过此导出限制。未采用新声明的现有插件保留已有 Tool/指令行为。

## 普通 HTTP API

可声明 `resource.http` grant 并由管理员授予实例。隔离 Worker 调用 SDK 的 `resourceHttp(context, request)`，或 `context.host('resource.http', request)`。Host 使用该插件的配置字段解析基址和 headers，结合所属资源配置；不读取任意宿主环境或其他插件的数据。

```ts
const response = await resourceHttp(context, {
  path: 'records',
  method: 'GET',
  query: { id: input.id }
})
return { value: response.body }
```

路径必须落在配置的同源基址前缀内；不自动跟随重定向。body 为 JSON；响应支持 JSON/文本或 `response: 'base64'`，单次最大 128 KiB，较大数据使用分页、分块与现有产物接口。发现等只读调用只允许 GET。

该传输携带插件来源标记；Bot 管理 HTTP 和 OneBot 接入不接受此来源，插件不能通过回调本机管理接口绕过 scoped RPC。此限制不增加用户登录门槛或本地访问密钥。

网络中断或不完整响应按结果未确认传递，不自动重试。会产生副作用的提供者应使用 request/parent ID 作为上游幂等键，并声明已有的 poll/cancel/recover 协议；不要把连接错误当成上游没有执行。

## 权限与触发事实

新策略保存在 `permissions.capabilityPolicies`，与原来的 allow/deny 规则相交；原权限上限不会因为新配置而扩大。一个插件操作和它的命令别名共用角色策略。能力总开关关闭全部入口，Tool 开关控制模型入口，指令开关控制命令入口；宿主调用路径显式记录入口，不能靠传入 source 字段伪装。

角色为 Bot 管理员、当前渠道管理员/群主、任何人。平台身份包含可信来源、账号、聊天类型与聊天 ID；不能重绑到其他群。Mock 昵称或客户端额外 roles 参数不能声明管理员。LAN 管理工作台是已有的可信本地操作员。

管理员目录在全局精确匹配平台、账号和用户 ID。Worker 角色参数中的 Bot 管理身份按当前目录推导；平台角色沿用可信触发事件。权限检查使用当前设置与捕获的权限上限。多身份触发继续取权限交集。

## 调用与后续方向

新资源操作复用已有隔离 Worker、宿主能力、产物和持久任务，不把第三方代码导入 Core。正式 UI 无模拟提供者。既有具名服务连接保留给当前插件，并通过“旧连接配置”维护；它们不是新资源接口的业务类型。

插件可以用现有 `commands` 把同一个 operation 暴露为直接指令，从而跳过 LLM。当前尚未增加独立 MCP server 发布、任意 MCP Tool 的动态命令生成器或任意参数映射设计器；这些仍是前面明确的后续方向。
