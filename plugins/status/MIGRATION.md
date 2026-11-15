# AstrBot Status 迁移记录

基线：本机部署目录 `status-deployed-2.1.0`，metadata 声明 `v2.1.0`，原作者 FlanChanXwO，仓库 `https://github.com/FlanChanXwO/astrbot_plugin_status`。部署目录不含 Git 元数据，因此以 `docs/migration/status-source.json` 的逐文件 SHA-256 为实际来源依据，不伪造上游 commit。

本次是查询主线迁移，版本 0.1.0，不宣称与旧插件全部功能等价。没有修改旧插件或原 AstrBot 配置，也没有读取原运行态密钥配置。

| 旧行为                                 | 新实现                                                            | 状态                                                       |
| -------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `/status`、`/状态`                     | `/状态`、`/sysstatus`；核心 `/status` 保留                        | 完成，明确解决保留别名冲突                                 |
| 动态注册 astrbot_get_system_status     | manifest operation inspect，稳定能力 plugin:system-status/inspect | 完成；模型别名由 Bot 生成                                  |
| 直接 psutil/宿主 subprocess            | 授权的 system.status RPC                                          | 完成；只观察 Bot 控制面可见域                              |
| CPU/RAM/SWAP/DISK/LOAD/uptime/网络/GPU | Core 快照，卡片/文本/JSON                                         | 完成；GPU 由 Bot 控制面固定参数探针读取，Worker 不接触设备 |
| AstrBot HTML/T2I                       | Worker 内 resvg WASM + 静态 SVG 模板                              | 完成；不访问外部站点                                       |
| 插件直接发送图片/StarTools             | 返回 Artifact，由统一交付发送                                     | 完成；无 adapter 对象                                      |
| Bot 名称与字体                         | 文字摘要可配置名称，卡片英文标题                                  | 有意简化                                                   |
| 自定义背景文件上传                     | 当前 schema 不支持 file，未保留入口                               | 后续                                                       |
| 每 300 秒月流量采样与持久累计          | 当前只查询内核累计计数，未实现守护采样                            | 后续；需要明确持久触发机制                                 |
| 按 UMO 跨范围流量提醒                  | 不允许插件随意指定其他群发送                                      | 后续；需要受管路由授权                                     |
| 视觉 + 文本模型二次分析                | 返回事实供 Pi 使用，不重复识图调用                                | 后续；不提供假 llm_generate API                            |

## 关键边界

- system.status 和 artifact.write 必须同时在 operation 与实例中允许；RPC 另验 runtime_status 动作权限。
- 命令还需 command:plugin:实例/status 与 plugin:实例/inspect 两项能力；关闭群 Agent 仍可使用已授权命令。
- 参数只选择输出形式，不接受宿主路径、任意命令、目标群或冒充身份。
- 卡片成功结果只带图片 Artifact，文字/JSON/帮助结果只带文字；Bot 交付层不再为图片结果补一条默认文字。
- 每次卡片临时文件以 invocation.id 区分；发布成功或失败均清理本地临时 PNG。没有在源码目录建立 data。
- 不启动 import 生命周期定时器，不保存跨群全局可变数据；WASM 初始化只是每个 Worker 可丢弃缓存。
- 同一 inspect 提供给指令和工具；CLI parser 只解析，不产生状态采集或外部副作用。

## 已有验证

工作区测试覆盖参数路由、CPU/内存等口径、PNG 格式、实际 SDK/RPC/产物链、核心保留指令、无 LLM 指令路径、Pi 工具调用及动作撤权。自编子进程替身用于工作区验收。初次迁移时正式执行关闭；2026-11-12 部署记录与 2026-11-13 只读诊断已确认执行启用。当前能力与状态应分别核对，普通源码验证不包含正式执行、容器变更或真实群发送。
