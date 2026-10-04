import { shortAddress, weiToMon } from '../format'
import type { SplitRow } from '../types'

/** Renders previewSplit rows (zeros already filtered). */
export function SplitPreview({ rows }: { rows: SplitRow[] }) {
  if (!rows.length) {
    return <p data-marketplace="split-empty">No split preview.</p>
  }
  return (
    <ul data-marketplace="split-preview" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {rows.map((r) => (
        <li
          key={`${r.recipient}-${r.amount.toString()}`}
          style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}
        >
          <span>
            {r.role} · {shortAddress(r.recipient)}
          </span>
          <span style={{ fontFamily: 'monospace' }}>{weiToMon(r.amount)} MON</span>
        </li>
      ))}
    </ul>
  )
}
