/**
 * F-51 `delta doctor` 单测（AC-51-2）。
 *
 * 覆盖：检查项状态判定（ok/warn/fail/info）、「下一步」指令携带、退出码聚合。
 * homeDir/dbPath 全部注入临时目录，不碰真实 ~/.delta；网络检查不进单测
 * （依赖外部网络，由 e2e 的 DELTA_FAKE_PROVIDER 场景覆盖）。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { encryptKey, LATEST_SCHEMA_VERSION } from '@delta/core';
import {
  collectDoctorChecks,
  doctorExitCode,
  MIN_NODE_VERSION,
  type DoctorCheckResult,
} from '../src/doctor.js';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'delta-doctor-test-'));
const home = path.join(tmpRoot, 'home');
mkdirSync(home);

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const modelsFileFor = (h: string) => path.join(h, '.delta', 'models.json');

function writeModels(h: string, apiKey: string | undefined): void {
  mkdirSync(path.dirname(modelsFileFor(h)), { recursive: true });
  writeFileSync(
    modelsFileFor(h),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: 'deepseek',
          vendor: 'openai-compatible',
          ...(apiKey ? { apiKey } : {}),
          enabled: true,
        },
      ],
    }),
  );
}

describe('doctorExitCode 聚合', () => {
  const mk = (status: DoctorCheckResult['status']): DoctorCheckResult => ({
    id: 'x',
    label: 'x',
    status,
    detail: '',
  });

  it('无 fail → 0（warn / info / ok 都放行）', () => {
    expect(doctorExitCode([mk('ok'), mk('warn'), mk('info')])).toBe(0);
    expect(doctorExitCode([])).toBe(0);
  });

  it('任一 fail → 1', () => {
    expect(doctorExitCode([mk('ok'), mk('fail')])).toBe(1);
  });
});

describe('collectDoctorChecks（offline 注入 home）', () => {
  it('空 home：版本/Node/系统/配置目录全 ok 或 info，无 fail', async () => {
    const results = await collectDoctorChecks({ homeDir: home, offline: true });
    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get('node')!.status).toBe('ok'); // 测试运行时 Node >= 20
    expect(byId.get('node')!.detail).toContain(process.versions.node);
    expect(byId.get('os')!.status).toBe('ok');
    // 配置目录不存在 → info（首次运行自动创建），不是 fail
    expect(byId.get('config-dir')!.status).toBe('info');
    expect(byId.get('models')!.status).toBe('info');
    expect(byId.get('db')!.status).toBe('info');
    // offline：不出现 provider 项
    expect(byId.has('provider')).toBe(false);
    expect(doctorExitCode(results)).toBe(0);
  });

  it('配置目录可写 → ok', async () => {
    const h = path.join(tmpRoot, 'home-writable');
    mkdirSync(path.join(h, '.delta'), { recursive: true });
    const results = await collectDoctorChecks({ homeDir: h, offline: true });
    expect(results.find((r) => r.id === 'config-dir')).toMatchObject({ status: 'ok' });
  });

  it('Provider 配置 Key 可解密 → ok；换机 Key（伪造密文）→ warn 带 next', async () => {
    const hOk = path.join(tmpRoot, 'home-key-ok');
    writeModels(hOk, encryptKey('sk-test'));
    const rOk = await collectDoctorChecks({ homeDir: hOk, offline: true });
    expect(rOk.find((r) => r.id === 'models')).toMatchObject({ status: 'ok' });

    const hBad = path.join(tmpRoot, 'home-key-bad');
    writeModels(hBad, 'enc:v1:AAAA:BBBB:CCCC:DDDD'); // 机器号失配时解不出明文
    const rBad = await collectDoctorChecks({ homeDir: hBad, offline: true });
    const models = rBad.find((r) => r.id === 'models')!;
    expect(models.status).toBe('warn');
    expect(models.next).toContain('delta models add');
  });

  it('会话库：新建库 quick_check ok 且 schema 版本对齐 → ok', async () => {
    const h = path.join(tmpRoot, 'home-db');
    const dbPath = path.join(h, '.delta', 'agent.db');
    mkdirSync(path.dirname(dbPath), { recursive: true });
    // 先真实初始化一次库（存在 + 最新 schema），再体检
    const { SessionStore } = await import('@delta/core');
    new SessionStore(dbPath).close();
    const results = await collectDoctorChecks({ homeDir: h, dbPath, offline: true });
    const db = results.find((r) => r.id === 'db')!;
    expect(db.status).toBe('ok');
    expect(db.detail).toContain(`v${LATEST_SCHEMA_VERSION}`);
  });

  it('会话库文件损坏 → fail 带「下一步」', async () => {
    const h = path.join(tmpRoot, 'home-db-broken');
    const dbPath = path.join(h, '.delta', 'agent.db');
    mkdirSync(path.dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, 'not a sqlite file at all');
    const results = await collectDoctorChecks({ homeDir: h, dbPath, offline: true });
    const db = results.find((r) => r.id === 'db')!;
    expect(db.status).toBe('fail');
    expect(db.next).toBeTruthy();
    expect(doctorExitCode(results)).toBe(1);
  });
});

describe('MIN_NODE_VERSION', () => {
  it('与 README/根 package.json 的环境要求一致（>= 20）', () => {
    expect(MIN_NODE_VERSION).toBe('20.0.0');
  });
});
