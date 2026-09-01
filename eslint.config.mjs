import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * ESLint flat config（eslint 9 + eslint-config-next 16）。
 *
 * 规则基调：next/core-web-vitals + next/typescript。
 * 历史债务策略（tsconfig 仍为 strict:false,存量 any/旧模式代码较多）：
 *  - 下列规则降为 warning 渐进修复,不阻塞构建/提交
 *  - electron/** 为 CJS 模块,require 是合法用法,豁免 no-require-imports
 * 构建稳定性：next.config.js 已设 eslint.ignoreDuringBuilds(部署不被 lint 阻塞),
 * lint 由独立 `pnpm lint` 把关。
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // 历史 any 债务:strict:false 下全项目大量显式 any,降级为可见 warning
      "@typescript-eslint/no-explicit-any": "warn",
      // React 19 新规则对历史"mount 时初始化外部状态"模式过于严格,降级渐进修复
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
    },
  },
  {
    files: ["electron/**/*.js"],
    rules: {
      // CJS 主进程模块:require 是合法用法
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  globalIgnores([
    "node_modules/**",
    ".next/**",
    "dist/**",
    "build/**",
    "out/**",
    "seed/**",
    ".pnpm-store/**",
  ]),
]);

export default eslintConfig;
