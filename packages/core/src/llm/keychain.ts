import * as crypto from 'node:crypto';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── Key encryption (F-04a: 钥匙串加密存储) ────────────────────────────────
//
// Local obfuscation-grade encryption: AES-256-GCM with a machine-derived
// key (platform machine id via scrypt). Protects keys at rest from casual
// reads (backups, dotfile sync); not a defense against local malware.
//
// 机器标识演进：
// - v1 初版用 os.hostname() 派生 —— macOS 的 hostname 会随网络/VPN 漂移
//   （如 "笔记本" ↔ "电脑" 本机名切换），导致同机解密失败。
// - 现主方案改用稳定平台机器号（darwin: IOPlatformUUID / linux: machine-id /
//   win: MachineGuid）；解密时兼容回退旧 hostname 派生并透明升级重加密。

const ENC_PREFIX = 'enc:v1:';

let cachedStableSecret: string | undefined;
let cachedLegacySecrets: string[] | undefined;

/** 稳定平台机器号（跨重启/跨网络不变）。 */
function platformMachineId(): string {
  try {
    if (process.platform === 'darwin') {
      const out = childProcess.execSync('ioreg -rd1 -c IOPlatformExpertDevice', { timeout: 3000 }).toString();
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return m[1]!;
    } else if (process.platform === 'linux') {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const id = fs.readFileSync(f, 'utf8').trim();
          if (id) return id;
        } catch {
          /* try next */
        }
      }
    } else if (process.platform === 'win32') {
      const out = childProcess
        .execSync('reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', { timeout: 3000 })
        .toString();
      const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (m) return m[1]!;
    }
  } catch {
    /* fall through to hostname */
  }
  return '';
}

function legacyHostnameCandidates(): string[] {
  if (cachedLegacySecrets) return cachedLegacySecrets;
  const user = os.userInfo().username;
  const hosts = new Set<string>();
  hosts.add(os.hostname());
  try {
    if (process.platform === 'darwin') {
      for (const key of ['LocalHostName', 'ComputerName', 'HostName']) {
        try {
          hosts.add(childProcess.execSync(`scutil --get ${key}`, { timeout: 2000 }).toString().trim());
        } catch {
          /* key not set */
        }
      }
    }
  } catch {
    /* ignore */
  }
  // 变体：去 .local 后缀、空白转连字符（ComputerName 可能含空格）
  const variants = new Set<string>();
  for (const h of hosts) {
    if (!h) continue;
    variants.add(h);
    variants.add(h.replace(/\.local\.?$/i, ''));
    variants.add(h.replace(/\s+/g, '-'));
    variants.add(h.replace(/\s+/g, ''));
  }
  cachedLegacySecrets = [...variants]
    .filter(Boolean)
    .map((h) => `y-zero-agent:${h}:${user}`);
  return cachedLegacySecrets;
}

function stableSecret(): string {
  if (cachedStableSecret) return cachedStableSecret;
  const id = platformMachineId();
  cachedStableSecret = id
    ? `y-zero-agent:platform:${id}:${os.userInfo().username}`
    : `y-zero-agent:${os.hostname()}:${os.userInfo().username}`; // 无平台号环境退回旧行为
  return cachedStableSecret;
}

function deriveKey(salt: Buffer, secret: string): Buffer {
  return crypto.scryptSync(secret, salt, 32);
}

/** Encrypt a plaintext API key. Output: enc:v1:<salt>:<iv>:<tag>:<data> (b64). */
export function encryptKey(plain: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(salt, stableSecret()), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + [salt, iv, tag, data].map((b) => b.toString('base64')).join(':');
}

export type DecryptScheme = 'plaintext' | 'stable' | 'legacy-hostname' | 'none';

export interface DecryptResult {
  plain: string;
  scheme: DecryptScheme;
}

/**
 * Decrypt a stored key, trying the stable platform-id secret first and
 * falling back to legacy hostname-derived secrets (macOS hostname drift).
 */
