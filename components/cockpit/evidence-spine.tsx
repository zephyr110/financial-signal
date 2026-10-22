import type { EvidenceItem, EvidenceKind } from '@/lib/cockpit/types'
import { SourceChip } from './bits'

const KIND_LABEL: Record<EvidenceKind, string> = {
  fact: '事实 FCT',
  inference: '推断 INF',
  counter: '反证 CTR',
  conclusion: '结论 CON',
}

export function EvidenceSpine({ items }: { items: EvidenceItem[] }) {
  return (
    <ol className="ck-spine" aria-label="证据脊柱：事实、推断、反证、结论">
      {items.map((item) => (
        <li className={`ck-spine-item ck-kind-${item.kind}`} key={item.id}>
          <span className="ck-spine-rail" aria-hidden="true">
            <span className="ck-spine-node" />
          </span>
          <div className="ck-spine-body">
            <p className="ck-spine-kind">{KIND_LABEL[item.kind] || item.kind}</p>
            <p className="ck-spine-label">
              {item.label}
              {/* 标签里通常已带数值，只有纯定性标签才补挂 value，避免同一数字出现两次。 */}
              {item.value && !item.label.includes(item.value) && (
                <span className="ck-spine-value">{item.value}</span>
              )}
            </p>
            {item.detail && <p className="ck-spine-detail">{item.detail}</p>}
            {item.source && (
              <div className="ck-spine-source">
                <SourceChip source={item.source} />
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}
