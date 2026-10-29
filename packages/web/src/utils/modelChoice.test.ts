import { describe, expect, it } from 'vitest';
import { resolveSelectedModel } from './modelChoice';

describe('resolveSelectedModel', () => {
  const opts = ['deepseek-chat', 'qwen-max', ''];

  it('当前会话模型优先', () => {
    expect(resolveSelectedModel('qwen-max', 'deepseek-chat', opts)).toBe('qwen-max');
    // 会话模型不在选项中也保持原值（下拉由调用方 unshift 兜底展示）
    expect(resolveSelectedModel('legacy-model', 'deepseek-chat', opts)).toBe('legacy-model');
  });

  it('未选模型时默认选列表第一项', () => {
    expect(resolveSelectedModel(undefined, '', opts)).toBe('deepseek-chat');
  });

  it('已记录偏好仍有效时选偏好', () => {
    expect(resolveSelectedModel(undefined, 'qwen-max', opts)).toBe('qwen-max');
  });

  it('偏好已失效（如 Provider 被移除）回退第一项而非空白', () => {
    expect(resolveSelectedModel(undefined, 'removed-model', opts)).toBe('deepseek-chat');
  });

  it('选项为空返回空串（由后端回退默认模型）', () => {
    expect(resolveSelectedModel(undefined, '', [])).toBe('');
  });
});
