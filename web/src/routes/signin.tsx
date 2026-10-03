import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { SignInCard } from '#/components/signin-card'

export const Route = createFileRoute('/signin')({
  component: SignInPage,
  head: () => ({ meta: [{ title: 'Sign in · Monaded' }] }),
})

/**
 * Screen 02 — presentational only.
 * TODO(privy): wire SignInCard callbacks to Privy login (email / Google / X) and redirect after auth.
 */
function SignInPage() {
  const [email, setEmail] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <main className="flex min-h-[calc(100vh-8rem)] items-center justify-center bg-muted/40 px-4 py-16">
      <div className="flex w-full max-w-[420px] flex-col gap-3">
        <SignInCard
          email={email}
          onEmailChange={setEmail}
          onContinueEmail={() =>
            setNotice('TODO(privy): continue with email — Privy login not wired in this PR.')
          }
          onContinueGoogle={() =>
            setNotice('TODO(privy): continue with Google — Privy login not wired in this PR.')
          }
          onContinueX={() =>
            setNotice('TODO(privy): continue with X — Privy login not wired in this PR.')
          }
        />
        {notice && (
          <p className="rounded-md bg-muted px-3 py-2 text-center font-mono text-xs text-muted-foreground">
            {notice}
          </p>
        )}
      </div>
    </main>
  )
}
