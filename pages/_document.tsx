import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="zh-CN" suppressHydrationWarning>
      <Head>
        <link rel="icon" type="image/png" href="/favicon-light.png" data-app-icon />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="application-name" content="收盘手记" />
        <meta name="apple-mobile-web-app-title" content="收盘手记" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        {/* 通用兜底必须放在媒体查询项之前：后出现的匹配项才会生效。 */}
        <meta name="theme-color" content="#1f5c55" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#edf1ef" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0f1514" />
        {/* 主题预置脚本(防 FOUC):首帧渲染前按 localStorage/system 偏好给 <html> 加 class,
            与 next-themes(attribute="class", storage key "theme")行为一致。 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('theme');var t=(s==='dark'||s==='light')?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.classList.add(t);}catch(e){}})();`,
          }}
        />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
