/**
 * F-31 成本与用量报告 —— `yzero usage` 渲染逻辑。
 *
 * 用法：
 *   yzero usage                                # 全部时间、全部项目的文本报表
 *   yzero usage --range 7d --project <id|名>   # 时间范围 + 项目过滤
 *   yzero usage --json                         # 结构化输出（与 GET /api/usage/summary 同构，jq 可直接消费）
 */
import {
  SessionService,
  normalizeRange,
  usageReportToJson,
  type UsageProjectRow,
  type UsageModelRow,
  type UsageSessionRow,
} from '@y-zero/core';

export interface UsageCommandOptions {
  range?: string;
  project?: string;
  json?: boolean;
  db?: string;
}

/** 千分位整数（token 数展示） */
function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** 费用展示（小费用保留足够精度） */
function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/** 纯文本占比条（10 格） */
function shareBar(share: number): string {
  const filled = Math.max(share > 0 ? 1 : 0, Math.round(share * 10));
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${(share * 100).toFixed(1)}%`;
}

/** 单个分组表格（含占比条，按 cost 降序——查询层已排序） */
function renderGroup(
  title: string,
  rows: Array<{ label: string; input_tokens: number; output_tokens: number; cost_usd: number; turns: number }>,
): string[] {
  const lines: string[] = ['', title];
  if (rows.length === 0) {
    lines.push('  （无数据）');
    return lines;
  }
  const maxCost = Math.max(...rows.map((r) => r.cost_usd), 0);
  const nameWidth = Math.max(...rows.map((r) => r.label.length), 4);
  for (const r of rows) {
    const share = maxCost > 0 ? r.cost_usd / maxCost : 0;
    lines.push(
      `  ${r.label.padEnd(nameWidth)}  ${fmtCost(r.cost_usd).padStart(10)}  ${shareBar(share)}` +
        `  in ${fmtInt(r.input_tokens)} / out ${fmtInt(r.output_tokens)}  ${fmtInt(r.turns)} 轮`,
    );
  }
  return lines;
}

export async function usageCommand(opts: UsageCommandOptions): Promise<void> {
  const service = new SessionService(opts.db);
  try {
    const range = normalizeRange(opts.range);

    // --project 支持 id 与名称（Web 下拉持有 id；终端用户习惯用名称）
    let projectId: string | undefined;
    if (opts.project) {
      const projects = service.listProjects();
      const hit =
        projects.find((p) => p.id === opts.project) ??
        projects.find((p) => p.name === opts.project);
      if (!hit) {
        console.error(`✘ 未找到项目：${opts.project}（可用 yzero serve 的 /api/projects 或 Web 控制台查看项目列表）`);
        process.exitCode = 1;
        return;
      }
      projectId = hit.id;
    }

    const report = service.usage.summary({ range, projectId });

    if (opts.json) {
      // 与 GET /api/usage/summary 同构（同一 UsageStore + usageReportToJson 产出）
      console.log(JSON.stringify(usageReportToJson(report, projectId ?? null), null, 2));
      return;
    }

    const rangeLabel = { today: '今天', '7d': '近 7 天', '30d': '近 30 天', all: '全部时间' }[range];
    const projectLabel = projectId
      ? (service.getProject(projectId)?.name ?? projectId)
      : '全部项目';

    const t = report.totals;
    if (t.turns === 0) {
      console.log(`用量报告（${rangeLabel} · ${projectLabel}）：暂无用量数据`);
      console.log('（跑一次任务后这里会展示费用 / token / 轮次统计；历史数据自 v3 迁移起可按模型聚合）');
      return;
    }

    console.log(`用量报告（${rangeLabel} · ${projectLabel}）`);
    console.log(
      `总计：${fmtCost(t.cost_usd)} · in ${fmtInt(t.input_tokens)} / out ${fmtInt(t.output_tokens)} tokens · ${fmtInt(t.turns)} 轮 · ${fmtInt(t.sessions)} 会话`,
    );

    const projectRows: Array<{ label: string; input_tokens: number; output_tokens: number; cost_usd: number; turns: number }> =
      report.byProject.map((p: UsageProjectRow) => ({ label: p.project_name, ...p }));
    const modelRows: Array<{ label: string; input_tokens: number; output_tokens: number; cost_usd: number; turns: number }> =
      report.byModel.map((m: UsageModelRow) => ({ label: m.model, ...m }));

    const lines = [
      ...renderGroup('按项目', projectRows),
      ...renderGroup('按模型', modelRows),
    ];
    console.log(lines.join('\n'));

    // 会话明细（仅活跃会话，供快速定位高消耗会话）
    const sessions = service.usage.bySession({ range, projectId });
    if (sessions.length > 0) {
      const sessionLines: string[] = ['', '按会话（活跃会话 Top10，软删除会话费用已计入上方汇总）'];
      for (const s of sessions.slice(0, 10) as UsageSessionRow[]) {
        sessionLines.push(
          `  ${s.session_id.slice(0, 8)}  ${(s.title || '（未命名）').slice(0, 40).padEnd(40)}  ${fmtCost(s.cost_usd).padStart(10)}  ${fmtInt(s.turns)} 轮`,
        );
      }
      console.log(sessionLines.join('\n'));
    }
  } finally {
    service.close();
  }
}
