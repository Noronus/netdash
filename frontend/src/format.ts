const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 })
const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 })

/** bytes per second -> bit/s string */
export function rate(bps: number | null | undefined): string {
  const b = (bps || 0) * 8
  if (b < 1000) return nf0.format(b) + ' bit/s'
  if (b < 1e6) return nf1.format(b / 1e3) + ' kbit/s'
  if (b < 1e9) return nf1.format(b / 1e6) + ' Mbit/s'
  return nf1.format(b / 1e9) + ' Gbit/s'
}

export function rateShort(bps: number | null | undefined): [string, string] {
  const b = (bps || 0) * 8
  if (b < 1e3) return [nf0.format(b), 'bit/s']
  if (b < 1e6) return [nf1.format(b / 1e3), 'kbit/s']
  if (b < 1e9) return [nf1.format(b / 1e6), 'Mbit/s']
  return [nf1.format(b / 1e9), 'Gbit/s']
}

export function bytes(n: number | null | undefined): string {
  const v = n || 0
  if (v < 1000) return nf0.format(v) + ' B'
  if (v < 1e6) return nf1.format(v / 1e3) + ' KB'
  if (v < 1e9) return nf1.format(v / 1e6) + ' MB'
  if (v < 1e12) return nf1.format(v / 1e9) + ' GB'
  return nf1.format(v / 1e12) + ' TB'
}

export function num(n: number | null | undefined): string {
  return nf0.format(n || 0)
}

export function pct(n: number | null | undefined, digits = 0): string {
  if (n == null || isNaN(n)) return '–'
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits }).format(n) + ' %'
}

export function dur(sec: number | null | undefined): string {
  if (sec == null || sec < 0) return '–'
  const s = Math.floor(sec)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d} T ${h} Std`
  if (h > 0) return `${h} Std ${m} Min`
  if (m > 0) return `${m} Min`
  return `${s} s`
}

export function since(ts: number | null | undefined): string {
  if (!ts) return '–'
  return dur(Date.now() / 1000 - ts)
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return '–'
  const s = Date.now() / 1000 - ts
  if (s < 60) return 'gerade eben'
  return 'vor ' + dur(s)
}

export function clock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}

export function dateTime(ts: number | null | undefined): string {
  if (!ts) return '–'
  return new Date(ts * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function day(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })
}

export function tone(v: number | null | undefined, warn: number, bad: number): 'ok' | 'warn' | 'bad' {
  const x = v || 0
  return x >= bad ? 'bad' : x >= warn ? 'warn' : 'ok'
}

export function radio(r?: string): string {
  return r === 'na' ? '5 GHz' : r === 'ng' ? '2,4 GHz' : r === '6e' ? '6 GHz' : r || ''
}
