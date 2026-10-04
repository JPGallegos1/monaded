import { createFileRoute, Link } from '@tanstack/react-router'
import { useLibraryLicenses } from '#/features/marketplace'
import { usePrivySession } from '#/lib/privy/usePrivySession'
import AuthButton from '#/components/AuthButton'

export const Route = createFileRoute('/library')({
  component: LibraryPage,
  head: () => ({ meta: [{ title: 'Library · edtech-monad' }] }),
})

/**
 * Licenses owned by the session wallet (onchain hasLicense — not the purchases table).
 */
function LibraryPage() {
  const { ready, authenticated, walletAddress } = usePrivySession()
  const { loading, error, owned } = useLibraryLicenses(authenticated ? walletAddress : null)

  return (
    <main className="page-wrap px-4 pb-8 pt-14" data-marketplace="library">
      <h1 className="mb-2 text-3xl font-bold">Your library</h1>
      <p className="mb-6 text-sm opacity-80">
        Templates your wallet holds a license for. Licenses are transferable ERC-1155 — onchain
        balance is the source of truth.
      </p>

      {!ready ? (
        <p>Loading auth…</p>
      ) : !authenticated ? (
        <div className="flex flex-col gap-2 text-sm">
          <p>Log in to see licenses for your embedded wallet.</p>
          <AuthButton />
        </div>
      ) : (
        <>
          <p className="mb-4 text-xs opacity-70" style={{ wordBreak: 'break-all' }}>
            Wallet: {walletAddress}
          </p>
          {loading && <p className="text-sm">Checking onchain licenses…</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {!loading && owned.length === 0 && (
            <p className="text-sm">
              No licenses yet.{' '}
              <Link to="/templates">Browse the marketplace</Link>
            </p>
          )}
          {owned.length > 0 && (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" style={{ listStyle: 'none', padding: 0 }}>
              {owned.map((t) => (
                <li key={t.id} className="island-shell rounded-2xl p-5">
                  <h2 className="mb-2 text-base font-semibold">
                    <Link
                      to="/templates/$templateId"
                      params={{ templateId: t.id }}
                      className="no-underline text-inherit"
                    >
                      {t.title}
                    </Link>
                  </h2>
                  <p className="m-0 text-sm opacity-75">
                    License #{String(t.onchain_token_id)}
                    {t.price_mon != null && <> · listed {t.price_mon} MON</>}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  )
}
