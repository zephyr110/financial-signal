import { createClient } from '@libsql/client';

const PROBE_TIMEOUT_MS = 5000;

/**
 * 保存 Turso 配置前先连一次：地址或 token 写错会让下次启动直接连不上库，
 * 而设置页是之后唯一能改回来的入口。
 */
export async function probeTurso(url: string, authToken?: string): Promise<void> {
  const client = createClient({ url, authToken });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.execute('SELECT 1'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('连接超时')), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    client.close();
  }
}
