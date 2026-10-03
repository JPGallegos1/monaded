export default function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="mt-auto border-t border-border px-4 py-6 text-muted-foreground">
      <div className="page-wrap flex flex-col items-center justify-between gap-3 text-center text-[13px] sm:flex-row sm:text-left">
        <p className="m-0">© {year} Monaded · Built for Monad Metropolis</p>
        <a
          href="https://testnet.monadscan.com/address/0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e"
          target="_blank"
          rel="noreferrer"
          className="font-medium text-muted-foreground no-underline hover:text-foreground"
        >
          Contract on Monad testnet ↗
        </a>
      </div>
    </footer>
  )
}
