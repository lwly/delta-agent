/** F-22b：/api/cron 请求体 permission / valid_from / valid_until 校验。 */
export type CronFieldsResult =
  | { ok: false; error: string }
  | { ok: true; permission?: 'plan' | 'default' | 'yolo' | null; validFrom?: string | null; validUntil?: string | null };

export function parseCronPermissionAndValidity(body: Record<string, unknown>): CronFieldsResult {
  const permission = body.permission;
  if (permission !== undefined && permission !== null) {
    const mode = String(permission);
    if (mode !== 'plan' && mode !== 'default' && mode !== 'yolo') {
      return { ok: false, error: 'permission must be one of: plan / default / yolo' };
    }
  }
  const rawFrom = body.valid_from !== undefined ? body.valid_from : body.validFrom;
  const rawUntil = body.valid_until !== undefined ? body.valid_until : body.validUntil;
  for (const v of [rawFrom, rawUntil]) {
    if (v !== undefined && v !== null && (typeof v !== 'string' || Number.isNaN(Date.parse(v)))) {
      return { ok: false, error: 'valid_from / valid_until must be a valid ISO date' };
    }
  }
  if (rawFrom != null && rawUntil != null && Date.parse(rawFrom as string) > Date.parse(rawUntil as string)) {
    return { ok: false, error: 'valid_from must be <= valid_until' };
  }
  return {
    ok: true,
    ...(permission !== undefined
      ? { permission: permission === null ? null : (String(permission) as 'plan' | 'default' | 'yolo') }
      : {}),
    ...(rawFrom !== undefined ? { validFrom: rawFrom === null ? null : String(rawFrom) } : {}),
    ...(rawUntil !== undefined ? { validUntil: rawUntil === null ? null : String(rawUntil) } : {}),
  };
}
