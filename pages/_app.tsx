import { SpeedInsights } from "@vercel/speed-insights/next";
import { ThemeProvider } from "next-themes";
import { useRouter } from "next/router";
import DynamicFavicon from "@/components/DynamicFavicon";
import "../styles/globals.css";
import "../styles/cockpit.css";

export default function App({ Component, pageProps }) {
  const router = useRouter();
  // Speed Insights 脚本只由 Vercel 提供；自托管时请求它会固定 404。
  const vercelInsights = process.env.NEXT_PUBLIC_VERCEL_ENV;
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <DynamicFavicon />
      {/* 只按路径重挂载：/signal/1 → /signal/2 要换实例避免串页，
          但驾驶舱的 ?symbol= 是选中态，query 变化不能重置整个页面。 */}
      <Component key={router.asPath.split('?')[0]} {...pageProps} />
      {vercelInsights ? <SpeedInsights /> : null}
    </ThemeProvider>
  );
}
