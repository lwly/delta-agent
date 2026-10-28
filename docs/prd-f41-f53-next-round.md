# F-41～F-53 下一轮产品需求（PRD）

> 日期：2026-10-28 ｜ 状态：草案待评审 ｜ 关联：`docs/roadmap-f41-f53.md`（优先级与迭代划分）、`docs/design-f41-f53-next-round.md`（技术设计）
> 编号衔接：`docs/PRD.md` 需求池止于 F-40；F-41（运行日志）已交付。本文定义 F-42～F-53。

---

## F-42 模型路由收尾（承接 F-32 预留位）

**需求**：补齐 F-32 明确留下的两处预留位——① classify/summarize 两类任务在运行时的路由接入点；② Web 设置页「模型路由」卡片。

**用户故事**：US-32-A｜我希望摘要、分类这类辅助调用自动走我配的小模型，省钱且不拖慢主任务。

**验收标准**：
- [ ] AC-42-1 压缩摘要触发时，若配置了 `summarize` 路由规则，实际调用走路由模型（usage 记录可区分）
- [ ] AC-42-2 Web 消息流「会话压缩」事件与 F-31 用量面板能按 model 维度区分辅助调用
- [ ] AC-42-3 Web 设置页路由卡片：列出 KNOWN_TASK_KINDS 与自定义 kind，可增改删/启停，保存走 `setRouting` 既有校验
- [ ] AC-42-4 路由模型不可用时回退主模型并在 debug 日志标注（沿用 F-32 容错语义）
- [ ] AC-42-5 单测覆盖两个接入点 + Web 端点；`docs/design-f32-model-routing.md` 预留位章节更新为已落地

## F-43 容器沙箱 CI 化（承接 F-30 挂起项）

**需求**：把 F-30 挂起的 Docker 集成测试纳入 CI——GitHub Actions 起 Docker daemon（services 或 dind），跑既有 Docker 后端集成测试；本地无 Docker 时自动跳过（维持现口径）。

**验收标准**：
- [ ] AC-43-1 CI 在 Linux runner 上执行 Docker 后端集成测试并纳入必需检查
- [ ] AC-43-2 本地无 Docker daemon 时测试自动 skip（输出 skip 原因），不污染退出码
- [ ] AC-43-3 集成测试覆盖：启用 seatbelt/docker 双后端的 run_command 隔离、镜像拉取失败诊断（G3 不添堵口径）、逃逸阻断
- [ ] AC-43-4 `docs/design-f30-container-sandbox.md` 挂起章节更新，PRD F-30 补交付标注

## F-44 提示词注入防护基线

**需求**：外部来源内容（web_fetch 抓取正文、MCP 工具结果、Skill references 文件）进入上下文前，统一打「不可信内容」标记并在系统提示词中声明防御规则；高危模式（yolo）下外部内容中的指令性文本不直接改变权限判定。

**用户故事**：US-44-A｜我抓取的网页/接的 MCP Server 里如果藏着「请执行 rm -rf」这类指令，Agent 不应照做且应让我察觉。

**验收标准**：
- [ ] AC-44-1 外部内容入上下文时带统一包裹标记（来源 URL/工具名 + untrusted 标注）
- [ ] AC-44-2 系统提示词 L1 安全基线新增注入防御规则段（不可覆盖，随 F-10 三级覆盖机制约束）
- [ ] AC-44-3 外部内容触发的写操作/高危命令仍走既有确认流，不因内容措辞降级
- [ ] AC-44-4 注入样本回归集（≥10 条典型注入 payload）作为单测快照，防回归
- [ ] AC-44-5 `docs/PRD.md` §4 安全条目「提示词注入基线防护」从承诺变为可验证交付

## F-45 E2E 测试体系

**需求**：建立跨平台端到端测试：Web 侧 Playwright（注册项目 → 发消息 → 工具卡片 → 回放 → 设置），CLI 侧黄金路径脚本（headless run 退出码协议 → cron → usage）；CI matrix（macOS + Windows）纳入必需检查。

