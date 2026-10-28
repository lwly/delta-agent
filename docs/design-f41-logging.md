# F-41 运行日志 —— 技术设计

> 日期：2026-10-28 ｜ 关联：docs/prd-f41-logging.md ｜ 样例沿用：F-33（旁路注入/静默降级）、F-22（存储目录注入隔离）

## 1. 决策表

| # | 决策 | 理由与备选 |
|---|------|-----------|
| D1 | 新增 `packages/core/src/logging/logger.ts` 单模块，`RunLog` 同时承担：内存环形缓冲 + 订阅扇出 + 按日文件落盘 | 一个类三个消费面（HTTP 尾读 / SSE 实时 / 文件留档），拆开反而要三处对齐事件流；备选 winston/pino 违背零依赖约束（AC-6） |
| D2 | 写入采用 `fs.appendFileSync` + try/catch 静默 | 本地单进程、低频写入（一次任务数十条）；异步化引入背压/乱序问题，收益为零；失败静默对齐 AC-5 |
| D3 | 按日分文件 `serve-YYYYMMDD.log`，构造时清理一次过期文件（默认 14 天） | 自然滚动无需重命名/大小监控；对齐 technical-design §9「日志统一 LF」；备选按大小轮转复杂度不值 |
| D4 | hub 不直接依赖 `RunLog` 类，依赖最小接口 `RunLogSink { append(level, source, message, sessionId?) }` | 对齐 F-33 D7 注入模式：测试可伪造，core 内部无类耦合 |
| D5 | 日志埋点收敛在 **hub.send 的入口层**（run_start / tool_result / error / run_error / run_done），引擎与工具零改动 | 对齐 F-33 D1「事件进 sink、由入口注入」；引擎事件流已有 `publish`，入口天然能截获全部关键节点 |
| D6 | HTTP 端点两个：`GET /api/logs?limit=N`（tail）+ `GET /api/logs/stream`（SSE），均要求 `ServeOptions.runLog` 已注入，缺省 404 | 与 `/api/sessions/:id/events` 同风格；`runLog` 缺省不注入时功能不可见（desktop 宿主自决） |
| D7 | headless run 留档实现在 **CLI 入口**（cli/headless-run.ts），core 不动 | headless 内核「不触碰 stdio/process」的既有约束；运行日志文件路径依赖本机目录，属 CLI 形态职责 |
| D8 | cron 留档不新增文件：cron spawn 子进程即 `delta run`（F-22 既有架构），自动获得 D7 的 run 日志；`cron.json` 运行历史（20 条）+ run 日志互补 | 在 spawn-executor 再写一份 job 级日志是重复留档；runner 的调度过程行经 serve 的 logger tee 进 serve 日志即可 |
| D9 | Web 用独立页面 `/logs`（工作台子路由，对齐 `/cron` 模式），不用弹窗 | 日志是持续滚动流，弹窗生命周期与 SSE 订阅管理互扰；/cron 已建立子路由先例 |
| D10 | 日志单行文本格式：`<ISO时间> [LEVEL] [source] [sessionId?] message`，session 维度字段以结构化 `LogEntry` 对象进内存/SSE，落盘时才序列化为文本 | 人可直接 `tail -f`；结构化字段供 Web 过滤（级别/会话） |
| D11 | `paths.ts` FILES 增加 `logsDir: 'logs'`；`RunLog` 目录一律由宿主/测试注入，core 不写死 homedir | 对齐 paths.ts「单一事实来源」与既有 cronHomeDir 测试隔离模式 |

## 2. 抽象分层

```
packages/core/src/logging/
└── logger.ts     LogEntry / RunLogSink / RunLog（ring + 订阅 + 落盘 + 清理）/ createRunFileLogger
```

```ts
export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;             // ISO 时间
  level: LogLevel;
  source: string;         // 'serve' | 'hub' | 'cron' | 'run' ...
  sessionId?: string;     // 会话维度日志携带，Web 过滤用
  message: string;
}

/** hub 等埋点方依赖的最小接口（D4） */
export interface RunLogSink {
  append(level: LogLevel, source: string, message: string, sessionId?: string): void;
}

export interface RunLogOptions {
  dir?: string;           // 日志目录（缺省不落盘，仅内存 + 订阅——纯内存模式供轻量宿主）
  fileName?: string;      // 缺省 serve-YYYYMMDD.log（按日）
  ringSize?: number;      // 缺省 1000
  retentionDays?: number; // 缺省 14（0 = 不清理）
  now?: () => Date;       // 测试注入时钟
}

export class RunLog implements RunLogSink {
  constructor(opts?: RunLogOptions);
  append(level, source, message, sessionId?): void;  // ring + 订阅扇出 + 文件追加（全部 try/catch 静默）
  tail(limit?: number): LogEntry[];
  subscribe(fn: (e: LogEntry) => void): () => void;  // 返回退订
}

/** 独立追加写入器（headless run 留档用，D7）：多行文本直写 */
export function createRunFileLogger(dir: string, name: string): { log(line: string): void; path: string };
```

