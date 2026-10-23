/**
 * 生成扩展图标。
 *
 * 不依赖任何图形库：直接写 PNG（IHDR / IDAT / IEND），
 * 用 4 倍超采样做抗锯齿。
 *
 * 图形：深绿色圆角方块 + 骰子「三点」，在 16px 下也能认出是「随机」。
 *
 * 用法：node scripts/make-icons.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const OUT_DIR = path.join(process.cwd(), 'icons')
const SIZES = [16, 32, 48, 128]
const SS = 4 // 超采样倍数

const BG = [0x2f, 0x6b, 0x4f, 255] // --accent
const FG = [0xfb, 0xf8, 0xf1, 255] // --paper

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- 绘制

function inRoundedRect(x, y, size, radius) {
  const r = radius
  if (x < r && y < r) return (x - r) ** 2 + (y - r) ** 2 <= r * r
  if (x > size - r && y < r) return (x - (size - r)) ** 2 + (y - r) ** 2 <= r * r
  if (x < r && y > size - r) return (x - r) ** 2 + (y - (size - r)) ** 2 <= r * r
  if (x > size - r && y > size - r) {
    return (x - (size - r)) ** 2 + (y - (size - r)) ** 2 <= r * r
  }
  return true
}

function renderSize(size) {
  const big = size * SS
  const acc = new Float64Array(size * size * 4)

  const radius = big * 0.23
  const dots = [
    [0.31, 0.31],
    [0.5, 0.5],
    [0.69, 0.69],
  ].map(([cx, cy]) => [cx * big, cy * big])
  const dotR = big * 0.093

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x * SS + sx + 0.5
          const py = y * SS + sy + 0.5

          if (!inRoundedRect(px, py, big, radius)) continue

          const inDot = dots.some(([cx, cy]) => (px - cx) ** 2 + (py - cy) ** 2 <= dotR * dotR)
          const color = inDot ? FG : BG
          r += color[0]
          g += color[1]
          b += color[2]
          a += color[3]
        }
      }

      const samples = SS * SS
      const i = (y * size + x) * 4
      acc[i] = r / samples
      acc[i + 1] = g / samples
      acc[i + 2] = b / samples
      acc[i + 3] = a / samples
    }
  }

  const out = Buffer.alloc(size * size * 4)
  for (let i = 0; i < acc.length; i += 1) out[i] = Math.round(acc[i])
  return out
}

fs.mkdirSync(OUT_DIR, { recursive: true })

for (const size of SIZES) {
  const rgba = renderSize(size)
  const png = encodePng(size, size, rgba)
  const file = path.join(OUT_DIR, `icon${size}.png`)
  fs.writeFileSync(file, png)
  console.log(`  ✓ ${path.relative(process.cwd(), file)}  ${png.length} bytes`)
}

console.log('图标已生成。')
