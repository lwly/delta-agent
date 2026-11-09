import {
  checkLoginState,
  ensureExternalAdapters,
  findKnownAgent,
  KNOWN_AGENTS,
  ManualRegisterError,
  removeManualEntry,
  resolveAgentModels,
  resolveCommandPath,
  setExternalAgentModel,
  upsertManualEntry,
  type DetectedAgent,
} from '../../external/detect.js';
import type { RouteDef } from '../routes.js';
import type { BuiltinHttpRouteContext } from './types.js';

export function appendExternalAgentsBuiltinRoutes(routeTable: RouteDef[], ctx: BuiltinHttpRouteContext): void {
  const { opts, json, err } = ctx;

  routeTable.push(
    {
      method: 'GET',
      pattern: 'api/external-agents/templates',
      auth: 'token',
      permission: 'read',
      description: 'F-56 外部 Agent 模板网格',
      handler: async ({ res }) =>
        json(res, 200, {
          templates: KNOWN_AGENTS.map((d) => ({
            id: d.id,
            label: d.label,
            description: d.description,
            executable: d.executable,
            kind: d.kind,
            tier: d.tier,
            models: d.models ?? [],
          })),
        }),
    },
    {
      method: 'GET',
      pattern: 'api/external-agents/models',
      auth: 'token',
      permission: 'read',
      description: 'F-56 外部 Agent 模型清单探测',
      handler: async ({ res, url }) => {
        const templateId = url.searchParams.get('templateId') ?? '';
        const def = findKnownAgent(templateId);
        if (!def) return err(res, 400, `unknown_template: ${templateId}`);
        const command = resolveCommandPath((url.searchParams.get('command') ?? def.executable).trim());
        try {
          const result = await (opts.externalModelsProbe ?? resolveAgentModels)(def, command);
          return json(res, 200, result);
        } catch {
          return json(res, 200, { models: def.models ?? [], source: 'static' });
        }
      },
    },
    {
      method: 'GET',
      pattern: 'api/external-agents',
      auth: 'token',
      permission: 'read',
      description: 'F-55 外部 Agent 探测列表',
      handler: async ({ res }) => {
        let detected: DetectedAgent[] = [];
        try {
          detected = await (opts.externalDetect ?? ensureExternalAdapters)();
        } catch {
          detected = [];
        }
        return json(res, 200, {
          agents: detected.map((d) => ({
            id: d.def.id,
            command: d.command,
            version: d.version,
            source: d.source,
            tier: d.def.tier,
            kind: d.def.kind,
            loginState: checkLoginState(d.def),
            planSupported: d.def.permissionArgs.plan.length > 0,
            yoloSupported: d.def.permissionArgs.yolo.length > 0,
            manual: d.manual === true,
            displayName: d.displayName,
            description: d.description,
            model: d.model,
            label: d.def.label,
          })),
        });
      },
    },
    {
      method: 'POST',
      pattern: 'api/external-agents',
      auth: 'token',
      permission: 'write',
      description: 'F-56 手动注册外部 Agent',
      handler: async ({ res, readBody }) => {
        const body = await readBody();
        try {
          const entry = (opts.externalRegister ?? upsertManualEntry)({
            templateId: String(body?.templateId ?? ''),
            command: body?.command === undefined ? undefined : String(body.command),
            displayName: body?.displayName === undefined ? undefined : String(body.displayName),
            description: body?.description === undefined ? undefined : String(body.description),
            model: body?.model === undefined ? undefined : String(body.model),
          });
          return json(res, 200, { ok: true, entry });
        } catch (e) {
          if (e instanceof ManualRegisterError) return err(res, 400, `${e.code}: ${e.message}`);
          return err(res, 400, (e as Error).message);
        }
      },
    },
    {
      method: 'DELETE',
      pattern: 'api/external-agents/:id',
      auth: 'token',
      permission: 'write',
      description: 'F-56 移除手动条目',
      handler: async ({ res, params }) => {
        const removed = (opts.externalRemove ?? removeManualEntry)(decodeURIComponent(params.id!));
        return json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'no such manual entry' });
      },
    },
    {
      method: 'PATCH',
      pattern: 'api/external-agents/:id/model',
      auth: 'token',
      permission: 'write',
      description: 'F-56 修改外部 Agent 模型',
      handler: async ({ res, readBody, params }) => {
        const body = await readBody();
        try {
          const entry = (opts.externalSetModel ?? setExternalAgentModel)(
            decodeURIComponent(params.id!),
            String(body?.model ?? ''),
          );
          if (entry === null) return err(res, 404, `no such agent entry: ${decodeURIComponent(params.id!)}`);
          return json(res, 200, { ok: true, entry });
        } catch (e) {
          if (e instanceof ManualRegisterError) return err(res, 400, `${e.code}: ${e.message}`);
          return err(res, 400, (e as Error).message);
        }
      },
    },
  );
}