## 3. serve 接线（packages/core/src/server/runtime.ts）

```
createServeRuntime
  ├─ runLog = opts.runLog ?? new RunLog({ dir: <userConfigDir()>/logs })
  ├─ log    = tee(console.log,  runLog.append('info', 'serve', …))   // 既有 log/logError 缺省链路升级
  ├─ logError = tee(console.error, runLog.append('error', 'serve', …))
  ├─ SessionHub deps.runLog ← runLog                                     （hub 埋点）
  └─ createWebServer opts.runLog ← runLog                                （HTTP 端点 + cron 调度行）
```

- `ServeRuntimeOptions` 新增 `runLog?: RunLog`（宿主注入，测试传隔离目录实例）；不传时按缺省目录自建。
- MCP 接入、onboarding 等既有 log/logError 调用点零改动即获得落盘（tee 在缺省链路上）。

## 4. hub 埋点（D5）

| 时机 | level | source | message |
|------|-------|--------|---------|
| send 开始（前置校验通过后） | info | hub | `任务开始：<input 前 200 字符>` |
| tool_result 事件 | info | hub | `工具 <name> ✔/✘（<ms>ms）` |
| 引擎 error 事件（fatal） | error | hub | 事件 message |
| catch 分支（run_error） | error | hub | 异常 message |
| finally（正常结束） | info | hub | `任务完成（<duration>ms）` |
| finally（aborted） | warn | hub | `任务被中止（<duration>ms）` |

全部经 `deps.runLog?.append(...)` 可选链调用并整体 try/catch（AC-5），携带 sessionId。

## 5. HTTP 端点（packages/core/src/server/http.ts）

```
GET /api/logs?limit=N      → { items: LogEntry[] }（tail，limit 缺省 200、上限 1000）
GET /api/logs/stream       → SSE：连入即推当前 tail(200)，此后逐条推送；15s ping；断开退订
```

- 两个端点均要求 `opts.runLog` 存在，否则 404（对齐 cronExecutor 缺省 400 语义的「能力未装配」口径）。
- cron「立即运行」（POST /api/cron/:id/run）的 `runDueCronJobs` 调用补传 `logger`（tee 进 runLog，source='cron'），daemon 侧 CLI 已有 console 输出不变。

## 6. headless run 留档（packages/cli/src/headless-run.ts）

- 任务开始时 `createRunFileLogger(<userConfigDir()>/logs/runs, <HHmmss>-<sessionId 前 8 位>)`；
- 写入行：任务描述、引擎模式、结束状态与耗时（`status / turns / usage / durationMs`），onEvent 的工具调用过程行（`⚙ name(args)` / `✔/✘ name(ms)`）；
- 全程 try/catch 静默（AC-5）；`--json` 与人类模式行为完全不变（留档只增不改）。
- cron spawn 子进程（`delta run --json`）走同一入口，自动留档（D8）。

## 7. Web（packages/web）

```
router.ts           /logs 子路由（workbench children，对齐 /cron）
api/client.ts       LogEntryView + api.logsTail(limit)
api/sse.ts          subscribeLogs(onEntry)（EventSource，对齐 subscribeSession）
views/LogsView.vue  日志页：进入 tail 拉取 + SSE 追加；级别 chips 过滤 / 文本过滤 / 自动滚动开关 / 复制
WorkbenchView.vue   侧栏 nav「📜 运行日志」（对齐 ⏰ 定时任务入口）
```

- 日志着色：error 红 / warn 黄（沿用 theme.css 语义色 token）；
- SSE 断线由 EventSource 自动重连，重连后不补拉（窗口期日志靠下次进入页面 tail 兜底）。

## 8. 测试

| 文件 | 覆盖 |
|------|------|
| core/test/logging.test.ts | RunLog：ring 截断 / tail 顺序 / 订阅扇出与退订 / 文件落盘与按日文件名 / 过期清理 / 写失败静默；createRunFileLogger 追加写 |
| core/test/logs-api.test.ts | GET /api/logs 尾读与 limit 裁剪 / 未注入 runLog 404 / stream SSE 首帧 tail + 后续推送 |
| core/test/hub.test.ts 增补 | 注入伪造 RunLogSink，断言 send 全程产生 run_start / tool_result / run_done 日志行 |

## 9. 风险与遗留

- 用户输入会进日志文件（截断 200 字符）——PRD §4 已明示本地信任域内不做脱敏；
- `appendFileSync` 在极端高频工具调用下有同步 IO 开销——本地工具场景量级（单任务 < 100 条）可忽略；
- 日志查看页不做分页/持久查询（历史靠文件），后续有需求再补 `delta logs` 子命令。
