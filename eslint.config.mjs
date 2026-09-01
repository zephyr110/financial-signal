import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * ESLint flat config（eslint 9 + eslint-config-next 16）。
 * 规则来自 next/core-web-vitals + next/typescript；构建产物与依赖目录全局忽略。
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
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
