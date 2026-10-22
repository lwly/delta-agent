import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── Key encryption (F-04a: 钥匙串加密存储) ────────────────────────────────
//
// Local obfuscation-grade encryption: AES-256-GCM with a machine-derived
// key (hostname + username via scrypt). Protects keys at rest from casual
// reads (backups, dotfile sync); not a defense against local malware.

const ENC_PREFIX = 'enc:v1:';

function machineSecret(): string {
  return `y-zero-agent:${os.hostname()}:${os.userInfo().username}`;
}

function deriveKey(salt: Buffer): Buffer {
  return crypto.scryptSync(machineSecret(), salt, 32);
}

/** Encrypt a plaintext API key. Output: enc:v1:<salt>:<iv>:<tag>:<data> (b64). */
export function encryptKey(plain: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(salt), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + [salt, iv, tag, data].map((b) => b.toString('base64')).join(':');
}

/** Decrypt a stored key; returns plaintext or '' for malformed payloads. */
export function decryptKey(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored; // legacy plaintext (not written by us)
  try {
    const [salt, iv, tag, data] = stored.slice(ENC_PREFIX.length).split(':').map((s) => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(salt), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return ''; // wrong machine / tampered payload
  }
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

export interface ModelsFile {
  version: 1;
  providers: StoredProvider[];
}

export function modelsConfigPath(): string {
  return path.join(os.homedir(), '.y-zero', 'models.json');
}

export function loadModelsFile(file: string = modelsConfigPath()): ModelsFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ModelsFile;
    if (raw.version === 1 && Array.isArray(raw.providers)) return raw;
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
