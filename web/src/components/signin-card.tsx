import { ShieldCheck } from 'lucide-react'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'

/**
 * Presentational Sign in screen (design 02 v0.2).
 * One primary button opens the Privy modal — email/Google/X live there.
 */
export type SignInCardProps = {
  onSignIn?: () => void
  isLoading?: boolean
  className?: string
}

export function SignInCard({ onSignIn, isLoading, className }: SignInCardProps) {
  return (
    <div className={cn('surface-card shadow-elevated flex w-full max-w-[420px] flex-col gap-4 p-8', className)}>
      <div className="flex justify-center">
        <span className="logo-mark h-10 w-10 rounded-full" aria-hidden />
      </div>
      <div className="text-center">
        <h1 className="font-display text-[22px] font-bold tracking-tight">Sign in to Monaded</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Create, publish and earn from study templates.
        </p>
      </div>

      <Button className="w-full" disabled={isLoading} onClick={onSignIn}>
        {isLoading ? 'Signing in…' : 'Sign in'}
      </Button>

      <div className="flex gap-2 rounded-md bg-muted p-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          We create a secure wallet for you automatically. No seed phrase.
        </p>
      </div>
      <p className="text-center text-xs font-medium text-muted-foreground">Protected by Privy</p>
    </div>
  )
}
