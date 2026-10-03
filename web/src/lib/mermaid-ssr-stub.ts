// Server (SSR) stand-in for `mermaid`: diagrams render only in the browser, so the ~2 MB library
// is kept out of the Worker bundle. See vite.config.ts.
export default {
  initialize() {},
  async render(): Promise<{ svg: string }> {
    throw new Error('mermaid is browser-only')
  },
}
