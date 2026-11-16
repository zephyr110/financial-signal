import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DocumentSummary } from '@/lib/cockpit/types'
import { DocumentList } from '@/components/cockpit/document-list'

const doc: DocumentSummary = {
  id: 'doc-1',
  title: '关于示例事项的公告',
  publishedAt: '2026-11-16T01:00:00.000Z',
  url: 'https://example.com/doc/1',
  source: { id: 'sse', name: '上海证券交易所', tier: 1, asOf: '2026-11-16', url: 'https://www.sse.com.cn' },
}

describe('DocumentList', () => {
  it('整行链接内不再嵌套来源链接，来源块不会被浏览器解析挪出', () => {
    document.body.innerHTML = renderToStaticMarkup(<DocumentList documents={[doc]} />)
    const row = document.querySelector('a.ck-doc')
    expect(row).not.toBeNull()
    // 嵌套 <a> 会被 HTML 解析器自动闭合，把 .ck-doc-source 挪到整行链接之外
    expect(row?.querySelector('.ck-doc-source')).not.toBeNull()
    expect(row?.querySelectorAll('a')).toHaveLength(0)
  })
})
