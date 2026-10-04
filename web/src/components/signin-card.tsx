import { ShieldCheck } from 'lucide-react'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { cn } from '#/lib/utils'

/**
 * Presentational Sign in screen (design 02).
 * No Privy / wallet logic — callers wire continue callbacks to Privy login.
 */
export type SignInCardProps = {
  email?: string
  onEmailChange?: (email: string) => void
  onContinueEmail?: () => void
  onContinueGoogle?: () => void
  onContinueX?: () => void
  isLoading?: boolean
  className?: string
}

export function SignInCard({
  email = '',
  onEmailChange,
  onContinueEmail,
  onContinueGoogle,
  onContinueX,
  isLoading,
  className,
}: SignInCardProps) {
  return (
    <div className={cn('surface-card shadow-elevated w-full max-w-[420px] p-8', className)}>
      <div className="mb-4 flex justify-center">
        <span className="logo-mark h-10 w-10 rounded-full" aria-hidden />
      </div>
      <div className="mb-6 text-center">
        <h1 className="font-display text-[22px] font-bold tracking-tight">Sign in to Monaded</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Create, publish and earn from study templates.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <Input
          label="Email"
          type="email"
          placeholder="you@university.edu"
          value={email}
          onChange={(e) => onEmailChange?.(e.target.value)}
          disabled={isLoading}
        />
        <Button
          className="w-full"
          disabled={isLoading || !email}
          onClick={onContinueEmail}
        >
          Continue with email
        </Button>

        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">or</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <Button variant="secondary" className="w-full" disabled={isLoading} onClick={onContinueGoogle}>
          Continue with Google
        </Button>
        <Button variant="secondary" className="w-full" disabled={isLoading} onClick={onContinueX}>
          Continue with X
        </Button>

        <div className="flex gap-2 rounded-md bg-muted p-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            We create a secure wallet for you automatically. No seed phrase, no extensions.
          </p>
        </div>
        <p className="text-center text-xs font-medium text-muted-foreground">Protected by Privy</p>
      </div>
    </div>
  )
}
