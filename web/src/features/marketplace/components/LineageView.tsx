import { shortAddress } from '../format'
import { useLineage } from '../hooks/useLineage'

/**
 * Lineage: up to 3 ancestors, 10% earn each.
 * Trusted only when TemplatePublished.publisher == relayer (audit L3).
 * Props shape aligns with PR #1 LineageNode (name/role/earn).
 */
export function LineageView({
  onchainTemplateId,
}: {
  onchainTemplateId: number | string | null | undefined
}) {
  const { loading, error, lineage } = useLineage(onchainTemplateId)

  if (!onchainTemplateId) return null
  if (loading) return <p>Loading lineage…</p>
  if (error) return <p style={{ color: 'crimson' }}>{error}</p>
  if (!lineage) return null

  const nodes = [
    {
      name: shortAddress(lineage.creator),
      role: 'Creator of this template',
      earn: 'remainder',
      trusted: true,
    },
    ...lineage.ancestors.map((a) => ({
      name: shortAddress(a.creator),
      role: `Ancestor L${a.level}${a.trusted ? '' : ' · untrusted publish'}`,
      earn: `${a.earnBps / 100}%`,
      trusted: a.trusted,
    })),
  ]

  return (
    <div data-marketplace="lineage" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 16 }}>Royalty lineage</h3>
      {!lineage.fullyTrusted && (
        <p data-marketplace="lineage-warning" style={{ margin: 0, fontSize: 13, color: '#a16207' }}>
          Some ancestors were not published via the official relayer. Anyone can publish copies
          onchain without a parent — treat untrusted rows as unverified claims.
        </p>
      )}
      {lineage.ancestors.length === 0 && (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>Original (no parent).</p>
      )}
      <ol style={{ margin: 0, paddingLeft: 18 }}>
        {nodes.map((n) => (
          <li key={`${n.name}-${n.role}`} style={{ marginBottom: 6 }}>
            <strong>{n.name}</strong> — {n.role} · earns {n.earn}
            {!n.trusted && (
              <span data-marketplace="untrusted-flag" style={{ marginLeft: 6, color: '#a16207' }}>
                [untrusted]
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** Map lineage to PR #1 LineageNodeData[] for drop-in UI. */
export function lineageToNodeData(lineage: NonNullable<ReturnType<typeof useLineage>['lineage']>) {
  return [
    {
      name: shortAddress(lineage.creator),
      role: 'This template · keeps remainder',
      earn: 'remainder',
      highlight: true,
    },
    ...lineage.ancestors.map((a) => ({
      name: shortAddress(a.creator),
      role: a.trusted
        ? `Ancestor L${a.level} · relayer-published`
        : `Ancestor L${a.level} · unverified onchain publish`,
      earn: `${a.earnBps / 100}%`,
      earnMuted: !a.trusted,
    })),
  ]
}
