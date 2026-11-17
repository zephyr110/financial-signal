/** Agent 工具内部名 → 页面展示用中文名 */
export const TOOL_LABELS: Record<string, string> = {
  search_news: "搜索信号",
  get_event_threads: "查询事件线索",
  get_industry_heatmap: "行业热力图",
  get_backtest: "信号回测",
  watch_event: "事件详情",
  get_desk_snapshot: "投研台快照",
  get_open_alerts: "未处理预警",
  get_judgments: "判断台账",
  get_investigation: "预警深挖",
  get_today_brief: "今日简报",
  search_documents: "检索公告原文",
  get_watchlist: "读取自选",
  get_portfolio: "读取持仓",
  get_theses: "研究论点",
  get_stock_detail: "个股详情",
  get_signal_detail: "信号详情",
  get_tasks: "任务状态",
  propose_action: "提交待确认动作",
  format_markdown: "整理 Markdown",
  fix_json: "修复 JSON",
  web_search: "联网搜索",
};

export function getToolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}
