/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_PRIVY_APP_ID?: string
  readonly VITE_MARKETPLACE_ADDRESS?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