**验收标准**：
- [ ] AC-45-1 Web E2E ≥ 8 条核心路径，全部走 Fake Provider 与隔离 HOME，不依赖真实 LLM/网络
- [ ] AC-45-2 CLI E2E ≥ 5 条黄金路径，覆盖 F-29 退出码协议 0/1/2/4/5
- [ ] AC-45-3 CI matrix（macOS + Windows）跑 E2E 并设为必需检查
- [ ] AC-45-4 E2E 失败输出截图/trace 与 CLI 日志（衔接 F-41 运行日志）
- [ ] AC-45-5 本地一条命令可跑全量 E2E（`pnpm e2e`），README 补说明

## F-46 会话分叉与消息重跑

**需求**：在任意历史 user 消息上「从此重跑」——以该消息为界复制会话（copy-on-write），原会话不变；支持编辑消息内容后重发。分叉会话出现在侧栏并标注来源。

**用户故事**：US-46-A｜Agent 走偏时，我不想从头再来——退回到某条指令改一下重跑。

**验收标准**：
- [ ] AC-46-1 分叉生成新会话：消息 ≤ 分叉点全量复制、预算/权限快照重置、原会话只读不动
- [ ] AC-46-2 编辑重发：user 消息内容可改，其后消息在分叉副本中截断
- [ ] AC-46-3 Web 回放页（F-18）与消息流均有分叉入口；分叉会话带「来自 xxx」标注
- [ ] AC-46-4 软删除级联正确：删除原会话不影响分叉副本（独立 messages 记录）
- [ ] AC-46-5 分叉/编辑重发各补端点单测；SQLite 写入沿用事务口径

## F-47 Web 内置终端

**需求**：Web 工作台内置交互终端，绑定当前会话工作根（含 worktree 联动）；F-38 空态「打开终端」按钮落地为面板内嵌而非唤起系统终端（保留既有 OS reveal 为降级）。

**用户故事**：US-47-A｜我在 Web 里看 Agent 干活时想顺手敲两条命令，不想切走窗口。

**验收标准**：
- [ ] AC-47-1 终端 cwd = 会话工作根，切会话/切分支/切 worktree 后新开 shell 跟随（复用 F-37 联动语义）
- [ ] AC-47-2 终端独立于 Agent 工具沙箱，明确标注「直接执行，不经 Agent 确认」
- [ ] AC-47-3 node-pty 服务端会话管理：断线重连、会话上限（默认 4）、空闲回收（默认 30min）
- [ ] AC-47-4 loopback-only 访问口径维持（与 serve 一致）；终端尺寸自适应
- [ ] AC-47-5 F-38 空态动作区按钮改为打开内嵌终端，「在文件管理器中显示」保留
- [ ] AC-47-6 Windows pwsh / macOS zsh 探测复用既有 ShellAdapter；E2E 覆盖打开/执行/重连

## F-48 MCP 能力补全

**需求**：MCP 客户端从「仅 tools」扩展到 resources / prompts / streamable HTTP transport（含 header 鉴权配置）；`agent mcp` 子命令与 Web 设置页同步暴露。

**验收标准**：
- [ ] AC-48-1 streamable HTTP transport 接入（沿用 stdio/SSE 既有注册口径），支持自定义 header（Key 加密存储不回显，沿用 F-04a 口径）
- [ ] AC-48-2 resources：列表 + 读取，作为上下文注入通道（等价 `@ 引用` 语义），不自动注入
- [ ] AC-48-3 prompts：列表 + 选择后装配为消息模板
- [ ] AC-48-4 MCP 工具描述进入 L4 工具层时按 F-44 untrusted 口径处理
- [ ] AC-48-5 `delta mcp add` 支持 `--transport http --header K=V`；Web 设置页 MCP 卡片同步
- [ ] AC-48-6 单测覆盖三种 transport 的握手/列取/调用与异常降级

## F-49 会话分享导出

**需求**：一键把会话导出为自包含只读 HTML（含工具调用卡片、diff、用量）或 Markdown；纯本地生成，不联网。

**用户故事**：US-49-A｜我想把 Agent 完成任务的完整过程发给同事看，对方不需要装 delta。

**验收标准**：
- [ ] AC-49-1 导出 HTML 单文件自包含（内联 CSS/JS，无外链），浏览器直接打开
- [ ] AC-49-2 导出内容与 Web 回放页（F-18）渲染口径一致；含任务边界、时间线、用量
- [ ] AC-49-3 敏感信息开关：默认脱敏 API Key 类配置（本就不入库，防御性断言）；可选「含图片附件」
- [ ] AC-49-4 `delta export <sessionId> [--format html|md] [--output path]` + Web 回放页导出按钮
- [ ] AC-49-5 大会话（>2000 消息）导出分块渲染不卡死；单测覆盖边界

