import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';

export function appendSessionStreamBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { hub } = ctx;
  routeTable.push({
    method: 'GET',
    pattern: 'api/sessions/:id/events',
    auth: 'token',
    permission: 'read',
    description: 'SSE HubEvent 推送',
    handler: async ({ req, res, params }) => {
      const sessionId = params.id!;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'state', running: hub.isRunning(sessionId), paused: hub.isPaused(sessionId) })}\n\n`);
      const unsub = hub.subscribe(sessionId, (ev) => {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      });
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => {
        clearInterval(ping);
        unsub();
      });
    },
  });
}
