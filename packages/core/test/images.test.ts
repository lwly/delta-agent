/**
 * F-25 多模态：图片附件加载/校验/计价 + Provider 透传映射 单测。
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@delta/shared';
import {
  MAX_IMAGES_PER_MESSAGE,
  ImageError,
  estimateImageTokens,
  imageDimensions,
  normalizeIncomingImages,
  prepareImageFromBase64,
  prepareImages,
  sniffImageMediaType,
} from '../src/media/images.js';
import { estimateMessagesTokens } from '../src/context/tokens.js';
import { convertMessages as anthropicConvert } from '../src/llm/providers/anthropic.js';
import { convertMessages as openaiConvert } from '../src/llm/providers/openai-compatible.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 构造仅含签名 + IHDR 头的最小 PNG（足够魔数嗅探与尺寸解析）。 */
function pngBytes(w: number, h: number): Buffer {
  const b = Buffer.alloc(26);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8; // bit depth
  b[25] = 6; // color type RGBA
  return b;
}

describe('F-25 magic sniffing', () => {
  it('detects png/jpeg/gif/webp by magic bytes', () => {
    expect(sniffImageMediaType(pngBytes(1, 1))).toBe('image/png');
    expect(sniffImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMediaType(Buffer.from('GIF89a...'))).toBe('image/gif');
    const webp = Buffer.alloc(16);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBP', 8, 'ascii');
    expect(sniffImageMediaType(webp)).toBe('image/webp');
  });

  it('rejects unknown formats', () => {
    expect(() => sniffImageMediaType(Buffer.from('<svg>...</svg>'))).toThrow(ImageError);
  });

  it('falls back to extension only when magic misses', () => {
    expect(() => sniffImageMediaType(Buffer.from('plain text'))).toThrow();
    expect(sniffImageMediaType(Buffer.from('plain text'), 'photo.JPG')).toBe('image/jpeg');
  });
});

describe('F-25 dimensions & token pricing', () => {
  it('parses png dimensions from IHDR', () => {
    expect(imageDimensions(pngBytes(640, 480), 'image/png')).toEqual({ width: 640, height: 480 });
  });

  it('prices by capped area (max 1568 per side)', () => {
    const img = { mediaType: 'image/png', base64: '' };
    expect(estimateImageTokens(img, { width: 640, height: 480 })).toBe(Math.ceil((640 * 480) / 750));
    // 超大图按 1568 封顶计价（下采样有效分辨率）
    expect(estimateImageTokens(img, { width: 4000, height: 3000 })).toBe(Math.ceil((1568 * 1568) / 750));
  });

  it('falls back to byte-based estimate without dims (capped)', () => {
    const big = { mediaType: 'image/png', base64: 'A'.repeat(10_000_000) }; // 远超封顶
    expect(estimateImageTokens(big)).toBeLessThanOrEqual(1600);
  });
});

describe('F-25 prepareImageFromBase64', () => {
  it('accepts a valid png and strips data-url prefix', () => {
    const b64 = pngBytes(100, 50).toString('base64');
    const img = prepareImageFromBase64(`data:image/png;base64,${b64}`, { name: 'shot.png' });
    expect(img.mediaType).toBe('image/png');
    expect(img.dims).toEqual({ width: 100, height: 50 });
    expect(img.bytes).toBe(26);
    expect(img.tokens).toBeGreaterThan(0);
  });

  it('rejects empty payload', () => {
    expect(() => prepareImageFromBase64('')).toThrow(ImageError);
    expect(() => prepareImageFromBase64('////')).toThrow(); // 解码为空/非图片
  });

  it('rejects non-image payload', () => {
    const text = Buffer.from('hello, not an image').toString('base64');
    expect(() => prepareImageFromBase64(text)).toThrow(ImageError);
  });
});

describe('F-25 normalizeIncomingImages (HTTP 通道)', () => {
  it('returns [] for undefined and accepts string items with data-url', () => {
    expect(normalizeIncomingImages(undefined)).toEqual([]);
    const b64 = pngBytes(10, 10).toString('base64');
    const imgs = normalizeIncomingImages([`data:image/png;base64,${b64}`]);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.mediaType).toBe('image/png');
  });

  it('enforces per-message count limit', () => {
    const b64 = pngBytes(10, 10).toString('base64');
    const many = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => b64);
    expect(() => normalizeIncomingImages(many)).toThrow(/最多/);
  });

  it('rejects items without base64', () => {
    expect(() => normalizeIncomingImages([{ mediaType: 'image/png' }])).toThrow(ImageError);
  });

  it('rejects non-array input', () => {
    expect(() => normalizeIncomingImages('nope')).toThrow(/数组/);
  });
});

describe('F-25 prepareImages (CLI 文件通道)', () => {
  it('loads a png file from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-img-'));
    const file = path.join(dir, 'shot.png');
    fs.writeFileSync(file, pngBytes(300, 200));
    const imgs = prepareImages([file]);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.name).toBe('shot.png');
    expect(imgs[0]!.dims).toEqual({ width: 300, height: 200 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects missing files with a clear error', () => {
    expect(() => prepareImages(['/nonexistent/nope.png'])).toThrow(/读取图片失败/);
  });
});

describe('F-25 provider passthrough mapping', () => {
  const base64 = pngBytes(8, 8).toString('base64');
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    {
      role: 'user',
      content: '看看这个截图',
      images: [{ mediaType: 'image/png', base64 }],
    },
    { role: 'user', content: '纯文本' },
  ];

  it('anthropic: user message becomes text + image source blocks', () => {
    // 注：system 消息由 chat() 上层摘除，convertMessages 只处理 user/assistant/tool
    const out = anthropicConvert(messages) as Array<Record<string, unknown>>;
    const blocks = out[0]!.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: 'text', text: '看看这个截图' });
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: base64 },
    });
    expect(out[1]).toEqual({ role: 'user', content: '纯文本' });
  });

  it('openai-compatible: user message becomes text + image_url parts', () => {
    const out = openaiConvert(messages) as Array<Record<string, unknown>>;
    expect(out[0]).toEqual({ role: 'system', content: 'sys' });
    expect(out[1]!.content).toEqual([
      { type: 'text', text: '看看这个截图' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
    ]);
    expect(out[2]).toEqual({ role: 'user', content: '纯文本' });
  });

  it('estimateMessagesTokens counts image attachments', () => {
    const withImg: ChatMessage[] = [{ role: 'user', content: '看看这个截图', images: [{ mediaType: 'image/png', base64 }] }];
    const withoutImg: ChatMessage[] = [{ role: 'user', content: '看看这个截图' }];
    // 8×8 图按面积计价 = 1 token（向上取整）
    expect(estimateMessagesTokens(withImg) - estimateMessagesTokens(withoutImg)).toBe(Math.max(1, Math.ceil((8 * 8) / 750)));
  });
});
