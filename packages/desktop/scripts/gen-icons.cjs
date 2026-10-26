/**
 * 图标生成：从 icons/icon.svg 渲染出 icon.png / icon.icns / icon.ico
 *
 * 用法（在 packages/desktop 下）：
 *   ./node_modules/.bin/electron scripts/gen-icons.cjs
 *   或：pnpm --filter @delta/desktop run icons
 *
 * 为什么用 Electron 而不是 sharp / rsvg-convert：
 *   本项目不引入额外的原生图像依赖，Electron 自带 Chromium 能精确渲染 SVG，
 *   且可指定透明背景。系统截图或在线转换工具默认会填白底，会让图标在 Dock /
 *   应用切换器里变成一块白方块 —— 本脚本专门避免这一点。
 *
 * 注意：本文件必须是 CJS（.cjs）。本包 package.json 是 "type": "module"，
 * 而 Electron 主进程里的 `require('electron')` 只有 CJS 才能拿到内置模块；
 * 在 .mjs 里 import 'electron' 会被解析成 node_modules 里的 npm 包装包。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, nativeImage } = require('electron');

const ICON_DIR = path.resolve(__dirname, '..', 'icons');
const SVG_PATH = path.join(ICON_DIR, 'icon.svg');
const MASTER = 1024;

/** 透明画布：不设任何背景色，SVG 直接铺满视口 */
const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${MASTER}px;height:${MASTER}px;background:transparent;overflow:hidden}
  svg{display:block;width:${MASTER}px;height:${MASTER}px}
</style></head><body>__SVG__</body></html>`;

async function renderMaster() {
  const win = new BrowserWindow({
    width: MASTER,
    height: MASTER,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
  });
  const html = HTML.replace('__SVG__', fs.readFileSync(SVG_PATH, 'utf8'));
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  // 等一帧，确保渐变与描边绘制完成
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage();
  win.destroy();
  if (img.isEmpty()) throw new Error('capturePage 返回空图像');
  const { width } = img.getSize();
  // Retina 下会是 2048，统一收敛回 1024
  return width === MASTER ? img : img.resize({ width: MASTER, height: MASTER, quality: 'best' });
}

/** 从 master 图缩放到目标尺寸并编码为 PNG */
function pngAt(master, size) {
  const out = size === MASTER ? master : master.resize({ width: size, height: size, quality: 'best' });
  return out.toPNG();
}

/** ICO 容器：Windows Vista+ 支持内嵌 PNG 条目 */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width（0 表示 256）
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // 调色板数
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += buf.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]);
}

/** 校验 PNG 角像素是否透明（防止白底再次混入） */
function assertTransparentCorners(png) {
  const img = nativeImage.createFromBuffer(png);
  const bmp = img.toBitmap(); // BGRA
  const w = img.getSize().width;
  const h = img.getSize().height;
  const alphaAt = (x, y) => bmp[(y * w + x) * 4 + 3];
  const corners = [alphaAt(0, 0), alphaAt(w - 1, 0), alphaAt(0, h - 1), alphaAt(w - 1, h - 1)];
  const centerAlpha = alphaAt(w >> 1, h >> 1);
  if (corners.some((a) => a !== 0)) throw new Error(`角像素不透明，存在底色：${corners.join(',')}`);
  if (centerAlpha === 0) throw new Error('中心像素透明，渲染失败');
  return { w, h, corners, centerAlpha };
}

async function main() {
  app.disableHardwareAcceleration();
  await app.whenReady();

  const master = await renderMaster();
  const check = assertTransparentCorners(master.toPNG());
  console.log(`master ${check.w}x${check.h} corners(A)=${check.corners.join(',')} center(A)=${check.centerAlpha}`);

  const masterPng = master.toPNG();
  fs.writeFileSync(path.join(ICON_DIR, 'icon.png'), pngAt(master, 512));
  console.log('wrote icon.png (512)');

  // icon.icns：先出 .iconset，再用系统 iconutil 打包
  const iconset = path.join(ICON_DIR, 'icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  const icnsMap = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of icnsMap) {
    fs.writeFileSync(path.join(iconset, name), pngAt(master, size));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(ICON_DIR, 'icon.icns')]);
  fs.rmSync(iconset, { recursive: true, force: true });
  console.log('wrote icon.icns');

  // icon.ico：Windows 任务栏 / 资源管理器
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  fs.writeFileSync(
    path.join(ICON_DIR, 'icon.ico'),
    buildIco(icoSizes.map((size) => ({ size, buf: pngAt(master, size) }))),
  );
  console.log(`wrote icon.ico (${icoSizes.join('/')})`);

  // 供人工确认的预览（1024 原图）
  fs.writeFileSync('/tmp/delta-icon-preview.png', masterPng);

  app.quit();
}

main().catch((e) => {
  console.error('FAILED:', e && e.message ? e.message : e);
  app.exit(1);
});
