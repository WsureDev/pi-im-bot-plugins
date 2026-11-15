# 来源与依赖

本插件以部署中的 `astrbot_plugin_status` v2.1.0 行为为迁移基线，原作者 FlanChanXwO，原项目 AGPL。TypeScript 实现重新组织为 Bot RPC + 隔离 Worker，沿用 AGPL-3.0-only，完整文本见 LICENSE。

没有复制旧 Python 运行代码、图片、背景或字体。源文件摘要记录在工作区 docs/migration/status-source.json。

发布包包含：

- `@resvg/resvg-wasm` 2.6.2，MPL-2.0；上游 `https://github.com/yisibl/resvg-js/tree/v2.6.2`，完整许可见 assets/RESVG-LICENSE.txt。
- Zod 4.6.7，MIT；见 assets/ZOD-LICENSE.txt。
- DejaVu Sans，Bitstream Vera 许可与公共领域修改；字体未修改，见 assets/FONT-LICENSE.txt。
- 当前 Bot 公共 SDK 的打包代码，实际来源由发布包内 API-SNAPSHOT.json 的源码摘要固定，工作区完整记录位于 docs/bot-api/snapshot.json。

依赖版本和完整性由工作区 bun.lock 固定；WASM 由 build 从该已安装依赖复制，不在 Worker 启动时下载。
