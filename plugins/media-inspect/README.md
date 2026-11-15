# media-inspect — 新的媒体诊断/导出消费者

`/media-inspect <mediaId>`，或不带参数从最近 20 条本范围历史找最近入站附件。Pi 工具 inspect 使用相同后台 operation，输入 mediaId。mediaId 来自规范化附件/历史，不接受 URL、平台文件 ID 或宿主路径。

最多 2 MiB，按 128 KiB 读取。支持 image/png、audio/wav（含 x-wav/wave）、text/plain 和 application/json。PNG 检查头、尺寸和块边界（不校验 CRC 或解码像素）；WAV 检查 RIFF 头和长度（不解码声音）；文本严格 UTF-8，JSON 另检查语法。结果是原始字节导出、SHA-256/元数据 JSON 报告和文字摘要，统一由 Job 发送一次。私有临时文件完成后删除，Artifact 依现有持久策略保留。

实例 grants：media.read、history.read、artifact.write。业务权限：media_read、chat_history 和插件 operation/command。Bot 在读取、发布、结果和每次发送前复核；跨聊天、来源撤回、取消、超限和来源不可用会拒绝。导出产物保留媒体依赖，撤回后不可通过产物重新交付或下载。

此插件没有主体识别、画框、GIF 推理、头像抓取或自动回复。它不是 astrbot_plugin_kuang 的迁移。

公共发布前确定的本地尺寸、MIME、结构和编码错误返回 failed。宿主读取/授权/来源异常保守处理；取消继续传播。开始 artifact.publish 后的中断或部分发布可为 outcome_unknown，保留已保存产物，不自动重跑导出。
