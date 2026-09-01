import { SpeedInsights } from "@vercel/speed-insights/next";
import { ThemeProvider } from "next-themes";
import { useRouter } from "next/router";
import DynamicFavicon from "@/components/DynamicFavicon";
import "../styles/globals.css";

export default function App({ Component, pageProps }) {
  const router = useRouter();
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <DynamicFavicon />
      {/* key=asPath:客户端导航时强制 remount 页面组件。否则 /signal/1 → /signal/2
          复用同一实例,useState 保留旧 id 的 ssgData,详情页显示旧数据(串页)。 */}
      <Component key={router.asPath} {...pageProps} />
      <SpeedInsights />
    </ThemeProvider>
  );
}
