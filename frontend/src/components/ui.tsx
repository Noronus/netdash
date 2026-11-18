import React from 'react'
import {
  ArrowDown, ArrowUp, Box, Cctv, CircleHelp, Cpu, Gamepad2, Gauge, Glasses, HardDrive, House, Laptop, Monitor,
  Network, Plug, Printer, Router, Server, Smartphone, Speaker, Sun, Tablet, Tv, Watch, Wifi,
} from 'lucide-react'
import { rate } from '../format'

export function Card(p: {
  title?: React.ReactNode; icon?: React.ReactNode; act?: React.ReactNode; className?: string
  flush?: boolean; fill?: boolean; onClick?: () => void; children?: React.ReactNode; style?: React.CSSProperties
}) {
  return (
    <section className={'card ' + (p.className || '') + (p.onClick ? ' click' : '')} onClick={p.onClick} style={p.style}>
      {(p.title || p.act) && (
        <div className="card-h">
          {p.icon && <span className="ic">{p.icon}</span>}
          {p.title && <h3>{p.title}</h3>}
          {p.act && <div className="act">{p.act}</div>}
        </div>
      )}
      <div className={'card-b' + (p.flush ? ' flush' : '') + (p.fill ? ' fill' : '')}>{p.children}</div>
    </section>
  )
}

export const Dot = ({ t }: { t?: 'ok' | 'warn' | 'bad' | 'off' }) => <span className={'dot ' + (t || '')} />

export const Badge = ({ t, children }: { t?: 'ok' | 'warn' | 'bad' | 'acc'; children: React.ReactNode }) => (
  <span className={'badge ' + (t || '')}>{children}</span>
)

export function Meter({ value, max = 100, t }: { value: number; max?: number; t?: 'ok' | 'warn' | 'bad' }) {
  const p = Math.max(0, Math.min(100, (100 * (value || 0)) / (max || 1)))
  return <div className={'meter ' + (t || '')}><i style={{ width: p + '%' }} /></div>
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, l]) => (
        <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  )
}

export const ICONS: Record<string, [React.ComponentType<any>, string]> = {
  phone: [Smartphone, 'Smartphone'], tablet: [Tablet, 'Tablet'], laptop: [Laptop, 'Laptop'], desktop: [Monitor, 'PC'],
  tv: [Tv, 'TV / Streaming'], speaker: [Speaker, 'Lautsprecher'], printer: [Printer, 'Drucker'], camera: [Cctv, 'Kamera'],
  server: [Server, 'Server'], nas: [HardDrive, 'NAS'], vm: [Box, 'VM / Container'], router: [Router, 'Router'],
  ap: [Wifi, 'Access Point'], switch: [Network, 'Switch'], iot: [Cpu, 'Smart Home / IoT'], plug: [Plug, 'Steckdose'],
  energy: [Gauge, 'Energiemessung'], solar: [Sun, 'Solar'], game: [Gamepad2, 'Konsole'], vr: [Glasses, 'VR'],
  watch: [Watch, 'Uhr'], homeassistant: [House, 'Home Assistant'], unknown: [CircleHelp, 'Unbekannt'],
}

export function DevIcon({ icon, on, size = 18, lg }: { icon?: string | null; on?: boolean; size?: number; lg?: boolean }) {
  const [C] = ICONS[icon || 'unknown'] || ICONS.unknown
  return <span className={'dev-ic' + (on ? ' on' : '') + (lg ? ' lg' : '')}><C size={lg ? 26 : size} strokeWidth={1.8} /></span>
}

/** Wi-Fi signal (dBm) as 4 bars */
export function Signal({ dbm }: { dbm?: number | null }) {
  if (dbm == null) return null
  const n = dbm >= -55 ? 4 : dbm >= -65 ? 3 : dbm >= -72 ? 2 : 1
  const t = n >= 3 ? '' : n === 2 ? 'warn' : 'bad'
  return (
    <span className={'bars ' + t} title={dbm + ' dBm'}>
      {[5, 8, 11, 14].map((h, i) => <i key={i} className={i < n ? 'on' : ''} style={{ height: h }} />)}
    </span>
  )
}

export function Rate({ v, dir }: { v: number; dir: 'd' | 'u' }) {
  const zero = !v || v < 1
  return (
    <span className={'rate ' + (zero ? 'zero' : dir)}>
      {dir === 'd' ? <ArrowDown size={12} strokeWidth={2.4} /> : <ArrowUp size={12} strokeWidth={2.4} />}
      {zero ? '–' : rate(v)}
    </span>
  )
}

export function Hist({ h }: { h: boolean[] }) {
  return <div className="hist">{h.map((ok, i) => <i key={i} className={ok ? '' : 'f'} />)}</div>
}

export function SrcError({ src, label }: { src?: { ok: boolean; error?: string }; label: string }) {
  if (!src || src.ok) return null
  const msg = src.error === 'not configured' ? 'nicht eingerichtet' : src.error
  return <div className="src-err">⚠ {label}: {msg}</div>
}
