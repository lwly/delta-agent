/**
 * F-50 自动更新 —— SEA 渠道「下载 + 替换」（AC-50-2 手动通道，不做热替换）。
 *
 * npm 渠道由 CLI 直接走 `npm i -g`，不经本模块。SEA 替换流程：
 *  1. release 资产流式下载到暂存目录（`~/.delta/update-staging/`），落盘临时名；
 *  2. chmod +x 后原子换入当前二进制：旧文件改名 .bak 备份，新文件改名到位；
 *  3. 任一步失败回滚备份，旧二进制原样可用（更新失败绝不能弄坏现有安装）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FetchLike } from './checker.js';

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // 二进制可能几十 MB：放宽到 10 分钟

export interface DownloadUpdateAssetResult {
  /** 下载完成的文件路径（已 chmod 755） */
  file: string;
  bytes: number;
}

/** 流式下载 release 资产到 destDir（目录不存在则创建），失败时清理半截文件并抛错。 */
export async function downloadUpdateAsset(
  url: string,
  destDir: string,
  opts: { fetcher?: FetchLike } = {},
): Promise<DownloadUpdateAssetResult> {
  const fetcher = opts.fetcher ?? fetch;
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, `delta-new-${process.pid}`);
  try {
    const res = await fetcher(url, {
      headers: { 'user-agent': 'delta-update' },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('响应无内容');
    const bytes = await pipelineTo(res.body, dest);
    fs.chmodSync(dest, 0o755);
    return { file: dest, bytes };
  } catch (e) {
    try {
      fs.rmSync(dest, { force: true });
    } catch {
      // 清理失败忽略
    }
    throw new Error(`下载更新包失败：${(e as Error).message}`);
  }
}

/** Web ReadableStream → 文件（node:stream consumers 兼容两种 stream 形态）。 */
async function pipelineTo(body: ReadableStream<Uint8Array>, dest: string): Promise<number> {
  const { pipeline } = await import('node:stream/promises');
  const { Readable } = await import('node:stream');
  let bytes = 0;
  const nodeStream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  nodeStream.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });
  await pipeline(nodeStream, fs.createWriteStream(dest));
  return bytes;
}

export interface ApplyBinarySwapResult {
  /** 旧二进制备份路径（成功换入后保留，供回退；下次更新时覆盖） */
  backupPath: string;
}

/**
 * 把下载好的新二进制原子换入 execPath 位置。
 * 失败自动回滚：最终要么新二进制到位、要么旧二进制原样，不留中间态。
 */
export function applyBinarySwap(downloadedPath: string, execPath: string): ApplyBinarySwapResult {
  const backupPath = `${execPath}.bak`;
  // 上一轮更新残留的备份先清掉（那已经是当前版本的旧版）
  try {
    fs.rmSync(backupPath, { force: true });
  } catch {
    // 忽略
  }
  fs.renameSync(execPath, backupPath);
  try {
    fs.renameSync(downloadedPath, execPath);
    return { backupPath };
  } catch (e) {
    // 换入失败：回滚旧二进制，保持可用
    try {
      fs.renameSync(backupPath, execPath);
    } catch {
      // 回滚也失败：只能抛原始错误
    }
    throw e;
  }
}
