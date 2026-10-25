/**
 * F-25 多模态：图片附件加载 / 校验 / 压缩策略 / token 计价。
 *
 * 压缩策略（纯 Node、零原生依赖）：
 * - 仅接受 png / jpeg / gif / webp 四种主流格式（与两家视觉协议对齐）
 * - 单图原始字节上限 MAX_IMAGE_BYTES（Anthropic 5MB、OpenAI 20MB，取严）
 * - 超限直接拒绝并提示压缩后再发（不做有损重编码，避免引入原生图像库）
 * - token 计价按「有效分辨率」：长边超过 MAX_IMAGE_DIM 的部分视为将被
 *   服务端下采样，按 1568px 封顶面积计价（Anthropic ≈ 面积/750）；
 *   无法解析尺寸时退化为字节估算（≈ 原始字节/750，封顶 1600）。
 */
import * as fs from 'node:fs';
import type { MessageImage } from '@delta/shared';

export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** 单图原始字节上限（4MB，严于 Anthropic 5MB 请求体限制，预留 base64 膨胀余量） */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** 单条消息图片数量上限 */
export const MAX_IMAGES_PER_MESSAGE = 5;
/** token 计价的最大有效边长（主流视觉模型在 ~1568px 后不再增加有效分辨率） */
export const MAX_IMAGE_DIM = 1568;
/** 字节退化估算的单图 token 封顶 */
const BYTE_ESTIMATE_CAP = 1600;

export class ImageError extends Error {}

/** 魔数嗅探 media type（扩展名仅作最后回退，防止伪造后缀）。 */
export function sniffImageMediaType(buf: Buffer, fallbackName?: string): string {
  if (buf.length >= 3) {
    if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp';
  const ext = fallbackName ? fallbackName.toLowerCase().split('.').pop() : undefined;
  const byExt: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  if (ext && byExt[ext]) return byExt[ext]!;
  throw new ImageError('无法识别的图片格式（仅支持 png / jpeg / gif / webp）');
}

interface Dim {
  width: number;
  height: number;
}

/** 从文件头解析像素尺寸（png IHDR / jpeg SOF / gif LSD / webp VP8 系）。 */
export function imageDimensions(buf: Buffer, mediaType: string): Dim | undefined {
  try {
    if (mediaType === 'image/png' && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mediaType === 'image/gif' && buf.length >= 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mediaType === 'image/jpeg') {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1]!;
        // SOF0-SOF15（DHT/DAC/RST 除外）
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        off += 2 + buf.readUInt16BE(off + 2);
      }
    }
    if (mediaType === 'image/webp' && buf.length >= 30) {
      const tag = buf.subarray(12, 16).toString('ascii');
      if (tag === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
        // 简单有损 VP8：14-19 字节为帧头尺寸（14 bit 有效）
        const w = buf.readUInt16LE(26) & 0x3fff;
        const h = buf.readUInt16LE(28) & 0x3fff;
        return { width: w, height: h };
      }
      if (tag === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (tag === 'VP8X') {
        const w = 1 + (buf.readUIntLE(24, 3));
        const h = 1 + (buf.readUIntLE(27, 3));
        return { width: w, height: h };
      }
    }
  } catch {
    // 头解析失败 → 退化为字节估算
  }
  return undefined;
}

/** token 计价：封顶面积/750（Anthropic 口径）；无尺寸时按原始字节退化估算。 */
export function estimateImageTokens(img: { mediaType: string; base64: string }, dims?: Dim): number {
  if (dims && dims.width > 0 && dims.height > 0) {
    const w = Math.min(dims.width, MAX_IMAGE_DIM);
    const h = Math.min(dims.height, MAX_IMAGE_DIM);
    return Math.ceil((w * h) / 750);
  }
  const rawBytes = Math.floor(img.base64.length * 0.75);
  return Math.min(BYTE_ESTIMATE_CAP, Math.max(1, Math.ceil(rawBytes / 750)));
}

/** 解析后的图片附件（含解析出的元信息，供计价与展示复用）。 */
export interface PreparedImage extends MessageImage {
  name?: string;
  bytes: number;
  dims?: Dim;
  tokens: number;
}

/**
 * 从 base64 载荷构建附件（Web 上传通道）。
 * 校验格式魔数、大小上限；解析尺寸用于 token 计价。
 */
export function prepareImageFromBase64(base64: string, opts?: { name?: string; hintMediaType?: string }): PreparedImage {
  const clean = base64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!clean) throw new ImageError('图片内容为空');
  let buf: Buffer;
  try {
    buf = Buffer.from(clean, 'base64');
  } catch {
    throw new ImageError('base64 解码失败');
  }
  if (buf.length === 0) throw new ImageError('图片内容为空');
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new ImageError(`图片过大（${(buf.length / 1024 / 1024).toFixed(1)}MB > 上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB），请压缩后再发送`);
  }
  const mediaType = sniffImageMediaType(buf, opts?.name);
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(mediaType)) {
    throw new ImageError(`不支持的图片类型：${mediaType}`);
  }
  const dims = imageDimensions(buf, mediaType);
  return {
    mediaType,
    base64: clean,
    name: opts?.name,
    bytes: buf.length,
    dims,
    tokens: estimateImageTokens({ mediaType, base64: clean }, dims),
  };
}

/** 从本地文件路径构建附件（CLI 通道）。 */
export function prepareImageFromFile(filePath: string): PreparedImage {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    throw new ImageError(`读取图片失败：${filePath}（${(e as Error).message}）`);
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new ImageError(`图片过大（${(buf.length / 1024 / 1024).toFixed(1)}MB > 上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB），请压缩后再发送`);
  }
  const mediaType = sniffImageMediaType(buf, filePath);
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(mediaType)) {
    throw new ImageError(`不支持的图片类型：${mediaType}`);
  }
  const dims = imageDimensions(buf, mediaType);
  const base64 = buf.toString('base64');
  return {
    mediaType,
    base64,
    name: filePath.split(/[\\/]/).pop(),
    bytes: buf.length,
    dims,
    tokens: estimateImageTokens({ mediaType, base64 }, dims),
  };
}

/** 批量准备（数量上限校验）。 */
export function prepareImages(paths: string[]): PreparedImage[] {
  if (paths.length > MAX_IMAGES_PER_MESSAGE) {
    throw new ImageError(`单条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`);
  }
  return paths.map(prepareImageFromFile);
}

/** 校验 HTTP 层传入的图片数组（已 base64 形态）。 */
export function normalizeIncomingImages(raw: unknown): PreparedImage[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ImageError('images 必须是数组');
  if (raw.length > MAX_IMAGES_PER_MESSAGE) {
    throw new ImageError(`单条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`);
  }
  return raw.map((item) => {
    if (typeof item === 'string') return prepareImageFromBase64(item);
    const o = item as { base64?: unknown; mediaType?: unknown; name?: unknown };
    if (typeof o?.base64 !== 'string') throw new ImageError('图片项缺少 base64 字段');
    return prepareImageFromBase64(o.base64, {
      name: typeof o.name === 'string' ? o.name : undefined,
      hintMediaType: typeof o.mediaType === 'string' ? o.mediaType : undefined,
    });
  });
}

/** 人类可读摘要（CLI/Web 展示用）。 */
export function describeImage(img: PreparedImage): string {
  const dim = img.dims ? ` ${img.dims.width}×${img.dims.height}` : '';
  const kb = img.bytes >= 1024 ? `${(img.bytes / 1024).toFixed(0)}KB` : `${img.bytes}B`;
  return `${img.name ?? 'image'}（${kb}${dim}，≈${img.tokens} tokens）`;
}
