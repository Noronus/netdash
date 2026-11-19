import { useSyncExternalStore } from 'react'

export type Wifi = {
  essid?: string; ap?: string | null; ap_mac?: string; radio?: string; channel?: number; signal?: number; rssi?: number
  satisfaction?: number; tx_rate?: number; rx_rate?: number; uptime?: number; assoc_time?: number; proto?: string; guest?: boolean
}

export type Device = {
  mac: string; name: string; custom_name?: string | null; hostname?: string | null; vendor?: string | null
  icon?: string | null; icon_auto: string; ip?: string | null; ipv4: string[]; ipv6: string[]
  netif?: string | null; network?: string | null; networks?: string[]
  online: boolean; online_since?: number | null; connected_since?: number | null
  first_seen?: number; last_seen?: number; dhcp?: 'static' | 'dynamic' | null; lease_expire?: number | null
  private_mac?: boolean
  up: number; down: number; conns: number
  today_up: number; today_down: number; month_up: number; month_down: number
  dns_q24: number; dns_b24: number
  link: 'wifi' | 'wired' | 'unknown'; wifi?: Wifi | null
  switch?: { mac?: string; port?: number; name?: string } | null; infra?: string
  attach?: Attach | null
  place?: { kind: 'switch' | 'via' | 'firewall'; port?: string; via_mac?: string; iface?: string } | null
  wan_side?: boolean
  blocked?: boolean
}

export type Attach = {
  kind: 'switch' | 'wifi' | 'firewall'; switch?: string; port?: string | null; descr?: string; speed?: number | null
  media?: string; via?: string | null; via_mac?: string | null; stale?: number | null
  ap?: string | null; ap_mac?: string; ssid?: string; iface?: string | null; note?: string; manual?: boolean; wan?: boolean
}

export type SwPort = {
  idx: number; name: string; descr: string; up: boolean; speed: number | null; media: string; type: string; admin: boolean; form?: 'sfp' | 'rj45'
  admin_speed?: string; vlans: string; vlan_mode: number; lldp: { name: string; mac: string; port_id: string }[]
  macs: { mac: string; vlan: number; stale?: number }[]
}
export type SwitchInfo = { name: string; model: string; mac: string; ip: string; fw: string; uptime: string; serial: string; ports: SwPort[]; uplink?: string | null; unsaved?: boolean }

export type Iface = {
  device: string; ifname: string; descr: string; nets: string[]; wan: boolean
  rx: number; tx: number; today_rx: number; today_tx: number; month_rx: number; month_tx: number
  status?: string; media?: string; addr4?: string; addr6?: string; vlan?: number | string
  kind: 'wan' | 'port' | 'net' | 'vlan' | 'vpn' | 'loopback'; netif: string; parent?: string | null
  children?: string[]; port_of?: string; untagged?: boolean
}

export type Source = { ok: boolean; updated?: number; error?: string; failed?: number }

export type Full = {
  t: number; version: string
  sources: Record<string, Source>
  system?: {
    model: string; cores: number; os: string; cpu: number | null; cpu_hist: [number, number][]; load: number[]
    boot: number; uptime: number; mem_total: number; mem_used: number; arc: number
    temps: { sensor: string; c: number }[]; disk_total: number; disk_used: number; pf_states: number
  }
  gateways?: { name: string; address: string; status: string; status_translated: string; loss: string; delay: string; stddev: string; monitor: string }[]
  services?: { id: string; name: string; description: string; running: number; locked: number }[]
  wireguard?: any[]
  netbird?: { ip?: string; fqdn?: string; management?: boolean; signal?: boolean; version?: string; peers: NbPeer[] }
  gatus?: GatusEp[]
  unraid?: {
    hostname: string; boot: string; cpu_model: string; threads: number; cpu: number; ip?: string; zfs?: boolean
    mem: { total: number; used: number; available: number; percentTotal: number; swapTotal: number; swapUsed: number }
    array_state: string
    pools: { name: string; size: number; temp: number | null; status?: string; fs_size: number | null; fs_used: number | null }[]
    containers: { name: string; state: string; status: string; auto: boolean; image: string }[]
  }
  unifi_devices?: any[] | null
  adguard?: {
    protection: boolean; version: string; queries: number; blocked: number; avg_ms: number
    series_q: number[]; series_b: number[]
    top_domains: [string, number][]; top_blocked: [string, number][]; top_clients: [string, number][]
  }
  dns_top?: { domains: [string, number][]; blocked: [string, number][]; clients: [string, number, number][]; unique: number; hidden: string[] }
  switch?: SwitchInfo | null
  own_ips?: string[]
  vps_ifaces?: VpsIf[]
  setup?: { opnsense_api: boolean }
  vps?: any
  wlans?: { id: string; name: string; enabled: boolean; hidden: boolean; security: string; wpa: string; bands: string[]; guest: boolean; has_pass: boolean }[] | null
  wifi_blocked?: string[] | null
  interfaces: Iface[]
  devices: Device[]
  pf_states?: number
  updates?: UpdateItem[] | null
}

/** firmware / software update state of one infrastructure part (backend/updates.py); update null = unknown */
export type UpdateItem = {
  id: string; name: string; kind: string; current?: string | null; latest?: string | null; update: boolean | null
  note?: string | null; mac?: string | null; ip?: string | null; checked?: number; error?: string | null; url?: string | null; own?: boolean
}

export type NbPeer = { name: string; fqdn: string; ip: string; status: string; type: string; latency_ms: number; rx: number; tx: number; handshake?: string | null; since?: string }
export type GatusEp = { key: string; name: string; group: string; ok: boolean | null; uptime: number | null; ms: number | null; hist: boolean[]; t?: string; errors?: string[] }