## F-50 CLI/Desktop 自动更新

**需求**：`delta update` 子命令 + 启动时版本检查提示（可关）；Desktop 壳内检查 GitHub/Gitee Release 并引导下载。首版做「检查 + 下载 + 替换」手动通道，不做热替换。

**验收标准**：
- [ ] AC-50-1 启动检查异步不阻塞首字响应；默认每周一次，`--check-updates false` 可关
- [ ] AC-50-2 `delta update` 按平台（SEA 产物/npm 渠道）给出正确升级指令或直接下载替换
- [ ] AC-50-3 Desktop：托盘菜单「检查更新」+ 有新版本时角标提示，跳转 Release 页
- [ ] AC-50-4 更新源可配（GitHub/Gitee/自定义 JSON）；网络失败静默（衔接 F-41 日志留档）
- [ ] AC-50-5 版本比较与降级拒绝逻辑单测

## F-51 Windows 安装体验

**需求**：Windows 侧一条命令可用的安装闭环：官方安装脚本（PowerShell）+ 可选 NSIS 安装器（PATH 引导、卸载支持）；`delta doctor` 自检（Node 版本/PATH/Shell 探测/SQLite 原生模块）。

**验收标准**：
- [ ] AC-51-1 PowerShell 一键脚本：装 Node（可选）→ npm i -g → 验证 `delta --version`
- [ ] AC-51-2 `delta doctor` 输出环境体检报告（OS/Shell/Node/DB/配置目录/Provider 连通），有问题给「下一步」指令（沿用 G3 不添堵口径）
- [ ] AC-51-3 CI 产出 Windows 安装器工件（衔接既有 SEA win 构建链）
- [ ] AC-51-4 全新 Windows VM 冒烟：安装 → 注册项目 → headless run 全通（E2E 一条）
- [ ] AC-51-5 README Windows 章节按脚本口径重写

## F-52 Skills/MCP 市场（F-21 最小闭环）

**需求**：本地 registry 清单（内置 + 远端 JSON 订阅）→ 浏览/搜索 → 一键安装 Skill 包或 MCP Server 配置；安装 Skill 时强制展示 scripts/ 清单二次确认。不做评分/账号/云端。

**用户故事**：US-52-A｜我看到别人好用的 Skill/MCP 配置，希望一条命令装进来，而不是手工拷文件。

**验收标准**：
- [ ] AC-52-1 registry = 内置清单 + `~/.delta/registry.json` 订阅源（URL 可配，拉取走 F-44 untrusted 口径）
- [ ] AC-52-2 `delta market list/search/install/remove`；install 到用户级 skills 目录（三层覆盖既有语义，项目级手动）
- [ ] AC-52-3 安装含 scripts/ 的 Skill 强制确认（展示每个脚本路径与用途）；权限模式 plan 下拒绝安装
- [ ] AC-52-4 MCP 一键安装 = 写入 provider 配置 + 连通性测试（复用 F-04a/F-48 能力）
- [ ] AC-52-5 Web 设置页市场面板：卡片/搜索/安装进度；E2E 覆盖安装→加载→触发全链
- [ ] AC-52-6 离线可用：registry 拉取失败降级为仅内置清单

## F-53 Web 性能优化

**需求**：兑现 §4 非功能指标中 Web 侧两项（首屏 ≤ 1.5s、大会话不卡）：消息流虚拟滚动、会话列表分页、静态资源与 SQLite 查询优化。

**验收标准**：
- [ ] AC-53-1 消息流虚拟化：≥5000 条消息的会话滚动/跳转流畅（性能预算写入 E2E 断言）
- [ ] AC-53-2 会话列表分页加载（cursor 分页，沿用既有 API 风格）；侧栏搜索走 F-17 索引
- [ ] AC-53-3 消息历史端点支持增量拉取（before-cursor），进入会话首屏只拉最近一屏
- [ ] AC-53-4 首屏：路由级 code-splitting + 静态资源预压缩；Lighthouse 本地口径 ≥ 90
- [ ] AC-53-5 基准脚本入库（可复跑对比），优化前后数据写进设计文档
