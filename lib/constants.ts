export const FILTER_KEYWORDS = [
  '比特币', '以太坊', '莱特币', '疫苗', '疫情', '蓬佩奥',
];

// --- Category & Sentiment Labels (shared across analysis components) ---

export const CATEGORY_LABELS = {
  policy: '政策',
  geopolitics: '地缘',
  industry: '行业',
  company: '公司',
  macro: '宏观',
  market_rumor: '传闻',
};

export const CATEGORY_COLORS = {
  policy: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  geopolitics: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  industry: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  company: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  macro: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  market_rumor: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
};

export const SCORE_COLORS = {
  5: 'bg-red-600 text-white',
  4: 'bg-orange-500 text-white',
  3: 'bg-yellow-500 text-white',
  2: 'bg-gray-400 text-white',
  1: 'bg-gray-300 text-gray-600',
};

// 分数等级中文标签（全站统一词表，与 SCORE_TO_IMPACT 一一对应）
export const SCORE_LABELS = {
  5: '重大',
  4: '重要',
  3: '关注',
  2: '一般',
  1: '噪声',
};

export const SCORE_TO_IMPACT = {
  5: 'critical',
  4: 'significant',
  3: 'moderate',
  2: 'minor',
  1: 'noise',
};

// ── 行业名展示归一 ──
// LLM 输出的行业名与行情板块名不一致时,统一到板块名展示(与回测/板块对照行同一词汇)。
// 与 lib/market.ts 的行情映射同源;idempotent:板块名本身不在 key 中,重复调用不变。
export const INDUSTRY_ALIASES: Record<string, string> = {
  '半导体': '半导体材料',
  '光模块': '光通信模块',
};

export function industryDisplayName(name: string): string {
  return INDUSTRY_ALIASES[name] ?? name;
}
