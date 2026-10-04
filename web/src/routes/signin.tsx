import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { SignInCard } from '#/components/signin-card'
import { isPrivyConfigured } from '#/lib/privy/config'
import { usePrivySession } from '#/lib/privy/usePrivySession'

export const Route = createFileRoute('/signin')({
  component: SignInPage,
  head: () => ({ meta: [{ title: 'Sign in · Monaded' }] }),
})

/**
 * Screen 02 — SignInCard wired to Privy login (#2).
 * Google / X open the same Privy modal; enable those methods in the Privy dashboard.
 */
function SignInPage() {
  if (!isPrivyConfigured()) {
    return (
      <main className="flex min-h-[calc(100vh-8rem)] items-center justify-center px-4 py-16">
        <p className="text-sm text-muted-foreground">
          Set VITE_PRIVY_APP_ID to enable sign-in.
        </p>
      </main>
    )
  }
  return <SignInAuthed />
}

function SignInAuthed() {
  const navigate = useNavigate()
  const { ready, authenticated, login, syncing } = usePrivySession()
  const [email, setEmail] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (authenticated) {
      void navigate({ to: '/library' })
    }
  }, [authenticated, navigate])

  const startLogin = () => {
    setNotice(null)
    login()
  }

  return (
    <main className="flex min-h-[calc(100vh-8rem)] items-center justify-center bg-muted/40 px-4 py-16">
      <div className="flex w-full max-w-[420px] flex-col gap-3">
        <SignInCard
          email={email}
          onEmailChange={setEmail}
          onContinueEmail={startLogin}
          onContinueGoogle={startLogin}
          onContinueX={startLogin}
          isLoading={!ready || syncing}
        />
        {notice && (
          <p className="rounded-md bg-muted px-3 py-2 text-center font-mono text-xs text-muted-foreground">
            {notice}
          </p>
        )}
        {!ready && (
          <p className="text-center text-xs text-muted-foreground">Loading Privy…</p>
        )}
      </div>
    </main>
  )
}
