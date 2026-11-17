/**
 * 研究 Agent — 每轮注入的精简个人上下文。
 *
 * 只给代码、名称、权重与状态，让模型知道哪些面板数据与自己相关；
 * 具体数字、证据与明细由 get_watchlist / get_portfolio / get_theses 按需读取，
 * 避免把整张表塞进每轮 prompt。
 */
import { getPortfolio, getTheses, getWatchlist } from '../cockpit/repo';
import { thesisStatusLabel } from '../cockpit/format';

const MAX_WATCHLIST = 12;
const MAX_POSITIONS = 10;
const MAX_THESES = 8;

export async function loadPersonalContextPrompt(): Promise<string> {
  try {
    const [watchlist, portfolio, theses] = await Promise.all([
      getWatchlist(),
      getPortfolio(),
      getTheses(),
    ]);

    const lines: string[] = [];
    if (watchlist.length > 0) {
      const shown = watchlist.slice(0, MAX_WATCHLIST).map((w) => `${w.code} ${w.name}`);
      lines.push(`自选（${watchlist.length}只）：${shown.join('、')}${watchlist.length > MAX_WATCHLIST ? ' 等' : ''}`);
    }

    const positions = [...portfolio.positions].sort((a, b) => b.weight - a.weight);
    if (positions.length > 0) {
      const shown = positions
        .slice(0, MAX_POSITIONS)
        .map((p) => `${p.code} ${p.name} ${p.weight.toFixed(1)}%`);
      lines.push(
        `持仓${portfolio.isDemo ? '（示例数据）' : ''}（${positions.length}只）：${shown.join('、')}${positions.length > MAX_POSITIONS ? ' 等' : ''}`,
      );
    }

    if (theses.length > 0) {
      const shown = theses
        .slice(0, MAX_THESES)
        .map((t) => `${t.code} ${t.title}（${thesisStatusLabel(t.status)}，支撑${t.supportCount}/反驳${t.opposeCount}）`);
      lines.push(`研究论点（${theses.length}条）：${shown.join('；')}${theses.length > MAX_THESES ? ' 等' : ''}`);
    }

    if (lines.length === 0) return '';
    return [
      '个人上下文（自动读取自驾驶舱，仅用于判断相关性；具体数字、证据与明细请调用 get_watchlist / get_portfolio / get_theses）：',
      ...lines,
    ].join('\n');
  } catch {
    // 面板数据不可用不能阻断对话；模型仍可继续用其它工具回答。
    return '';
  }
}
