import Head from 'next/head'
import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/button'

/**
 * 404/500 共用外壳：不经过 AppShell，避免错误状态下再查一次数据库把异常放大。
 * 视觉沿用驾驶舱的卡片、品牌块与主色按钮。
 */

interface ErrorCopy {
  title: string
  description: string
}

function copyOf(statusCode: number): ErrorCopy {
  if (statusCode === 404) {
    return {
      title: '页面不存在',
      description: '这个地址没有对应的页面。链接可能已经失效，或者记录已被删除。',
    }
  }
  return {
    title: '服务暂时不可用',
    description: '这次请求没有完成。可以重新加载；如果反复出现，请确认本地服务与数据库仍在运行。',
  }
}

export function ErrorPage({ statusCode }: { statusCode: number }) {
  const copy = copyOf(statusCode)
  return (
    <>
      <Head>
        <title>{`${copy.title} · 财经信号`}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground sm:px-6">
        <section className="w-full max-w-[440px] rounded-xl border border-border bg-card p-6 shadow-[0_12px_32px_-16px_rgb(0_0_0/0.25)] sm:p-8">
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="" aria-hidden="true" className="size-7 shrink-0 invert dark:invert-0" />
            <span className="flex min-w-0 flex-col">
              <span className="text-[15px] font-semibold leading-5 tracking-tight">财经信号</span>
              <span className="text-[10px] font-medium uppercase leading-3 tracking-[0.16em] text-muted-foreground">
                Financial Signal
              </span>
            </span>
          </div>

          <p className="mt-8 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            错误 {statusCode}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{copy.title}</h1>
          <p className="mt-2.5 text-sm leading-7 text-muted-foreground">{copy.description}</p>

          <div className="mt-7 flex flex-wrap gap-2.5">
            {statusCode === 404 ? (
              <>
                <Link href="/today" className={buttonVariants({ size: 'lg' })}>回到今日</Link>
                <Link href="/watchlist" className={buttonVariants({ variant: 'outline', size: 'lg' })}>查看自选</Link>
              </>
            ) : (
              <>
                <Button size="lg" type="button" onClick={() => window.location.reload()}>重新加载</Button>
                <Link href="/today" className={buttonVariants({ variant: 'outline', size: 'lg' })}>回到今日</Link>
              </>
            )}
          </div>
        </section>
      </main>
    </>
  )
}
