/**
 * 生成桌面端 / Web 图标（对齐 zlog mac-icon-mask）：
 *   - build/icon.png：黑底白标 → 主体缩进板内（75%）→ Apple 超椭圆 squircle（inset 10%）
 *   - build/icon.icns：macOS iconutil（非 Darwin 跳过）
 *   - public favicon / apple-touch：同源蒙版的浅/深主题变体
 *
 * 用法：pnpm icons
 */
import { deflateSync, inflateSync } from "node:zlib"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { platform, tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import {
  applySquircleMask,
  composeMacAppIcon,
  MAC_ICON_GLYPH_PAD,
  MAC_ICON_INSET,
} from "./mac-icon-mask.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const LOGO = join(root, "public", "logo.png")
const BUILD = join(root, "build")
const PUBLIC = join(root, "public")
const CANVAS = 1024

const BG_DARK = [18, 18, 18]
const BG_LIGHT = [245, 245, 245]

// ── PNG decode / encode（零依赖，摘自 zlog gen-icons）────────────────

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG")
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 0
  let bitDepth = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString("ascii", pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === "IDAT") {
      idat.push(data)
    } else if (type === "IEND") break
    pos += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG (bitDepth=${bitDepth} colorType=${colorType})`)
  }
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      switch (filter) {
        case 1:
          v += a
          break
        case 2:
          v += b
          break
        case 3:
          v += (a + b) >> 1
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          break
        }
      }
      cur[x] = v & 0xff
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      out[o] = cur[x * bpp]
      out[o + 1] = cur[x * bpp + 1]
      out[o + 2] = cur[x * bpp + 2]
      out[o + 3] = colorType === 6 ? cur[x * bpp + 3] : 255
    }
    prev.set(cur)
  }
  return { width, height, data: out }
}

var crcTable = null
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, "ascii")
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function pngFromRgba(size, rgba) {
  const stride = size * 4 + 1
  const raw = Buffer.alloc(size * stride)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

// ── Logo → 方图画布 → macOS 应用图标 ────────────────────────────────

/** 将非方形白标贴到方正黑底上（铺满主体，后续由 layoutGlyphOnPlate 再缩进）。 */
function placeLogoOnSquare(logo, size, bgRgb = BG_DARK) {
  const out = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = bgRgb[0]
    out[i * 4 + 1] = bgRgb[1]
    out[i * 4 + 2] = bgRgb[2]
    out[i * 4 + 3] = 255
  }
  const scale = Math.min(size / logo.width, size / logo.height) * 0.9
  const dw = Math.max(1, Math.round(logo.width * scale))
  const dh = Math.max(1, Math.round(logo.height * scale))
  const ox = Math.floor((size - dw) / 2)
  const oy = Math.floor((size - dh) / 2)
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(logo.height - 1, Math.floor((y / dh) * logo.height))
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(logo.width - 1, Math.floor((x / dw) * logo.width))
      const si = (sy * logo.width + sx) * 4
      const a = logo.data[si + 3] / 255
      if (a < 0.01) continue
      const di = ((oy + y) * size + (ox + x)) * 4
      out[di] = Math.round(logo.data[si] * a + bgRgb[0] * (1 - a))
      out[di + 1] = Math.round(logo.data[si + 1] * a + bgRgb[1] * (1 - a))
      out[di + 2] = Math.round(logo.data[si + 2] * a + bgRgb[2] * (1 - a))
      out[di + 3] = 255
    }
  }
  return out
}

/** 浅色主题：黑标贴在浅灰底上，再套同一套 squircle。 */
function placeDarkMarkOnLight(logo, size) {
  const tinted = Buffer.from(logo.data)
  for (let i = 0; i < logo.width * logo.height; i++) {
    const o = i * 4
    if (tinted[o + 3] < 8) continue
    // 原白标 → 近黑（保留 alpha）
    tinted[o] = BG_DARK[0]
    tinted[o + 1] = BG_DARK[1]
    tinted[o + 2] = BG_DARK[2]
  }
  return placeLogoOnSquare({ width: logo.width, height: logo.height, data: tinted }, size, BG_LIGHT)
}

function writeAppIcon(logo, destPng) {
  const square = placeLogoOnSquare(logo, CANVAS, BG_DARK)
  const masked = composeMacAppIcon(square, CANVAS)
  mkdirSync(BUILD, { recursive: true })
  writeFileSync(destPng, pngFromRgba(CANVAS, masked))
}

function writeThemedPng(rgba1024, dest, size) {
  // 最近邻缩小（favicon 不需要超精细重采样）
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const sy = Math.floor((y / size) * CANVAS)
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x / size) * CANVAS)
      const si = (sy * CANVAS + sx) * 4
      const di = (y * size + x) * 4
      out[di] = rgba1024[si]
      out[di + 1] = rgba1024[si + 1]
      out[di + 2] = rgba1024[si + 2]
      out[di + 3] = rgba1024[si + 3]
    }
  }
  writeFileSync(dest, pngFromRgba(size, out))
}

function writeIcns(pngPath, icnsPath) {
  if (platform() !== "darwin") {
    console.warn("skip icon.icns (iconutil is macOS-only)")
    return
  }
  const sizes = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
  }
  const dir = mkdtempSync(join(tmpdir(), "fs-iconset-"))
  const iconset = join(dir, "AppIcon.iconset")
  mkdirSync(iconset)
  const master = decodePng(readFileSync(pngPath))
  for (const [name, size] of Object.entries(sizes)) {
    const out = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y++) {
      const sy = Math.floor((y / size) * master.width)
      for (let x = 0; x < size; x++) {
        const sx = Math.floor((x / size) * master.width)
        const si = (sy * master.width + sx) * 4
        const di = (y * size + x) * 4
        out[di] = master.data[si]
        out[di + 1] = master.data[si + 1]
        out[di + 2] = master.data[si + 2]
        out[di + 3] = master.data[si + 3]
      }
    }
    writeFileSync(join(iconset, name), pngFromRgba(size, out))
  }
  const r = spawnSync("iconutil", ["-c", "icns", iconset, "-o", icnsPath], {
    encoding: "utf8",
  })
  rmSync(dir, { recursive: true, force: true })
  if (r.status !== 0) {
    throw new Error(`iconutil failed: ${r.stderr || r.stdout || r.status}`)
  }
}

function clearBuilderIconCache() {
  for (const p of [join(root, "dist", ".icon-icns"), join(root, "release", ".icon-icns")]) {
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true })
      console.log("cleared electron-builder icon cache", p)
    }
  }
}

function main() {
  if (!existsSync(LOGO)) throw new Error(`Missing logo: ${LOGO}`)
  const logo = decodePng(readFileSync(LOGO))

  const iconPng = join(BUILD, "icon.png")
  writeAppIcon(logo, iconPng)
  writeIcns(iconPng, join(BUILD, "icon.icns"))

  const darkApp = composeMacAppIcon(placeLogoOnSquare(logo, CANVAS, BG_DARK), CANVAS)
  const lightApp = composeMacAppIcon(placeDarkMarkOnLight(logo, CANVAS), CANVAS)

  writeThemedPng(lightApp, join(PUBLIC, "favicon-light.png"), 512)
  writeThemedPng(darkApp, join(PUBLIC, "favicon-dark.png"), 512)
  writeThemedPng(darkApp, join(PUBLIC, "apple-touch-icon.png"), CANVAS)
  // favicon.ico：复用 32px PNG 字节（现代浏览器接受；兼作 sizes=any 回退）
  writeThemedPng(darkApp, join(PUBLIC, "favicon.ico"), 32)

  clearBuilderIconCache()

  console.log(
    `Generated macOS icons (inset=${MAC_ICON_INSET}, glyphPad=${MAC_ICON_GLYPH_PAD}):`
  )
  for (const rel of [
    "build/icon.png",
    "build/icon.icns",
    "public/favicon-light.png",
    "public/favicon-dark.png",
    "public/apple-touch-icon.png",
    "public/favicon.ico",
  ]) {
    const p = join(root, rel)
    console.log(`  ${rel} (${existsSync(p) ? "ok" : "missing"})`)
  }
}

main()