export type Detail = {
  device: Device
  live: [number, number, number][]
  hours: { hour: number; up: number; down: number }[]
  days: { day: number; up: number; down: number }[]
  dns: {
    top: [string, number][]; top_blocked: [string, number][]
    hours: { hour: number; q: number; b: number }[]
    recent: { t: number; domain: string; type: string; blocked: boolean; ip: string }[]
  }
  unifi?: any
}

export type VpsIf = {
  name: string; kind: 'public' | 'wireguard' | 'netbird' | 'docker' | 'loopback' | 'other'; label: string; state: string; mtu: number
  addrs: string[]; rx: number; tx: number; rx_total: number; tx_total: number; rx_drop: number; tx_drop: number; t: number
  today_rx: number; today_tx: number; month_rx: number; month_tx: number
}

type Store = {
  auth: 'unknown' | 'no' | 'yes'
  user?: string
  full?: Full
  ifHist: Record<string, [number, number, number][]>
  cpuHist: [number, number][]
  connected: boolean
  tick: number
}

let store: Store = { auth: 'unknown', ifHist: {}, cpuHist: [], connected: false, tick: 0 }
const subs = new Set<() => void>()
const set = (p: Partial<Store>) => { store = { ...store, ...p, tick: store.tick + 1 }; subs.forEach((f) => f()) }

export function useStore() {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb) }, () => store)
}

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-ND': '1', ...(opts.headers || {}) },
  })
  if (r.status === 401) {
    set({ auth: 'no' })
    throw new Error('auth')
  }
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j as T
}

let es: EventSource | null = null
const HIST_MAX = 450

function onFast(f: { t: number; dev: Record<string, [number, number]>; if: Record<string, [number, number]>; cpu: number | null; sw?: Record<string, [boolean, number | null]> }) {
  const full = store.full
  if (!full) return
  const devices = full.devices.map((d) => {
    const r = f.dev[d.mac]
    return r ? { ...d, up: r[0], down: r[1] } : (d.up || d.down ? { ...d, up: 0, down: 0 } : d)
  })
  const interfaces = full.interfaces.map((i) => {
    const r = f.if[i.device]
    return r ? { ...i, rx: r[0], tx: r[1] } : i
  })
  const ifHist = { ...store.ifHist }
  for (const [n, r] of Object.entries(f.if)) {
    const h = (ifHist[n] || []).concat([[Math.round(f.t), r[0], r[1]]])
    ifHist[n] = h.length > HIST_MAX ? h.slice(h.length - HIST_MAX) : h
  }
  const cpuHist = f.cpu == null ? store.cpuHist : store.cpuHist.concat([[Math.round(f.t), f.cpu]]).slice(-HIST_MAX)
  // switch link state comes with every fast tick (polled every 5 s on the box)
  let sw = full.switch
  if (sw && f.sw && sw.ports.some((p) => f.sw![p.name] && (f.sw![p.name][0] !== p.up || f.sw![p.name][1] !== p.speed))) {
    sw = { ...sw, ports: sw.ports.map((p) => (f.sw![p.name] ? { ...p, up: f.sw![p.name][0], speed: f.sw![p.name][1] } : p)) }
  }
  set({ full: { ...full, devices, interfaces, switch: sw, system: full.system ? { ...full.system, cpu: f.cpu } : full.system }, ifHist, cpuHist })
}

export async function start() {
  try {
    const me = await api<{ user: string }>('/api/me')
    set({ auth: 'yes', user: me.user })
  } catch {
    if (store.auth !== 'no') set({ auth: 'no' })
    return
  }
  try {
    const [full, hist] = await Promise.all([api<Full>('/api/state'), api<any>('/api/history')])
    set({ full, ifHist: hist.interfaces || {}, cpuHist: hist.cpu || [] })
  } catch { /* handled by auth */ }
  es?.close()
  es = new EventSource('/api/events')
  es.addEventListener('full', (e) => {
    const full: Full = JSON.parse((e as MessageEvent).data)
    // VPS interfaces are polled every 10 s on the box and only arrive with the full update
    const ifHist = { ...store.ifHist }
    for (const v of full.vps_ifaces || []) {
      const k = 'vps:' + v.name
      const h = ifHist[k] || []
      if (!h.length || h[h.length - 1][0] < v.t) ifHist[k] = h.concat([[v.t, v.rx, v.tx]]).slice(-HIST_MAX)
    }
    set({ full, ifHist, connected: true })
  })
  es.addEventListener('fast', (e) => onFast(JSON.parse((e as MessageEvent).data)))
  es.onerror = () => {
    set({ connected: false })
    fetch('/api/me', { credentials: 'same-origin' }).then((r) => { if (r.status === 401) { es?.close(); set({ auth: 'no' }) } })
  }
}

export async function login(user: string, pass: string) {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, pass }) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || 'Login fehlgeschlagen')
  await start()
}

export async function logout() {
  try { await api('/api/logout', { method: 'POST' }) } catch { /* ignore */ }
  es?.close()
  set({ auth: 'no', full: undefined })
}

/** fetch the full state now instead of waiting for the next live update */
export async function refreshState() {
  const full = await api<Full>('/api/state')
  set({ full })
}

export async function hideDomain(domain: string, hidden = true) {
  await api('/api/dns/hidden', { method: 'POST', body: JSON.stringify({ domain, hidden }) })
  const full = await api<Full>('/api/state')
  set({ full })
}

export async function saveDevice(mac: string, fields: { name?: string | null; icon?: string | null; note?: string | null; place?: any }) {
  await api('/api/device/' + mac, { method: 'POST', body: JSON.stringify(fields) })
  const full = await api<Full>('/api/state')
  set({ full })
}
