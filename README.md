# Pi IM Bot 插件迁移工作区

这里是独立的 Bun/TypeScript 项目，用于迁移现有 Python 插件并开发后续插件。打开 [VS Code 工作区](pi-im-bot-plugins.code-workspace)，插件代码与 sibling Bot API 可以一起查阅。

- [Bot 插件开发手册](docs/bot-api/README.md)：当前可调用能力、schema、触发、指令路由、Hook、Job、数据和发布。
- [迁移约定](docs/migration/README.md)：来源记录、行为差异和验收。
- [首个插件：系统状态](plugins/status/README.md)：`/状态`、`/sysstatus` 与 Pi 工具。
- [状态插件迁移矩阵](plugins/status/MIGRATION.md)：已完成、简化及后续项。
- [本地插件源](docs/local-plugin-source.md)：Git 源码 + 固定产物目录 + Bun/Hono 监听发布，实际对外基址通过 `.env.local` 的 `PLUGIN_SOURCE_PUBLIC_URL` 配置，参见 [部署配置](../pi-im-bot/docs/configuration.md)。

```sh
./node_modules/.bin/bun install --frozen-lockfile
./node_modules/.bin/bun run docs:sync
./node_modules/.bin/bun run check
./node_modules/.bin/bun test tests
./node_modules/.bin/bun run build status
./node_modules/.bin/bun run pack status /tmp/system-status.zip
```

首次没有本地 Bun 时，可用 `../pi-im-bot/node_modules/.bin/bun install` bootstrap。SDK 别名在构建时解析到 `../pi-im-bot/src/plugins/sdk/index.ts`，产物包含 SDK 与 JS 依赖，正式 Worker 不依赖这个源码路径。`PI_IM_BOT_SOURCE` 可替换构建/文档参考路径，类型检查 paths 也需相应调整。

`docs/bot-api` 是实际 Bot 文档的独立快照，可以在这里持续开展开发；`snapshot.json` 记录来源摘要。修改能力前先同步文档，不凭猜测增加不存在的 `context.host()` 方法。

源码包和构建产物都不包含正式配置、会话或凭据。本工作区不会自动启用正式插件执行、启动真实容器或向 QQ 群发送消息。

测试 preload 只构建本工作区维护的源码，然后使用自编协议替身；不是接受任意第三方插件的开发服务器。build 会校验 API 文档与源码摘要，过期时先运行 docs:sync。

开发时运行 `bun run source`，修改源码后自动发布 `-dev.N` 包，再在 Bot 目录中刷新、手动更新。源码变动不会自动安装或启用插件。

## Git 分享

源码仅通过 Git 仓库分享，不以压缩包交付。请从审核后的源码建立新历史；所有层级的 `.codex`、`AGENTS.md`、`AGENTS.override.md`、本地环境文件、真实配置、运行数据和私有审阅记录不得提交。启动配置集中见 [部署配置](../pi-im-bot/docs/configuration.md)。插件运行协议中的包格式不改变源码分享规则。
