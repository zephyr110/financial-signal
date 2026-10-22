import type { DocumentSummary } from '@/lib/cockpit/types'
import { formatTime } from '@/lib/cockpit/format'
import { EmptyState, SourceChip } from './bits'

function DocumentBody({ doc }: { doc: DocumentSummary }) {
  return (
    <>
      <div className="ck-doc-head">
        <span className="ck-doc-title">{doc.title}</span>
      </div>
      <div className="ck-doc-meta">
        {doc.issuer && <span>{doc.issuer}</span>}
        {doc.documentNo && <span>{doc.documentNo}</span>}
        {doc.subjectCode && <span>{doc.subjectCode}</span>}
        {doc.publishedAt && <span>{doc.publishedAt.slice(0, 10)} {formatTime(doc.publishedAt)}</span>}
        {doc.status && <span>{doc.status}</span>}
      </div>
      <div className="ck-doc-source">
        <SourceChip source={doc.source} />
      </div>
    </>
  )
}

export function DocumentList({
  documents,
  emptyText = '当前没有已入库的政策或公告。',
}: {
  documents: DocumentSummary[]
  emptyText?: string
}) {
  if (documents.length === 0) {
    return <EmptyState title="暂无文档">{emptyText}</EmptyState>
  }
  return (
    <div className="ck-card ck-doc-list">
      {documents.map((doc) => (
        doc.url ? (
          <a className="ck-doc" href={doc.url} target="_blank" rel="noreferrer" key={doc.id}>
            <DocumentBody doc={doc} />
          </a>
        ) : (
          <div className="ck-doc" key={doc.id}>
            <DocumentBody doc={doc} />
          </div>
        )
      ))}
    </div>
  )
}
