# 插件消费独立资源

资源是独立配置的数据源或服务实例。插件声明依赖协议和方法，在「插件 → 配置 → 服务与能力绑定」选择兼容资源。Provider 和实例在「资源提供者」页面维护，无需安装一个同名业务插件。

```json
{
  "resources": [
    { "alias": "gallery", "protocol": "pi.image-library@1", "methods": ["pick"] }
  ],
  "operations": [
    {
      "id": "pick",
      "title": "取图",
      "description": "从绑定的图库取图",
      "inputSchema": { "type": "object" },
      "grants": ["resource:gallery"]
    }
  ]
}
```

实例需要授予 `resource:gallery`，并将 `resources.gallery` 绑定到资源实例 ID。Host 同时检查插件 grant、方法声明、当前身份的底层资源能力及配置版本；插件不能传入其他资源 ID 绕过绑定。

```ts
import { resource, artifactResult } from '@pi-im-bot/plugin-sdk'

const gallery = resource(context, 'gallery')
const result = await gallery.call('pick', { count: 2 }, { publishFiles: true })
return artifactResult(result.artifactIds)
```

`call` 返回 `{requestId,value,files,artifactIds}`。默认只返回结构化值及文件引用；`publishFiles:true` 将 Provider 声明的同源图片转为本范围受管产物，遵守 Artifact 配额。连接地址和 Headers 由 Host 使用，不放进 Worker 配置或调用上下文。协议不兼容、资源关闭、绑定变化和撤权都会拒绝调用或取消交付。

当前绑定保存在插件实例，所有使用该实例的范围共享此绑定；账号/房间覆盖、按协议默认资源和现有 LLM Provider 桥接仍是后续扩展，不能从 `context` 推测存在未公布的 API。

业务指令可继续使用插件自身命令；无需业务代码的场景，可在资源页直接配置资源方法或 MCP Tool 转指令。资源本身不自动暴露为模型工具。

完整规范与实际接入范围见 [独立资源设计](resource-provider-design.md)。
