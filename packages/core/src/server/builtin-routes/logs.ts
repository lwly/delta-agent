import type { LogEntry } from '../../logging/logger.js';
import type { RouteDef } from '../routes.js';
import { logEntryInProject } from '../log-project-filter.js';
import type { BuiltinHttpRouteContext } from './types.js';

export function appendLogsBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { opts, service, json, err } = ctx;

  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/logs',
      auth: 'token',
      permission: 'read',
      description: 'F-41 运行日志尾读（runLog 未装配 404）',
      handler: async ({ res, url }) => {
        if (!opts.runLog) return err(res, 404, 'run log not configured');
        const limit = Number(url.searchParams.get('limit'));
        const projectIdFilter = url.searchParams.get('project_id');
        let items = opts.runLog.tail(Number.isFinite(limit) && limit > 0 ? limit : 200);
        if (projectIdFilter) {
          items = items.filter((e) => logEntryInProject(e, projectIdFilter, service));
        }
        return json(res, 200, { items });
      },
    },
    {
      method: 'GET',
      pattern: 'api/logs/stream',
      auth: 'token',
      permission: 'read',
      description: 'F-41 运行日志 SSE（?project_id= 过滤）',
      handler: async ({ req, res, url }) => {
        if (!opts.runLog) return err(res, 404, 'run log not configured');
        const runLog = opts.runLog;
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const streamProjectFilter = url.searchParams.get('project_id');
        const matchFilter = (e: LogEntry): boolean =>
          streamProjectFilter ? logEntryInProject(e, streamProjectFilter, service) : true;
        for (const e of runLog.tail(200)) {
          if (matchFilter(e)) res.write(`data: ${JSON.stringify(e)}\n\n`);
        }
        const unsub = runLog.subscribe((e) => {
          if (matchFilter(e)) res.write(`data: ${JSON.stringify(e)}\n\n`);
        });
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => {
          clearInterval(ping);
          unsub();
        });
      },
    },
  );
}
