import { Link } from '@tanstack/react-router'
import { Upload } from 'lucide-react'
import ThemeToggle from '#/components/ThemeToggle'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'

export type NavUser = {
  name?: string | null
  email?: string | null
  avatarUrl?: string | null
} | null

/**
 * Presentational navbar auth slot.
 * Privy wiring (login / logout / wallet) should plug into these props — do not add auth logic here.
 */
export type NavbarAuthProps = {
  user?: NavUser
  onSignIn?: () => void
  onSignOut?: () => void
  isLoading?: boolean
}

const links = [
  { to: '/templates', label: 'Explore', match: 'Explore' as const },
  { to: '/upload', label: 'Create', match: 'Create' as const },
  { to: '/library', label: 'Library', match: 'Library' as const },
  { to: '/dashboard', label: 'Dashboard', match: 'Dashboard' as const },
]

export function Navbar({
  active,
  auth,
  ctaLabel = 'Upload PDF',
  ctaTo = '/upload',
}: {
  active?: 'Explore' | 'Create' | 'Library' | 'Dashboard'
  auth?: NavbarAuthProps
  ctaLabel?: string
  ctaTo?: string
}) {
  const user = auth?.user ?? null

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/90 backdrop-blur-md">
      <nav className="page-wrap flex flex-wrap items-center justify-between gap-4 py-4">
        <div className="flex items-center gap-8">
          <Link to="/" className="inline-flex items-center gap-2.5 no-underline">
            <span className="logo-mark h-7 w-7 rounded-full" aria-hidden />
            <span className="font-display text-xl font-bold tracking-tight text-foreground">Monaded</span>
          </Link>
          <div className="hidden items-center gap-7 md:flex">
            {links.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className={cn(
                  'text-sm font-medium no-underline',
                  active === l.match
                    ? 'font-semibold text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {l.label}
              </Link>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground sm:inline-flex">
            <span className="h-2 w-2 rounded-full bg-success" aria-hidden />
            Monad testnet
          </span>
          <ThemeToggle />
          <Link
            to={ctaTo}
            className="hidden items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground no-underline hover:opacity-90 sm:inline-flex"
          >
            <Upload className="h-4 w-4" />
            {ctaLabel}
          </Link>
          {/* Auth slot — Privy plugs into onSignIn / user / onSignOut */}
          {user ? (
            <button
              type="button"
              onClick={auth?.onSignOut}
              title={user.email ?? user.name ?? 'Signed in'}
              className="avatar-gradient h-8 w-8 rounded-full ring-2 ring-border"
              aria-label="Account"
            />
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={auth?.onSignIn}
              disabled={auth?.isLoading}
            >
              {auth?.isLoading ? 'Signing in…' : 'Sign in'}
            </Button>
          )}
        </div>
      </nav>
    </header>
  )
}

/** Default export keeps __root.tsx simple; auth props can be threaded later via context. */
export default function Header(props: {
  active?: 'Explore' | 'Create' | 'Library' | 'Dashboard'
}) {
  return (
    <Navbar
      active={props.active}
      // TODO(privy): pass real user + onSignIn/onSignOut from Privy provider
      auth={{
        user: null,
        onSignIn: () => {
          // TODO(privy): open Privy login modal
          window.location.href = '/signin'
        },
      }}
    />
  )
}
