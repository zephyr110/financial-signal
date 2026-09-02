import { describe, it, expect } from "vitest";
import { resolveTooltipColor } from "@/components/chart-tooltip";

describe("resolveTooltipColor", () => {
  it("优先使用 entry.color", () => {
    expect(resolveTooltipColor({ color: "#ff0000" })).toBe("#ff0000");
  });

  it("回退 stroke 与 payload.fill", () => {
    expect(resolveTooltipColor({ stroke: "#00ff00" })).toBe("#00ff00");
    expect(resolveTooltipColor({ payload: { fill: "#0000ff" } })).toBe("#0000ff");
  });

  it("无颜色时返回默认灰", () => {
    expect(resolveTooltipColor({})).toBe("#6b7280");
  });
});
