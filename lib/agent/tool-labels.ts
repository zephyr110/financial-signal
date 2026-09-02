/** Agent 工具内部名 → 页面展示用中文名 */
export const TOOL_LABELS: Record<string, string> = {
  search_news: "搜索信号",
  get_event_threads: "查询事件线索",
  get_industry_heatmap: "行业热力图",
  get_backtest: "信号回测",
  watch_event: "事件详情",
  format_markdown: "整理 Markdown",
  fix_json: "修复 JSON",
};

export function getToolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}