export function decryptKeyDetailed(stored: string): DecryptResult {
  if (!stored.startsWith(ENC_PREFIX)) return { plain: stored, scheme: 'plaintext' };
  try {
    const [saltB64, ivB64, tagB64, dataB64] = stored.slice(ENC_PREFIX.length).split(':');
    if (!saltB64 || !ivB64 || !tagB64 || !dataB64) return { plain: '', scheme: 'none' };
    const salt = Buffer.from(saltB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const attempt = (secret: string): string | undefined => {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(salt, secret), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      } catch {
        return undefined;
      }
    };
    const stable = attempt(stableSecret());
    if (stable !== undefined) return { plain: stable, scheme: 'stable' };
    for (const legacy of legacyHostnameCandidates()) {
      const plain = attempt(legacy);
      if (plain !== undefined) return { plain, scheme: 'legacy-hostname' };
    }
    return { plain: '', scheme: 'none' };
  } catch {
    return { plain: '', scheme: 'none' }; // malformed payload
  }
}

/** Decrypt a stored key; returns plaintext or '' for malformed/foreign payloads. */
export function decryptKey(stored: string): string {
  return decryptKeyDetailed(stored).plain;
}

// ── Storage ───────────────────────────────────────────────────────────────

export interface StoredProvider {
  /** anthropic | openai | deepseek | qwen, or any id for openai-compatible gateways */
  id: string;
  /** which protocol family to speak */
  vendor: 'anthropic' | 'openai-compatible';
  /** encrypted API key */
  apiKey: string;
  baseUrl?: string;
  model?: string;
  enabled: boolean;
  /** at most one provider carries default:true */
  default?: boolean;
}

/** F-32 单条路由规则：某类辅助任务使用的目标模型（provider 缺省 = 会话主 Provider） */
export interface RoutingRule {
  /** 目标 provider id（须已在 providers 中配置且启用）；缺省跟随会话主 Provider */
  provider?: string;
  /** 目标模型 id（如 deepseek-chat、qwen-turbo 等小模型） */
  model: string;
}

/** F-32 路由配置：按任务类型（kind）分流到不同模型，规划/执行类任务不在此列（固定走主模型） */
export interface RoutingConfig {
  /** 总开关：关闭时全部调用走会话主模型 */
  enabled: boolean;
  /** 任务类型 → 路由规则；已知 kind 见 core/llm/router.ts KNOWN_TASK_KINDS，也允许自定义扩展 */
  rules: Record<string, RoutingRule>;
}

export interface ModelsFile {
  version: 1;
  providers: StoredProvider[];
  /** F-32 模型路由配置（可选；旧配置文件无此字段时视为未启用路由） */
  routing?: RoutingConfig;
}

export function modelsConfigPath(): string {
  return path.join(os.homedir(), '.y-zero', 'models.json');
}

export function loadModelsFile(file: string = modelsConfigPath()): ModelsFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ModelsFile;
    if (raw.version === 1 && Array.isArray(raw.providers)) {
      // F-32：routing 字段容忍手工编辑出错——形状非法时整体忽略（不阻断主流程）
      const r = raw.routing;
      if (
        r &&
        typeof r === 'object' &&
        typeof r.enabled === 'boolean' &&
        r.rules &&
        typeof r.rules === 'object' &&
        !Array.isArray(r.rules) &&
        Object.values(r.rules).every(
          (v) => v && typeof v === 'object' && typeof v.model === 'string' && v.model.trim() !== '',
        )
      ) {
        return raw;
      }
      return { version: 1, providers: raw.providers };
    }
  } catch {
    // missing/corrupt file → empty store (corrupt file is overwritten on next save)
  }
  return { version: 1, providers: [] };
}

export function saveModelsFile(data: ModelsFile, file: string = modelsConfigPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

/** Mask a key for display: sk-ant-abc...wxyz → sk-ant-…wxyz */
export function maskKey(stored: string): string {
  const plain = decryptKey(stored);
  if (!plain) return '（无法解密：可能来自其他机器）';
  if (plain.length <= 10) return `${plain.slice(0, 2)}****`;
  return `${plain.slice(0, 6)}…${plain.slice(-4)}`;
}
