import Header from '#/components/navbar'
import Footer from '#/components/Footer'

export { Header }

/** Re-export for __root.tsx compatibility */
export default function AppChrome({
  children,
  active,
}: {
  children: React.ReactNode
  active?: 'Explore' | 'Create' | 'Library' | 'Dashboard'
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <Header active={active} />
      <div className="flex-1">{children}</div>
      <Footer />
    </div>
  )
}
