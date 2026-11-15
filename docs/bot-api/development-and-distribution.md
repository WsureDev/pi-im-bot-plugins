# 开发、验收与分发

## 当前开发工作区

插件中心提供 schema 配置、使用方法、启停、删除与强制更新。强制更新保存原始来源：目录源跟随当前索引，GitHub 跟随原引用，开发目录重新导入；上传包没有可自动获取的来源。来源记录保存在私有数据目录，不在公共元数据中暴露 URL 凭据。更新保留设置与数据，失败保留当前代码。

迁移目录：`../pi-im-bot-plugins`。打开其中的 `pi-im-bot-plugins.code-workspace`，同时查看插件项目和 Bot API 参考。

```sh
cd ../pi-im-bot-plugins
./node_modules/.bin/bun install --frozen-lockfile
./node_modules/.bin/bun run docs:sync
./node_modules/.bin/bun run check
./node_modules/.bin/bun test tests
./node_modules/.bin/bun run build status
./node_modules/.bin/bun run pack status /tmp/system-status.zip
```

若首次克隆还没有本地 Bun，可先使用已安装 Bun；当前机器可用 sibling Bot 的 `../pi-im-bot/node_modules/.bin/bun install` 完成 bootstrap。`PI_IM_BOT_SOURCE` 可指定构建/打包/文档同步参考的 Bot 源码目录，默认 sibling `../pi-im-bot`；类型检查的 tsconfig paths 同样需要指向所用公开 SDK。

工作区采用 `plugins/<id>/src/index.ts` 入口约定，build 把公开 SDK 和依赖打进 dist/index.mjs。不要把 `@pi-im-bot/plugin-sdk` 当作已经发布到 npm 的依赖；未经构建的工作区别名不能在正式 Worker 中解析。

build 会校验文档快照中的源码摘要，变化时要求先 docs:sync；产物携带不含本机路径或凭据的 API-SNAPSHOT.json，便于后续迁移核对接口。

## 本地验证层次

1. 纯业务验证：解析、格式化、渲染，固定 DTO 输入，不调用模型。
2. 协议集成：使用 Bot 的自编 child-process fixture 验证 command/tool/Host RPC/取消/产物和权限。只允许自编代码使用此替身；它不具备 OS 文件隔离，不能验证容器安全。
3. 隔离应用与 Mock：临时配置/数据/插件目录，执行后端关闭时可验证安装与表单。不得借用正式 Provider 或真实群发送来省事。
4. 真实插件容器：需要用户给出具体容器名称和操作授权，每次变更先输出 Container Change Notice。源码测试通过不替代真实容器验收，也不自动启用正式后端。

不添加数据库单元测试。涉及的核心权限、路由与产物断言应验证可见行为，而不是只断言“某个函数被调用”。例如直接 `/sysstatus --text` 模型请求应为 0，`/status` 不应被插件抢走，撤销 runtime_status 后不能继续得到指标。

## 安装与配置

构建后，在工作台插件中心通过目录或 ZIP 安装，首次保持停用。检查配置、服务依赖、grants、范围、触发人权限与后端依赖，再按部署授权启用。

包导入不执行入口。当前源码预算为每文件 16 MiB、总计 64 MiB、最多 2000 声明文件；配置 schema 256 KiB。ZIP 输入最多 32 MiB，整体解包也有数量和大小预算。代码与 assets 必须是普通文件，拒绝符号链接。

模板/字体/WASM 都应放入 files。不要把真实配置、`.env`、缓存、临时 PNG、数据卷或运行日志打到发布包。README/CHANGELOG 与 `_conf_schema.json` 可自动收集。

## GitHub 与发布包

开发源基址和目录登记统一见 [部署配置](../../../pi-im-bot/docs/configuration.md#插件开发源)；迁移工作区 `bun run source` 可监听变化并发布固定摘要 ZIP。索引兼容当前 Bot 目录协议，工作台刷新后手动安装/更新；Git 仅用于源码管理，不要求每次开发测试先提交。具体状态与配置见工作区 docs/local-plugin-source.md。

建议 CI 构建并发布 plugin.zip，或在专门发布分支提供可运行入口与依赖。仓库链接优先解析可用 Release；没有 Release 时固定默认分支 commit，没有附件时使用标签源码。tree/commit/目录链接先固定 commit，再下载源码 ZIP。

源码安装支持原生 TS，但仅适用于包内可解析的依赖；不会执行宿主 npm install/build。当前迁移插件包含 WASM、字体与工作区别名，推荐发布 build/pack 的产物，不能只上传 src。

静态目录索引需要 id、name、description、version、author、categories、apiVersion=1、ZIP URL 与 SHA-256。目录内容、代码版本、实例设置和范围绑定是不同对象。更新失败保留当前版本，数据迁移仍需作者提供明确方案。

当前未实现：自动 npm tarball 安装、通用数据库迁移、自动清理旧代码、图形化多实例快捷创建和配置型文件上传。不要把草案命令写成已存在的工具。

## 管理 PATCH 的字段语义

`PATCH /api/plugins/:id` 接收 `{revision,patch}`，patch 只允许 name、enabled、grants、connectors、services、dependencies。省略字段保持原值；内部 editor 调用中显式 undefined 同样不改变字段。`grants:[]` 或某映射 `{}` 是合法的明确清空，仅作用于该字段。映射按整个字段替换，不合并其中别名。业务 settings 不由此 PATCH 改写，使用实例 configuration 路由保存。

每个字段复用实例定义的类型/长度/ID/grant约束，但不带创建实例的 default；patch 内和请求外层的未知字段都拒绝。调用者只需提交要修改的字段，无需回传完整 metadata 保护其他配置。保存后继续使用新返回的 revision；release 是包内容版本，乐观锁 revision 可以在重启后刷新。
