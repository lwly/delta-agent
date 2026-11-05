// F-56 Tier D 预留档 stub 适配器：模板可注册/可探测，但协议适配器未实现。
// run() 走正常 ExternalEvent 流发出 fatal 错误（AC-56-4：明确报错不静默），
// 映射引擎（engine/external.ts）无需任何分支改动即把错误呈现给用户。
import type { ExternalAgentAdapter, ExternalAgentSpec, ExternalEvent } from './types.js';

export class ReservedExternalAdapter implements ExternalAgentAdapter {
  readonly spec: ExternalAgentSpec;

  constructor(spec: ExternalAgentSpec) {
    this.spec = spec;
  }

  async *run(): AsyncIterable<ExternalEvent> {
    yield {
      type: 'error',
      fatal: true,
      message: `external_unsupported_protocol: ${this.spec.id}（kind=reserved）暂无协议适配器——该 CLI 已可注册与探测，执行能力待后续版本落地`,
    };
    yield { type: 'done', exitCode: 1 };
  }
}
