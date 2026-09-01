/**
 * macOS Big Sur+ 把「铺满画布的不透明方图」当成旧式图标，不再套系统
 * squircle。即便裁了圆角，若图形贴满 1024 画布，Launchpad 里仍会比
 * Excel 等系统应用大约一圈——系统图标在画布内留了透明边。
 *
 * n=5 是 Apple 连续圆角的常用近似；inset=0.1 约等于 1024 画布每边 100px。
 * glyphPad=0.125：板内每边 12.5%（图形占板的 75%），主体不贴边。
 */
export const MAC_ICON_INSET = 0.1
export const MAC_ICON_GLYPH_PAD = 0.125

export function applySquircleMask(rgba, size, { n = 5, inset = MAC_ICON_INSET } = {}) {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`applySquircleMask: size must be a positive integer, got ${size}`)
  }
  if (rgba.length < size * size * 4) {
    throw new Error("applySquircleMask: RGBA buffer shorter than size²")
  }
  if (inset < 0 || inset >= 0.5) {
    throw new Error(`applySquircleMask: inset must be in [0, 0.5), got ${inset}`)
  }
  const inner = size * (1 - 2 * inset)
  const origin = size * inset
  const out = Buffer.from(rgba)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = ((x + 0.5 - origin) / inner) * 2 - 1
      const ny = ((y + 0.5 - origin) / inner) * 2 - 1
      const v = Math.pow(Math.abs(nx), n) + Math.pow(Math.abs(ny), n)
      // 曲线过 (±1,0)：大图上边心像素几乎落在边界上。v<=1 视为内部，
      // 只在外侧抗锯齿，否则 1024 图标四边会被裁成半透明。
      let cover = 1
      if (v >= 1.04) cover = 0
      else if (v > 1) cover = 1 - (v - 1) / 0.04
      const o = (y * size + x) * 4 + 3
      out[o] = Math.round(out[o] * cover)
    }
  }
  return out
}

/** 亮部（logo 白形）包围盒；全暗则没有可缩的主体。 */
export function findGlyphBounds(rgba, size, { lumMin = 40 } = {}) {
  let minX = size, minY = size, maxX = -1, maxY = -1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4
      const lum = (rgba[o] + rgba[o + 1] + rgba[o + 2]) / 3
      if (lum > lumMin && rgba[o + 3] > 32) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { minX, minY, maxX, maxY }
}

/**
 * 把白色主体缩进 squircle 板内，四周用底色填满，外框尺寸不变。
 */
export function layoutGlyphOnPlate(rgba, size, {
  inset = MAC_ICON_INSET,
  glyphPad = MAC_ICON_GLYPH_PAD,
} = {}) {
  const plate = size * (1 - 2 * inset)
  const pad = plate * glyphPad
  const target = Math.max(1, plate - 2 * pad)
  const bounds = findGlyphBounds(rgba, size)
  const out = Buffer.alloc(size * size * 4)
  // 底色取四角均值（logo 是黑底）；无 alpha 的源也写成不透明。
  let br = 0, bg = 0, bb = 0
  for (const [cx, cy] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
    const o = (cy * size + cx) * 4
    br += rgba[o]
    bg += rgba[o + 1]
    bb += rgba[o + 2]
  }
  br = Math.round(br / 4)
  bg = Math.round(bg / 4)
  bb = Math.round(bb / 4)
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = br
    out[i * 4 + 1] = bg
    out[i * 4 + 2] = bb
    out[i * 4 + 3] = 255
  }
  if (!bounds) return out

  const bw = bounds.maxX - bounds.minX + 1
  const bh = bounds.maxY - bounds.minY + 1
  const scale = Math.min(target / bw, target / bh)
  const dw = Math.max(1, bw * scale)
  const dh = Math.max(1, bh * scale)
  const ox = (size - dw) / 2
  const oy = (size - dh) / 2
  const x0 = Math.max(0, Math.floor(ox))
  const y0 = Math.max(0, Math.floor(oy))
  const x1 = Math.min(size, Math.ceil(ox + dw))
  const y1 = Math.min(size, Math.ceil(oy + dh))

  for (let y = y0; y < y1; y++) {
    const sy0 = bounds.minY + (y - oy) / scale
    const sy1 = bounds.minY + (y + 1 - oy) / scale
    for (let x = x0; x < x1; x++) {
      const sx0 = bounds.minX + (x - ox) / scale
      const sx1 = bounds.minX + (x + 1 - ox) / scale
      const [r, g, b, a] = sampleArea(rgba, size, sx0, sy0, sx1, sy1)
      const o = (y * size + x) * 4
      const ia = a / 255
      out[o] = Math.round(r * ia + br * (1 - ia))
      out[o + 1] = Math.round(g * ia + bg * (1 - ia))
      out[o + 2] = Math.round(b * ia + bb * (1 - ia))
      out[o + 3] = 255
    }
  }
  return out
}

function sampleArea(rgba, size, x0, y0, x1, y1) {
  const ix0 = Math.max(0, Math.floor(x0))
  const iy0 = Math.max(0, Math.floor(y0))
  const ix1 = Math.min(size, Math.ceil(x1))
  const iy1 = Math.min(size, Math.ceil(y1))
  if (ix1 <= ix0 || iy1 <= iy0) return [0, 0, 0, 0]
  let r = 0, g = 0, b = 0, a = 0, n = 0
  for (let y = iy0; y < iy1; y++) {
    for (let x = ix0; x < ix1; x++) {
      const o = (y * size + x) * 4
      r += rgba[o]
      g += rgba[o + 1]
      b += rgba[o + 2]
      a += rgba[o + 3]
      n++
    }
  }
  return [r / n, g / n, b / n, a / n]
}

/** 缩进主体后再套 squircle，一次生成 macOS 应用图标像素。 */
export function composeMacAppIcon(rgba, size, opts) {
  return applySquircleMask(layoutGlyphOnPlate(rgba, size, opts), size, opts)
}
