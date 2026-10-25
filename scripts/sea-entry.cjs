/**
 * SEA（Single Executable Application）引导入口
 *
 * 打包时整个运行时（dist + 生产依赖，含 better-sqlite3 的 arm64 原生 .node）
 * 被压成 runtime.zip 作为 SEA asset 嵌进二进制。本文件负责：
 *
 *   1. 取出 runtime.zip
 *   2. 解压到 ~/.delta/runtime/<内容指纹>/（按指纹缓存，幂等）
 *   3. 动态 import 真正的 CLI 入口，交棒给应用代码
 *
 * 为什么不在打包时直接 bundle 应用代码：
 *   ink / yoga-layout 含 top-level await，无法打成 CJS；better-sqlite3 是原生模块，
 *   esbuild 也带不走。改成「运行时整体释放」，模块相对路径、原生模块、ESM 全部保持原样，
 *   源码一行都不用改。
 *
 * 本文件必须是 CJS 且不能有顶层 await —— SEA 的 main 只支持 CJS。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const ASSET_NAME = 'runtime.zip';
const READY_MARKER = '.ready';

function fail(message) {
  process.stderr.write(`delta: ${message}\n`);
  process.exit(1);
}

// ── 最小 zip 解析（只依赖 node:zlib，不引入外部库） ──────────────────────
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** 从尾部向前找 End Of Central Directory，最多扫 64KB（zip 注释上限） */
function findEocd(buf) {
  const minPos = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 解压 zip 到 destDir。
 * 只支持 STORE(0) 与 DEFLATE(8) —— zip 命令默认产出的就是这两种。
 */
function unzipTo(buf, destDir) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('找不到 zip 中央目录（资源包损坏？）');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(ptr) !== CEN_SIG) throw new Error(`第 ${i} 个 zip 条目头损坏`);
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    ptr += 46 + nameLen + extraLen + commentLen;

    // 目录条目只需建目录
    if (name.endsWith('/')) {
      fs.mkdirSync(path.join(destDir, name), { recursive: true });
      continue;
    }

    // 防路径穿越：拒绝绝对路径与 .. 段
    const normalized = path.posix.normalize(name);
    if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`资源包含非法路径：${name}`);
    }

    if (buf.readUInt32LE(localOffset) !== LOC_SIG) {
      throw new Error(`条目 ${name} 的本地头损坏`);
    }
    const locNameLen = buf.readUInt16LE(localOffset + 26);
    const locExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + locNameLen + locExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let content;
    if (method === 0) content = raw;
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else throw new Error(`条目 ${name} 使用了不支持的压缩方式 ${method}`);

    const target = path.join(destDir, normalized);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

// ── 释放运行时 ─────────────────────────────────────────────────────────
function pickCacheRoot() {
  const home = path.join(os.homedir(), '.delta', 'runtime');
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.accessSync(home, fs.constants.W_OK);
    return home;
  } catch {
    // 家目录不可写（只读 HOME、受限容器等）时退到临时目录
    const tmp = path.join(os.tmpdir(), 'delta-runtime');
    fs.mkdirSync(tmp, { recursive: true });
    return tmp;
  }
}

/** 幂等释放：指纹相同且已有完成标记就直接复用 */
function ensureRuntime(zipBuf) {
  const fingerprint = crypto.createHash('sha256').update(zipBuf).digest('hex').slice(0, 16);
  const root = pickCacheRoot();
  const target = path.join(root, fingerprint);

  if (fs.existsSync(path.join(target, READY_MARKER))) return target;

  // 先解到临时目录再整体 rename：中断不会留下"看起来完整"的半成品
  const staging = `${target}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.mkdirSync(staging, { recursive: true });
    unzipTo(zipBuf, staging);
    fs.writeFileSync(path.join(staging, READY_MARKER), fingerprint, 'utf8');
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }

  // 顺手清掉旧版本运行时（只保留当前指纹），失败不影响使用
  try {
    for (const name of fs.readdirSync(root)) {
      if (name !== fingerprint && !name.startsWith('.')) {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
      }
    }
  } catch {
    /* 清理是尽力而为 */
  }

  return target;
}

// ── 启动 ───────────────────────────────────────────────────────────────
(async () => {
  // 自测分支：不依赖 SEA，直接验证 zip 解析与解压逻辑
  //   DELTA_SEA_SELFTEST=<zip 路径>:<输出目录> node build/sea-entry.cjs
  const selftest = process.env.DELTA_SEA_SELFTEST;
  if (selftest) {
    const idx = selftest.lastIndexOf(':');
    const zipPath = selftest.slice(0, idx);
    const outDir = selftest.slice(idx + 1);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    unzipTo(fs.readFileSync(zipPath), outDir);
    process.stdout.write(`selftest ok -> ${outDir}\n`);
    return;
  }

  const sea = require('node:sea');
  if (!sea.isSea()) {
    fail('这是打包后的引导入口，请通过 delta 可执行文件运行（开发时请直接用 node packages/cli/dist/index.js）');
  }

  // 注意：getAsset 的第二个参数是 TextDecoder 编码名（'utf8' 等），
  // 二进制资源必须不带编码调用，拿到的才是 ArrayBuffer。
  const asset = sea.getAsset(ASSET_NAME);
  const zipBuf = Buffer.from(asset);

  let runtimeDir;
  try {
    runtimeDir = ensureRuntime(zipBuf);
  } catch (e) {
    fail(`释放内置运行时失败：${e && e.message ? e.message : e}`);
  }

  const entry = path.join(runtimeDir, 'dist', 'index.js');
  if (!fs.existsSync(entry)) fail(`内置运行时缺少入口文件：${entry}`);

  await import(pathToFileURL(entry).href);
})().catch((e) => {
  process.stderr.write(`delta: 启动失败：${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
