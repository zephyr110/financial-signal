import { describe, it, expect } from "vitest"
import {
  applySquircleMask,
  composeMacAppIcon,
  findGlyphBounds,
  layoutGlyphOnPlate,
  MAC_ICON_GLYPH_PAD,
  MAC_ICON_INSET,
} from "../scripts/mac-icon-mask.mjs"

function opaqueSquare(size: number): Buffer {
  return Buffer.alloc(size * size * 4, 255)
}

function alphaAt(buf: Buffer, size: number, x: number, y: number): number {
  return buf[(y * size + x) * 4 + 3]
}

function lumAt(buf: Buffer, size: number, x: number, y: number): number {
  const o = (y * size + x) * 4
  return (buf[o] + buf[o + 1] + buf[o + 2]) / 3
}

describe("applySquircleMask (zlog-aligned)", () => {
  it("四角变透明，中心保持不透明", () => {
    const size = 64
    const out = applySquircleMask(opaqueSquare(size), size)
    expect(alphaAt(out, size, 0, 0)).toBe(0)
    expect(alphaAt(out, size, size - 1, 0)).toBe(0)
    expect(alphaAt(out, size, 0, size - 1)).toBe(0)
    expect(alphaAt(out, size, size - 1, size - 1)).toBe(0)
    expect(alphaAt(out, size, 32, 32)).toBe(255)
  })

  it("默认 inset 让画布边缘透明，视觉尺寸对齐系统图标", () => {
    expect(MAC_ICON_INSET).toBe(0.1)
    expect(MAC_ICON_GLYPH_PAD).toBe(0.125)
    for (const size of [64, 1024]) {
      const out = applySquircleMask(opaqueSquare(size), size)
      const mid = size >> 1
      expect(alphaAt(out, size, mid, 0)).toBe(0)
      expect(alphaAt(out, size, 0, mid)).toBe(0)
      const inner = Math.round(size * MAC_ICON_INSET) + 2
      expect(alphaAt(out, size, mid, inner)).toBe(255)
      expect(alphaAt(out, size, mid, mid)).toBe(255)
    }
  })

  it("inset=0 时四边中点仍不透明", () => {
    const size = 64
    const out = applySquircleMask(opaqueSquare(size), size, { inset: 0 })
    expect(alphaAt(out, size, 32, 0)).toBe(255)
    expect(alphaAt(out, size, 0, 32)).toBe(255)
  })

  it("主体缩进后，板边缘是底色，中心仍是图形", () => {
    const size = 64
    const black = Buffer.alloc(size * size * 4)
    for (let i = 0; i < size * size; i++) black[i * 4 + 3] = 255
    for (let y = 8; y < 56; y++) {
      for (let x = 8; x < 56; x++) {
        const o = (y * size + x) * 4
        black[o] = black[o + 1] = black[o + 2] = 255
      }
    }
    const fitted = layoutGlyphOnPlate(black, size)
    const mid = size >> 1
    const plateEdge = Math.round(size * MAC_ICON_INSET)
    const pad = Math.round(size * (1 - 2 * MAC_ICON_INSET) * MAC_ICON_GLYPH_PAD)
    const inner = plateEdge + pad
    expect(lumAt(fitted, size, mid, plateEdge + 1)).toBeLessThan(20)
    expect(lumAt(fitted, size, mid, inner + 2)).toBeGreaterThan(200)
    expect(lumAt(fitted, size, mid, mid)).toBeGreaterThan(200)
    expect(findGlyphBounds(fitted, size)).not.toBeNull()
  })

  it("composeMacAppIcon 保留透明四角", () => {
    const size = 64
    const out = composeMacAppIcon(opaqueSquare(size), size)
    expect(alphaAt(out, size, 0, 0)).toBe(0)
    expect(alphaAt(out, size, 32, 32)).toBe(255)
  })
})
