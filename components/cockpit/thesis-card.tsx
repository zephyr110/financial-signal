import type { ThesisView } from '@/lib/cockpit/types'
import { formatTime } from '@/lib/cockpit/format'
import { ThesisTag } from './bits'

export function ThesisCard({ thesis }: { thesis: ThesisView }) {
  return (
    <article className="ck-card ck-thesis-card">
      <div className="ck-thesis-top">
        <span className="ck-thesis-code">{thesis.code} · {thesis.name}</span>
        <ThesisTag status={thesis.status} />
      </div>
      <h3 className="ck-thesis-title">{thesis.title}</h3>
      <p className="ck-thesis-claim">{thesis.claim}</p>
      <div className="ck-thesis-invalidation">
        <span className="ck-thesis-invalidation-label">失效条件</span>
        {thesis.invalidation.length > 0 ? (
          <ul>
            {thesis.invalidation.map((condition) => (
              <li key={condition}>{condition}</li>
            ))}
          </ul>
        ) : (
          <p className="ck-form-error" style={{ marginTop: 4 }}>尚未登记失效条件，结论不应升级。</p>
        )}
      </div>
      <div className="ck-thesis-foot">
        <span>
          置信度 {thesis.confidence}
          <span className="ck-sep"> · </span>
          {thesis.lastReviewedAt ? `复核于 ${formatTime(thesis.lastReviewedAt)}` : '尚未复核'}
        </span>
        <span className="ck-thesis-counts">
          <span>支持 {thesis.supportCount}</span>
          <span>反证 {thesis.opposeCount}</span>
          <span className="ck-thesis-horizon">{thesis.horizon}</span>
        </span>
      </div>
    </article>
  )
}
