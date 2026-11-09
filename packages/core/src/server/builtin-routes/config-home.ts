import * as os from 'node:os';
import type { SessionService } from '../../session/service.js';
import type { BuiltinHttpRouteOptions } from './types.js';

/** 配置读写根：configHomeDir 优先（测试隔离），回落 skillsHomeDir，再缺省主目录 */
export function resolveConfigHome(opts: BuiltinHttpRouteOptions): string {
  return opts.configHomeDir ?? opts.skillsHomeDir ?? os.homedir();
}

export function projectRoot(service: SessionService, projectId: string | null | undefined): string | undefined {
  return projectId ? service.getProject(projectId)?.root_path : undefined;
}
