/**
 * F-50 自动更新 —— 版本比较（AC-50-5 降级拒绝的基础）。
 *
 * 只支持本仓库实际使用的版本口径：`主.次.补丁`（可带 `v` 前缀与 `-预发布` 后缀）。
 * 比较规则：逐段数值比较；段数不足补 0；带预发布后缀 < 同版本号正式版（semver 口径）。
 * 解析失败返回 null，调用方按「无法比较 → 不更新」处理，绝不盲替。
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** 预发布后缀（如 `beta.1`）；正式版为 undefined */
  prerelease?: string;
}

/** 解析 `v1.2.3` / `1.2.3-beta.1`；非法输入返回 null。 */
export function parseVersion(raw: string): ParsedVersion | null {
  const text = String(raw ?? '').trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!m) return null;
  const parsed: ParsedVersion = {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
  if (m[4]) parsed.prerelease = m[4];
  return parsed;
}

/** 比较两个版本号：a>b 返回 1，a<b 返回 -1，相等（含预发布完全一致）返回 0；任一非法返回 null。 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (const [x, y] of [
    [pa.major, pb.major],
    [pa.minor, pb.minor],
    [pa.patch, pb.patch],
  ] as const) {
    if (x !== y) return x > y ? 1 : -1;
  }
  // 正式版 > 预发布（1.2.3 > 1.2.3-beta.1）；两个预发布按字典序
  if (!pa.prerelease && !pb.prerelease) return 0;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (!pa.prerelease && pb.prerelease) return 1;
  const aa = pa.prerelease!.split('.');
  const bb = pb.prerelease!.split('.');
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const x = aa[i];
    const y = bb[i];
    if (x === undefined) return -1; // 前缀相同者较短的小
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    // 纯数字段按数值比较（semver 口径），否则按字典序
    if (!Number.isNaN(nx) && !Number.isNaN(ny) && /^\d+$/.test(x) && /^\d+$/.test(y)) {
      if (nx !== ny) return nx > ny ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/**
 * 升级判定（AC-50-5 降级拒绝）：仅当 latest 严格大于 current 时返回 true。
 * 任一版本无法解析 / 相等 / latest 更旧，一律 false —— 更新通道绝不降级。
 */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) === 1;
}
