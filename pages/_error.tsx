import type { NextPage, NextPageContext } from 'next'
import { ErrorPage } from '@/components/ErrorPage'

/** 404.tsx / 500.tsx 之外的其它状态码走这里，保证错误页不露出 Next 默认样式。 */
const ErrorRoute: NextPage<{ statusCode: number }> = ({ statusCode }) => (
  <ErrorPage statusCode={statusCode} />
)

ErrorRoute.getInitialProps = async ({ res, err }: NextPageContext) => {
  const statusCode = res?.statusCode ?? (err as { statusCode?: number } | null)?.statusCode ?? 500
  return { statusCode }
}

export default ErrorRoute
