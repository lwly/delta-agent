/**
 * 会话模型下拉的选中值解析（纯函数，可直测）
 *
 * 规则：当前会话模型 > 已记录的模型偏好 > 列表第一项；都为空返回 ''（后端回退默认模型）
 */

/** 解析下拉应选中的模型值；preferred 失效（不在选项中）时回退第一项而非显示空白 */
export function resolveSelectedModel(
  sessionModel: string | undefined,
  preferred: string,
  optionValues: string[],
): string {
  if (sessionModel) return sessionModel;
  if (preferred && optionValues.includes(preferred)) return preferred;
  return optionValues[0] ?? '';
}
