/**
 * 桌面宿主（Electron）本地 server 鉴权 token 的前端承载。
 *
 * token 由 main 进程生成，BrowserWindow 以 `?auth=<token>` 加载首页；
 * 本模块读取后立即从地址栏清除（防误复制/进历史），并供给：
 *  - fetch 请求 → `x-delta-auth` 请求头（client.ts request()）
 *  - EventSource / 下载链接 → `?auth=` 查询参数（EventSource 无法自定义请求头）
 *
 * CLI `delta serve` 形态不带 ?auth=，token 恒为空 → 不附加任何凭据，行为不变。
 */

let token = '';

/** 应用启动时调用一次：从地址栏读取 auth 参数并清除 */
export function initAuthToken(): void {
  try {
    const q = new URLSearchParams(location.search).get('auth');
    if (!q) return;
    token = q;
    const u = new URL(location.href);
    u.searchParams.delete('auth');
    history.replaceState(null, '', u.toString());
  } catch {
    token = '';
  }
}

/** fetch 用：鉴权请求头（未配置 token 时空对象） */
export function authHeaders(): Record<string, string> {
  return token ? { 'x-delta-auth': token } : {};
}

/** EventSource / 下载链接用：鉴权查询串（未配置 token 时空串） */
export function authQuery(): string {
  return token ? `?auth=${encodeURIComponent(token)}` : '';
}
