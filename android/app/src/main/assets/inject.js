// Runs in every netdash page before its own scripts (only for the configured server origin).
// Talks to the app through window.NetdashApp (a WebMessageListener restricted to that origin).
(() => {
  if (window.__ndApp) return
  const bridge = window.NetdashApp
  if (!bridge) return
  window.__ndApp = true
  const post = (o) => { try { bridge.postMessage(JSON.stringify(o)) } catch (e) { /* ignore */ } }

  // ---- downloads: WebView cannot save blob: URLs, so keep the Blob objects and hand their bytes to the app
  const blobs = new Map()
  const createURL = URL.createObjectURL
  const revokeURL = URL.revokeObjectURL
  URL.createObjectURL = function (o) {
    const u = createURL.call(URL, o)
    if (o instanceof Blob) blobs.set(u, o)
    return u
  }
  URL.revokeObjectURL = function (u) {
    setTimeout(() => blobs.delete(u), 60000)
    return revokeURL.call(URL, u)
  }
  const saveBlob = (blob, name) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result)
      post({ t: 'save', name: name || 'download', mime: blob.type || '', b64: s.slice(s.indexOf(',') + 1) })
    }
    r.readAsDataURL(blob)
  }
  // also used by the app's DownloadListener fallback
  window.__ndSave = (url, name) => {
    const b = blobs.get(url)
    if (b) { saveBlob(b, name); return true }
    if (url.startsWith('data:')) { fetch(url).then((x) => x.blob()).then((x) => saveBlob(x, name)); return true }
    return false
  }
  const handle = (a) => {
    if (!a || !a.hasAttribute('download')) return false
    const href = a.href || ''
    const name = a.getAttribute('download') || ''
    if (href.startsWith('blob:') || href.startsWith('data:')) return window.__ndSave(href, name)
    if (/^https?:/i.test(href)) { post({ t: 'dl', url: href, name }); return true }
    return false
  }
  const click = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function () {
    if (!handle(this)) return click.call(this)
  }
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[download]') : null
    if (a && handle(a)) e.preventDefault()
  }, true)

  // ---- clipboard: works without a secure context and without WebView permission quirks
  const writeText = (t) => { post({ t: 'copy', text: String(t) }); return Promise.resolve() }
  try {
    if (navigator.clipboard) navigator.clipboard.writeText = writeText
    else Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get: () => ({ writeText }) })
  } catch (e) { /* ignore */ }

  // ---- system bar colors follow the page (dark/light, bottom navigation on phones)
  const rgb = (v) => {
    const d = document.createElement('div')
    d.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;background:' + v
    document.body.appendChild(d)
    const c = getComputedStyle(d).backgroundColor
    d.remove()
    return c
  }
  let lastTheme = ''
  const theme = () => {
    if (!document.body) return
    const cs = getComputedStyle(document.documentElement)
    const m = document.querySelector('.mnav')
    const nav = !!m && getComputedStyle(m).display !== 'none'
    const key = cs.getPropertyValue('--bg') + '|' + cs.getPropertyValue('--bg-2') + '|' + nav
    if (key === lastTheme) return
    lastTheme = key
    post({ t: 'theme', top: rgb('var(--bg)'), bottom: rgb(nav ? 'var(--bg-2)' : 'var(--bg)') })
  }

  // ---- login page: a way back to the server setup
  const loginLink = () => {
    const f = document.querySelector('.login form')
    if (!f || f.querySelector('#nd-app-setup')) return
    const b = document.createElement('button')
    b.type = 'button'
    b.id = 'nd-app-setup'
    b.textContent = 'Anderen Server verbinden'
    b.style.cssText = 'border:0;background:transparent;color:var(--text-3);font:inherit;font-size:12.5px;cursor:pointer;padding:4px;align-self:center'
    b.onclick = () => post({ t: 'setup' })
    f.appendChild(b)
  }

  let scheduled = false
  const tick = () => {
    if (scheduled) return
    scheduled = true
    setTimeout(() => { scheduled = false; theme(); loginLink() }, 300)
  }
  const start = () => {
    tick()
    new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true })
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { lastTheme = ''; tick() })
    addEventListener('resize', tick)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
