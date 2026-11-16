import { ErrorPage } from '@/components/ErrorPage'

export default function ServerErrorPage() {
  return <ErrorPage statusCode={500} />
}
