/**
 * F-39 专家 / 专家团 —— 包协议与运行时类型（design-f39-experts.md §4.1）
 *
 * 三层专家库（builtin < user < project）中的每个包 = 一个目录：
 *   expert.json + agents/*.md + 可选 avatars/ + README.md
 */

export type ExpertLayer = 'builtin' | 'user' | 'project';

export type ExpertType = 'agent' | 'team';

/** 中英双语展示文本（zh 缺失时回退 en，见 displayOf） */
export interface LocalizedText {
  en: string;
  zh: string;
}

/** expert.json 的作者字段形状（宽容解析：未知字段丢弃） */
export interface ExpertPackage {
  name: string;
  version: string;
  description: string;
  author: { name: string; email?: string };
  expertType: ExpertType;
  /** 单人专家：唯一 agent id；团队：主理人 id */
  agentName: string;
  /** md 相对路径清单，如 ["agents/code-architect.md"] */
  agents: string[];
  displayName: LocalizedText;
  profession: LocalizedText;
  avatar?: string;
  skills?: string[];
  /** 工具白名单（只减不增）；缺省 = 不收窄 */
  tools?: string[];
  keywords?: string[];
  categoryId?: string;
  members?: Array<{
    id: string;
    name: LocalizedText;
    profession: LocalizedText;
    avatar?: string;
    role: 'lead' | 'member';
  }>;
  teamInfo?: { leadAgent: string; memberAgents: string[] };
  dependencies?: { mcpServers?: string[] };
}

/** 单个 agent md 的解析结果（frontmatter + 正文） */
export interface ExpertAgent {
  /** = md 文件名（不含扩展名），必须等于 frontmatter.name，且满足 ID_PATTERN */
  id: string;
  description: string;
  displayName: LocalizedText;
  profession: LocalizedText;
  /** 正文（已剥离 frontmatter，未截断未转义；截断发生在 prepareExpertSegment） */
  body: string;
  maxTurns?: number;
  skills: string[];
  /** 成员级工具白名单（仅团队成员使用；空数组 = 沿用父视图） */
  tools: string[];
}

/** 成员运行时视图（含正文，供委派用；正文绝不进主会话） */
export interface ExpertMember extends ExpertAgent {
  role: 'lead' | 'member';
  avatarPath: string | null;
}

/** 发现结果（运行时记录） */
export interface ExpertRecord {
  name: string;
  version: string;
  description: string;
  author: { name: string; email?: string };
  expertType: ExpertType;
  displayName: LocalizedText;
  profession: LocalizedText;
  /** 三层覆盖后的胜出层（对齐 SkillMeta.layer） */
  layer: ExpertLayer;
  /** 包目录绝对路径（仅「打开目录」与日志用，UI 不展示给用户） */
  dir: string;
  /** 头像绝对路径；缺失/超限/超体积 → null */
  avatarPath: string | null;
  skills: string[];
  /** null = 不收窄 */
  tools: string[] | null;
  keywords: string[];
  categoryId: string | null;
  dependencies: { mcpServers: string[] };
  /** 主 agent：单人专家 = 唯一 agent；团队 = 主理人 */
  agent: ExpertAgent;
  /** 团队成员（expertType==='agent' 时恒为空数组；不含 lead） */
  members: ExpertMember[];
  /** 正文规模（详情页「提示词 N 行 / 已截断」与 debug 用；解析期算一次） */
  promptStats: { chars: number; tokens: number; truncated: boolean };
}

export interface ExpertDiscoverResult {
  experts: ExpertRecord[];
  /** "user/my-expert: 缺少 agents 字段" 形态，对齐 discoverSkills.errors */
  errors: string[];
}

/**
 * 列表 DTO（`GET /api/experts` 的单项；不含 body/avatar 内容，见 D13）。
 * Web 侧 ExpertPanel 的 `@select` 传的就是它 —— 需要 expertType 才能决定文案与 mode。
 */
export interface ExpertListItem {
  name: string;
  displayName: LocalizedText;
  profession: LocalizedText;
  expertType: ExpertType;
  layer: ExpertLayer;
  description: string;
  keywords: string[];
  categoryId: string | null;
  /** 团队成员数（expertType==='agent' 时为 0） */
  memberCount: number;
  /** 声明了但当前未启用的 MCP 依赖（面板「⚠ 缺 MCP 依赖」数据源；仍可召唤） */
  missingMcp: string[];
  /** 是否已有头像（前端据此决定是否拉 `/avatar`；不内联内容） */
  hasAvatar: boolean;
}

/** 单层原始视图（设置页分组 / `expert list --verbose` 显示被覆盖项） */
export interface ExpertLayers {
  byLayer: Record<ExpertLayer, ExpertRecord[]>;
  errors: string[];
}

/** agent / 成员 id 字符集：会进入 `[expert:<id>]` 标记与 task 的 agent 参数，必须可无歧义解析 */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/** 包名（= 目录名）字符集 */
export const EXPERT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

/** 团队成员上限（包协议校验期拒绝） */
export const MAX_TEAM_MEMBERS = 6;

/** 专家段正文上限（字符） */
export const EXPERT_BODY_MAX_CHARS = 6000;

/** 展示文本取值：zh 优先，回退 en */
export function displayOf(text: LocalizedText | undefined): string {
  if (!text) return '';
  return text.zh || text.en || '';
}
