let pendingOperations = 0
let splash: HTMLDivElement | undefined
let previousFocus: HTMLElement | null = null
let wasInert = false

export async function withLoading<T>(operation: () => T | Promise<T>): Promise<T> {
  const app = document.querySelector<HTMLElement>('#app')
  if (!splash) {
    splash = document.createElement('div')
    splash.className = 'loading-splash'
    splash.hidden = true
    splash.tabIndex = -1
    splash.setAttribute('role', 'status')
    splash.setAttribute('aria-live', 'polite')
    splash.innerHTML = `
      <span class="material-symbols-outlined loading-spinner" aria-hidden="true">refresh</span>
      <span class="loading-brand">Deck Studio</span>
      <span class="loading-description">Carregando, aguarde…</span>
    `
    document.body.append(splash)
  }

  if (pendingOperations++ === 0) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    wasInert = app?.inert ?? false
    splash.hidden = false
    splash.focus({ preventScroll: true })
    if (app) {
      app.inert = true
      app.setAttribute('aria-busy', 'true')
    }
  }

  try {
    // Allow the overlay to paint before serialization or other synchronous work.
    await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
    return await operation()
  } finally {
    if (--pendingOperations === 0) {
      splash.hidden = true
      if (app) {
        app.inert = wasInert
        app.removeAttribute('aria-busy')
      }
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
      previousFocus = null
    }
  }
}
