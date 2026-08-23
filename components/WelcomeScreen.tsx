import { Button } from "./ui/button";

interface WelcomeScreenProps {
  onImport: () => void;
  onSkip: () => void;
  importing: boolean;
  error: string | null;
}

/**
 * 首次启动引导:桌面端 userData 尚无 db 时展示,
 * 提供"导入已有数据库"或"全新开始"(创建空库)两个入口。
 */
export default function WelcomeScreen({
  onImport,
  onSkip,
  importing,
  error,
}: WelcomeScreenProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 shadow-sm">
        <h1 className="text-xl font-semibold">欢迎使用 Financial Signal</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          桌面端使用本地数据库存储新闻与信号分析。你可以导入已有的 news_archive.db，
          或全新开始由应用自动抓取。
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <Button
            type="button"
            onClick={onImport}
            disabled={importing}
            className="py-2"
          >
            {importing ? "导入中…" : "导入已有数据库"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onSkip}
            disabled={importing}
            className="py-2"
          >
            全新开始
          </Button>
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
      </div>
    </div>
  );
}
