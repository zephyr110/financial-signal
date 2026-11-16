import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import EmptyData from "../components/EmptyData";

describe("EmptyData", () => {
  it("默认显示「暂无数据」", () => {
    render(<EmptyData />);
    expect(screen.getByText("暂无数据")).toBeInTheDocument();
  });

  it("提示语文案可传入", () => {
    render(<EmptyData message="暂无行业趋势数据" />);
    expect(screen.getByText("暂无行业趋势数据")).toBeInTheDocument();
    expect(screen.queryByText("暂无数据")).not.toBeInTheDocument();
  });

  it("使用 inbox 图标，并在容器内水平垂直居中", () => {
    const { container } = render(<EmptyData />);
    const box = screen.getByRole("status");
    expect(box.className).toContain("items-center");
    expect(box.className).toContain("justify-center");
    expect(container.querySelector("svg")).toBeTruthy();
  });
});
