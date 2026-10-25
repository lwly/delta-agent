# F-22 定时任务/自动化 —— 设计与实现说明

> 状态：✅ 2026-10-23 交付（core 内核 + CLI 子命令组 + Web 调度面板；36 + 6 例单测全绿）

## 1. 目标与范围

Agent 任务的 cron 调度：按 5 字段 cron 表达式（本地时区）定期以 **headless 非交互语义**
自动运行一条 agent 任务，运行记录可查、可启停、可手动补跑。

**本期范围**：core 调度内核 + `delta cron` CLI 子命令组 + 常驻 daemon + Web 调度面板
（`delta serve` 内 `/api/cron` 端点 + 工作台「⏰ 定时」弹窗，与 CLI 共用同一 `cron.json` 存储）。
**不在本期**：分布式/多机调度。

## 2. 总体结构

```
~/.delta/cron.json ──┐
                      ├─ core/cron/parse.ts      5 字段表达式解析 + nextRun（纯函数，零依赖）
                      ├─ core/cron/store.ts      任务清单 CRUD / 原子写 / 坏 JSON 降级
                      ├─ core/cron/runner.ts     到期扫描 + 执行编排（执行器注入）
                      ├─ core/cron/scheduler.ts  常驻 tick 循环（busy 保护 / signal 停止）
cli/cron-executor.ts ─┘ 默认执行器：spawn `delta run -p <prompt> --json` 子进程
cli/cron.ts            delta cron 子命令组
```

关键决策：**执行采用子进程隔离**（而非进程内复用 headless 内核）。每次运行都是全新的
`delta run` 进程——MCP / hooks / 权限 / 预算按该项目配置完整重新装配，崩溃不波及
daemon，且天然复用 F-29 的退出码协议与 JSON 报告。core 的 runner 只依赖注入的
`CronExecutor` 接口，不感知进程细节，测试用伪造执行器。

## 3. 数据模型（~/.delta/cron.json）

```jsonc
{
  "version": 1,
  "jobs": [
    {
      "id": "cron-xxx",
      "name": "每日整理",          // 唯一，CLI 引用入口
      "cron": "30 8 * * *",        // 5 字段或 @hourly/@daily/@weekly/@monthly/@yearly
      "prompt": "整理昨日会话成日报",
      "cwd": "/path/to/project",   // 运行目录（决定项目上下文）
      "enabled": true,
      "maxCostUsd": 0.5,           // 可选，透传 delta run --max-cost
      "nextRunAt": "ISO",          // 下次到期；缺失视为到期待补算
      "runningSince": "ISO",       // 运行锁：执行前写、完成清；残留 >24h 视为崩溃自动解除
      "lastRun": { "...": "最近一次运行记录" },
      "runs": [ "...最多 20 条，旧→新" ]
    }
  ]
}
```

运行记录（CronRunRecord）：trigger（schedule/manual）/ 起止时间 / durationMs /
status（completed|failed|max_turns|budget_exhausted|aborted|timeout|error）/
exitCode / sessionId / costUsd / turns / error / resultPreview（截 500 字）。

## 4. 表达式与到期计算（parse.ts）

- 字段：`分 时 日 月 周`；支持 `*`、单值、`a-b`、`a,b`、`/step` 及其组合；
  周字段 0 与 7 都是周日；`dom` 与 `dow` 同时受限取 **OR**（POSIX 惯例）；
- `nextRun(expr, from)` 纯函数：严格晚于 from，逐级跳转（月不命中→下月 1 日 00:00，
  日不命中→次日 00:00，时不命中→下个整点，分不命中→下分钟）；搜索上限 4 年返回 null；
- 非法表达式 `parseCron` 抛错（message 含字段名，CLI 直接展示）；表按 cron 语义 1 基
  建表（月 1–12 / 日 1–31），查询时与 Date 0 基 getter 对齐。

## 5. 执行语义（runner.ts / scheduler.ts）

- 到期判定：`enabled && !runningSince && (nextRunAt 缺失 || nextRunAt <= now)`；
- 串行执行：同一 tick 内逐个跑，避免并发任务争抢预算/模型；
- 运行锁：`runningSince` 写入即落盘（daemon 与手动补跑跨进程互斥）；残留超 24h
  （STALE_RUNNING_MS）视为上次进程崩溃，自动解除后照常执行；
- 失败隔离：单任务执行失败收敛为 error 记录，不中断其余任务；坏表达式任务
  记录失败但不改 enabled（调度推进容错为 undefined，不反复失败）；
- 补跑语义：daemon 停机期间到期的任务，重启后首轮即补跑一次（不会按错过时刻数连跑）；
- `onlyJobId`（`cron run --id`）：强制执行一次、trigger=manual、**不推进 nextRunAt**；
- scheduler：启动即跑首轮；busy 保护（上轮未完跳过本轮）；interval unref，
  进程存活由 CLI daemon 的信号监听保持；stop()/signal abort 优雅停止。

