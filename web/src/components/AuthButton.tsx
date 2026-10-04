/**
 * Minimal login/logout control. Intentionally unstyled beyond a tiny button so
 * the concurrent Pencil UI rebuild can restyle freely.
 */
import { isPrivyConfigured } from '../lib/privy/config'
import { usePrivySession } from '../lib/privy/usePrivySession'

function PrivyAuthControls() {
  const { ready, authenticated, login, logout, walletAddress, syncing, error } = usePrivySession()
  if (!ready) return <span data-privy-auth="loading">…</span>
  if (!authenticated) {
    return (
      <button type="button" data-privy-auth="login" onClick={() => login()}>
        Log in
      </button>
    )
  }
  return (
    <span data-privy-auth="session" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <span data-privy-wallet title={walletAddress ?? undefined}>
        {syncing ? 'syncing…' : walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : 'signed in'}
      </span>
      <button type="button" data-privy-auth="logout" onClick={() => void logout()}>
        Log out
      </button>
      {error ? <span data-privy-error>{error}</span> : null}
    </span>
  )
}

export default function AuthButton() {
  if (!isPrivyConfigured()) {
    return (
      <span data-privy-auth="unconfigured" title="Set VITE_PRIVY_APP_ID after creating the Privy app">
        Login (Privy not configured)
      </span>
    )
  }
  return <PrivyAuthControls />
}
