import { useCallback, useEffect, useState } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import { createServerSession, getServerSession, logoutServerSession, type SessionInfo } from './session'

/**
 * Bridge Privy login ↔ backend Durable Object session.
 * Must be rendered under <PrivyAppProvider> when Privy is configured.
 */
export function usePrivySession() {
  const { ready, authenticated, user, login, logout: logoutPrivy, getAccessToken } = usePrivy()
  const { wallets } = useWallets()
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const syncSession = useCallback(async () => {
    if (!authenticated) {
      setSession(null)
      return
    }
    setSyncing(true)
    setError(null)
    try {
      const accessToken = await getAccessToken()
      const identityToken = (user as { identityToken?: string } | null)?.identityToken ?? null
      const created = await createServerSession({
        accessToken: accessToken ?? undefined,
        identityToken,
      })
      setSession(created)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(false)
    }
  }, [authenticated, getAccessToken, user])

  useEffect(() => {
    if (authenticated) void syncSession()
    else setSession(null)
  }, [authenticated, syncSession])

  useEffect(() => {
    void getServerSession().then((s) => {
      if (s.ok) setSession(s)
    })
  }, [])

  const logout = useCallback(async () => {
    await logoutServerSession().catch(() => undefined)
    await logoutPrivy()
    setSession(null)
  }, [logoutPrivy])

  return {
    ready,
    authenticated,
    user,
    wallets,
    session,
    syncing,
    error,
    login,
    logout,
    syncSession,
    walletAddress: session?.walletAddress ?? wallets[0]?.address ?? null,
  }
}
