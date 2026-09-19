import fs from 'node:fs';
import zlib from 'node:zlib';

// ── 1. 简易无依赖 PNG 编解码工具 ──────────────────────────────────────
function readPngRgba(filePath) {
  const buf = fs.readFileSync(filePath);
  let pos = 8;
  let width = 0;
  let height = 0;
  const idatChunks = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    if (type === 'IHDR') {
      width = buf.readUInt32BE(pos + 8);
      height = buf.readUInt32BE(pos + 12);
    } else if (type === 'IDAT') {
      idatChunks.push(buf.slice(pos + 8, pos + 8 + len));
    }
    pos += 12 + len;
  }
  const decompressed = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp = 4;
  const stride = width * bpp;
  const uncompressed = Buffer.alloc(width * height * bpp);
  let srcOffset = 0;
  let dstOffset = 0;

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  for (let y = 0; y < height; y++) {
    const filterType = decompressed[srcOffset++];
    const prevRowOffset = dstOffset - stride;
    for (let x = 0; x < stride; x++) {
      const raw = decompressed[srcOffset++];
      const a = x >= bpp ? uncompressed[dstOffset - bpp] : 0;
      const b = y > 0 ? uncompressed[prevRowOffset + x] : 0;
      const c = y > 0 && x >= bpp ? uncompressed[prevRowOffset + x - bpp] : 0;
      let val = 0;
      if (filterType === 0) val = raw;
      else if (filterType === 1) val = (raw + a) & 0xff;
      else if (filterType === 2) val = (raw + b) & 0xff;
      else if (filterType === 3) val = (raw + Math.floor((a + b) / 2)) & 0xff;
      else if (filterType === 4) val = (raw + paeth(a, b, c)) & 0xff;
      uncompressed[dstOffset++] = val;
    }
  }
  return { width, height, data: uncompressed };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function writePngRgba(filePath, width, height, rgbaBuffer) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
    rgbaBuffer.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(filePath, png);
}

// ── 2. 双线性插值缩放 ────────────────────────────────────────────────
function resizeBilinear(src, targetW, targetH) {
  const dst = Buffer.alloc(targetW * targetH * 4);
  const xRatio = (src.width - 1) / Math.max(1, targetW - 1);
  const yRatio = (src.height - 1) / Math.max(1, targetH - 1);

  for (let y = 0; y < targetH; y++) {
    const srcY = y * yRatio;
    const yFloor = Math.floor(srcY);
    const yCeil = Math.min(src.height - 1, yFloor + 1);
    const yWeight = srcY - yFloor;

    for (let x = 0; x < targetW; x++) {
      const srcX = x * xRatio;
      const xFloor = Math.floor(srcX);
      const xCeil = Math.min(src.width - 1, xFloor + 1);
      const xWeight = srcX - xFloor;

      const idxTL = (yFloor * src.width + xFloor) * 4;
      const idxTR = (yFloor * src.width + xCeil) * 4;
      const idxBL = (yCeil * src.width + xFloor) * 4;
      const idxBR = (yCeil * src.width + xCeil) * 4;
      const dstIdx = (y * targetW + x) * 4;

      for (let c = 0; c < 4; c++) {
        const top = src.data[idxTL + c] * (1 - xWeight) + src.data[idxTR + c] * xWeight;
        const bottom = src.data[idxBL + c] * (1 - xWeight) + src.data[idxBR + c] * xWeight;
        dst[dstIdx + c] = Math.round(top * (1 - yWeight) + bottom * yWeight);
      }
    }
  }
  return { width: targetW, height: targetH, data: dst };
}

// ── 3. 生成 Maskable 图标：在 512x512 容器内铺底色，将主体缩放至 76% 居中 ──
// W3C / Android 要求：安全区为半径 40%（即 80% 宽度）以内的中心区域。
// 我们将主体按 76% 缩放，保证即使在极端圆形剪裁下，图标的圆角与光晕也完整呈现。
function createMaskableIcon(srcImg, size) {
  const scale = 0.76;
  const innerSize = Math.round(size * scale);
  const resizedInner = resizeBilinear(srcImg, innerSize, innerSize);

  const bgR = 0x0c;
  const bgG = 0x0f;
  const bgB = 0x18;
  const out = Buffer.alloc(size * size * 4);

  // 1. 铺满深色科技背景 (#0c0f18)
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = bgR;
    out[i * 4 + 1] = bgG;
    out[i * 4 + 2] = bgB;
    out[i * 4 + 3] = 0xff;
  }

  // 2. 居中混合主体图标
  const offset = Math.floor((size - innerSize) / 2);
  for (let y = 0; y < innerSize; y++) {
    for (let x = 0; x < innerSize; x++) {
      const srcIdx = (y * innerSize + x) * 4;
      const dstIdx = ((y + offset) * size + (x + offset)) * 4;

      const sa = resizedInner.data[srcIdx + 3] / 255;
      const sr = resizedInner.data[srcIdx];
      const sg = resizedInner.data[srcIdx + 1];
      const sb = resizedInner.data[srcIdx + 2];

      out[dstIdx] = Math.round(sr * sa + bgR * (1 - sa));
      out[dstIdx + 1] = Math.round(sg * sa + bgG * (1 - sa));
      out[dstIdx + 2] = Math.round(sb * sa + bgB * (1 - sa));
      out[dstIdx + 3] = 0xff;
    }
  }

  return { width: size, height: size, data: out };
}

// ── 执行生成 ──────────────────────────────────────────────────────────
const srcFile = 'src-tauri/icons/深色终端霓虹图标.png';
const srcImg = readPngRgba(srcFile);
console.log('读取高清源图标成功:', srcImg.width, 'x', srcImg.height);

// 1. 生成 Any 图标（普通桌面/任务栏/快捷方式，保留原生无白边透明圆角）
const standard512 = resizeBilinear(srcImg, 512, 512);
writePngRgba('public/icon-512.png', 512, 512, standard512.data);

const standard192 = resizeBilinear(srcImg, 192, 192);
writePngRgba('public/icon-192.png', 192, 192, standard192.data);

// 2. 生成专为手机桌面与 PWA Maskable 裁切设计的自适应图标（有深色安全衬底，缩放至安全区）
const maskable512 = createMaskableIcon(srcImg, 512);
writePngRgba('public/maskable-512.png', 512, 512, maskable512.data);

const maskable192 = createMaskableIcon(srcImg, 192);
writePngRgba('public/maskable-192.png', 192, 192, maskable192.data);

console.log('PWA 各场景图标生成完毕！');