## 6. CLI

| 命令 | 说明 |
|------|------|
| `delta cron list [--json]` | 清单：表达式 / 下次运行 / 上次结果摘要 |
| `delta cron add --name N --cron E --prompt P [--dir D] [--max-cost C] [--disable]` | 新增（name 唯一、表达式与目录即时校验、预计算 nextRunAt） |
| `delta cron remove <id-or-name>` | 删除 |
| `delta cron enable/disable <id-or-name>` | 启停（enable 从当下重算下次运行，不补跑停用期） |
| `delta cron run [--id]` | 手动补跑；`--id` 强制试跑一次 |
| `delta cron daemon [--tick-ms 30000] [--once]` | 常驻调度；`--once` 单轮补跑后退出（配合系统 cron / systemd timer） |

执行器超时默认 30 分钟（SIGTERM），超时记 `timeout`；子进程输出无法解析为 JSON
报告时收敛为 `error` 并携带输出前 500 字。

## 6.1 Web 调度面板（F-22 增量）

**端点**（`core/server/http.ts`，serve 进程内直读 `~/.delta/cron.json`；`ServeOptions`
新增 `cronExecutor`（CLI serve 传 spawn 执行器）与 `cronHomeDir`（测试隔离））：

| 端点 | 说明 |
|------|------|
| `GET /api/cron` | 全量清单 + 配置 warnings（snake_case 传输，`cronJobToJson` 口径） |
| `GET /api/cron/:id` | 单任务（运行中轮询用） |
| `POST /api/cron` | 新增（name/cron/prompt 必填；cwd 缺省 serve 启动目录） |
| `PATCH /api/cron/:id` | 编辑（enabled / cron / prompt / cwd / name / maxCostUsd） |
| `DELETE /api/cron/:id` | 删除 |
| `POST /api/cron/:id/run` | 立即运行一次：202 后台执行（trigger=manual、不推进 nextRunAt、runningSince 锁防重复）；未配执行器 400、运行中 409 |

**前端**（`web/src/components/CronModal.vue`，工作台「⏰ 定时」入口，沿用 UsageModal 弹窗惯例）：
任务卡列表（状态点/表达式/下次运行/上次结果摘要）+ 新增表单 + 启停/删除（二次确认）/
立即运行；「立即运行」提交后每 2s 轮询单任务端点，`running_since` 清除后自动展开
运行历史；warnings 降级为顶部提示不阻塞面板。

## 7. 安全与口径

- 写路径全部 tmp+rename 原子写；既有文件坏 JSON 时**拒绝写入**（宁可不落盘也不覆盖）；
- 读路径永不 throw：坏 JSON / 非法条目降级 warning + 跳过；
- headless 非交互语义原样继承：高危确认自动拒绝（写任务用任务级 `--max-cost` +
  项目 `.delta` 权限配置；如需放行在项目级配置 yolo，与交互运行同等审慎）；
- 用量与费用按会话正常落库，`costUsd` 进入运行记录与 `delta usage` 口径；
- F-33 桌面通知不接入 cron 子进程（子进程无确认卡；如需完成通知可在项目级
  hooks.json 用 Stop 钩子实现）。

## 8. 测试与验收

- `packages/core/test/cron-parse.test.ts`：别名 / 值域 / 步进 / 区间列表 / dom+dow OR /
  逐级跳转（跨日跨年跨月）/ 非法表达式 / 4 年上限 / 纯函数语义（15 例）；
- `cron-store.test.ts`：CRUD / name 唯一 / nextRunAt 预计算与重算 / 坏 JSON 拒写降级 /
  非法条目跳过 / 历史 20 条滚动 / 原子写无残留（9 例）；
- `cron-runner.test.ts`：到期执行与推进 / 禁用跳过 / 运行锁与崩溃残留清理 /
  失败不中断 / 执行器抛错兜底 / onlyJobId 不推进 / 坏 JSON 安全返回 / 缺 nextRunAt 补跑 /
  scheduler 循环与 stop / signal 停止（12 例）；
- `cron-server.test.ts`：/api/cron 清单/新增校验/编辑/删除/404/立即运行（202 + 轮询 last_run +
  手动语义不推进 nextRunAt）/ 未配执行器 400 / cronHomeDir 隔离（6 例）；
- 端到端冒烟：隔离 HOME 下 add/list/run --id（无 Provider 正确收敛 error）/ disable /
  remove / daemon --once 全链路通过；`delta serve` 冒烟：/api/cron GET / POST（snake_case
  返回 + cwd 缺省 serve 目录）/ run 404 全通。
