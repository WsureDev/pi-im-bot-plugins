# 包、manifest 与配置

## 包布局

```text
plugin.json                 静态能力与文件声明
_conf_schema.json           可选业务配置表单
README.md / CHANGELOG.md     可选文档，自动纳入快照
src/                        作者源码，可不发布
dist/index.mjs              推荐发布入口
assets/                     WASM、字体等声明资源
```

入口可为 JS/MJS/CJS 或 TS/MTS/CTS。TypeScript 在隔离 Worker 中由 Bun 加载。发布端需要提供全部依赖：导入不会执行 install、postinstall 或 build，Worker 关闭 Bun 自动安装和 `.env` 自动加载。含工作区别名或未随包提供 npm 依赖的源码必须先打包。

## 完整的工具 + 指令声明

```json
{
  "apiVersion": 1,
  "id": "greeting",
  "name": "问候",
  "version": "0.1.0",
  "description": "工具和指令共用一个问候操作",
  "entry": "dist/index.mjs",
  "files": ["dist/index.mjs"],
  "operations": [
    {
      "id": "greet",
      "title": "问候",
      "description": "Return a scoped greeting",
      "tool": true,
      "execution": "foreground",
      "timeoutMs": 5000,
      "inputSchema": {
        "type": "object",
        "properties": { "text": { "type": "string" } },
        "required": ["text"],
        "additionalProperties": false
      }
    }
  ],
  "commands": [
    {
      "id": "greet",
      "names": ["问候", "greet"],
      "operation": "greet",
      "description": "返回问候内容",
      "arguments": "text",
      "textField": "text"
    }
  ]
}
```

| 字段                                                   | 实际语义                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| id                                                     | 包 ID：小写字母开头，最多 32 位，可含数字、下划线、连字符                  |
| version                                                | `x.y.z` 或带预发布后缀的版本；内容另有固定 SHA-256 revision                |
| entry / files                                          | 入口必须在 files 中；拒绝越界、符号链接、特殊文件与被修改的快照            |
| author / repository / license / categories / platforms | 展示元数据；platforms 不会替代 handler 的 selector 或范围选择              |
| operations                                             | 最多 100 个操作；每个操作独立输入/输出 schema、grants、期限及同步/后台模式 |
| commands                                               | 最多 100 组；每组 1–8 个别名，引用一个已声明操作                           |
| hooks / points                                         | 处理器与自定义切入点；详见 Hook 文档                                       |
| connections                                            | 显式服务依赖，支持 MCP、插件实例和 gsvi@1 / comfy@1 具名服务映射                                      |

operation.id 最多 48 位。`tool` 默认 true；仅供指令调用时设为 false。`execution` 默认 foreground，后台模式使用 background 并配置 poll/cancel。`timeoutMs` 默认 30000，允许 100–300000；排队和父任务的更短预算仍然生效。

`outputSchema` 若声明，优先校验非 null 的 `result.value`，缺失或为 null 时校验整个 result。结果格式：

```ts
return { text: '已完成', artifactIds: [], value: { count: 3 } }
```

text 最多 100000 字符、artifactIds 最多 12 个。`suppressText: true` 表示纯产物结果，Bot 不会为图片/音频自动补一条默认文字；适合需要“只发图片”或“只发音频”的操作。value 必须可 JSON 序列化。Bot 会把 value 的 JSON 追加到文本投影，完整公开结果超过 12000 字符会归档；不要把秘密值、巨量二进制或内部句柄放入 value。

## `_conf_schema.json`

```json
{
  "prefix": {
    "type": "string",
    "description": "回复前缀",
    "default": "收到：",
    "scope": ["instance", "account", "room", "conversation"]
  },
  "api_key": {
    "type": "string",
    "description": "业务密钥",
    "secret": true,
    "default": ""
  }
}
```

支持 string/text/int/float/bool/object/字符串 list/标量 dict/template_list，以及 options、labels、slider、condition、invisible、readonly、secret、资源选择器和字段说明。默认值要使用正确 JSON 类型，不能写 `"true"` 代替 true。当前 file 类型尚未实现。

- scope 默认仅 instance；嵌套 object 的叶子可以分别允许账号/群/conversation 覆盖。
- 层级顺序：实例基础配置 → Bot 默认覆盖 → 账号 → 聊天范围 → 当前 conversation；后台子会话还可继承父会话/任务覆盖。
- object 按字段合并，数组与字典整体覆盖；空字符串、false、空数组、空字典是有效值。恢复继承删除本层覆盖。
- `context.invocation.settings` 已是本次固定的生效配置副本。插件不要再从宿主配置文件读一遍，也不能通过修改副本更新网页设置。
- 秘密字段仅实例层，读取接口不返回原值；未修改保留，修改用替换/清除动作。包含秘密的复合列表不允许写入共享范围覆盖。
- template_list 用 `__template_key` 识别模板，用框架生成的 `__entry_id` 保持条目身份；不要删除或借用其他条目的 ID 来重排秘密值。
- condition 使用同层字段等值判断，不执行 JS；隐藏字段不会自动删除或授予能力。
- `_special` 的 select_mcp、select_provider、select_model_group、select_persona 只保存资源 ID，不提供通用 HTTP、Provider 或 Agent API。

`_conf_schema.json` 上限 256 KiB，有深度和节点预算；未知元数据、任意 JS 与自定义正则不会作为配置校验器执行。已有 manifest.configSchema 是独立的 Worker 运行校验机制，不是网页表单声明，通常无需同时维护两份。

## 服务绑定与配置引用

```json
{
  "connections": [
    {
      "alias": "images",
      "kind": "mcp",
      "title": "图像工具服务",
      "required": true,
      "setting": "backend"
    }
  ]
}
```

业务配置的 backend 可设 `_special: "select_mcp"`；框架据此生成 connectors 映射。没有 setting 时在能力页选择。只有显式 required 的依赖阻止启用；从旧 grant 推导的绑定默认可选，具体调用时再检查。

代码快照、实例配置、范围绑定和私有数据分别管理。升级不自动删除旧配置字段或迁移业务数据；不兼容配置会阻止启用，需明确处理迁移与回滚。

GSVI 原生配置有固定的 `configurationProjection:"gsvi@1"`，将完整原 schema 与 Core 托管凭据在同一个配置页编辑；范围、缓存与一次迁移见 [GSVI 原生配置页](gsvi-native-configuration.md)。它不是通用凭据投影或任意网络接口。

## 独立资源依赖

插件通过 `resources` 声明所需协议和方法，在配置页绑定独立资源实例，通过公共 SDK 调用。资源实现和插件分别管理，不再使用插件 `resourceProvider` 将自身操作投影为资源。见 [插件资源接口](resource-providers.md)。
