import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { SignInCard } from '#/components/signin-card'
import { isPrivyConfigured } from '#/lib/privy/config'
import { usePrivySession } from '#/lib/privy/usePrivySession'

export const Route = createFileRoute('/signin')({
  component: SignInPage,
  head: () => ({ meta: [{ title: 'Sign in · Monaded' }] }),
})

/**
 * Screen 02 v0.2 — single Sign in button opens the Privy modal.
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

  useEffect(() => {
    if (authenticated) {
      void navigate({ to: '/library' })
    }
  }, [authenticated, navigate])

  return (
    <main className="flex min-h-[calc(100vh-8rem)] items-center justify-center bg-muted/40 px-4 py-16">
      <SignInCard
        onSignIn={() => login()}
        isLoading={!ready || syncing}
      />
    </main>
  )
}
