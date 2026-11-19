import React from 'react'
import { ArrowUpCircle, CheckCircle2, HelpCircle } from 'lucide-react'
import { Device, Full, UpdateItem } from '../api'
import { ago } from '../format'

/** update items that belong to this device (UniFi OS and its apps share the server's IP) */
export function updatesFor(full: Full, d: Device) {
  return (full.updates || []).filter((u) => (u.mac && u.mac === d.mac) || (u.ip && (u.ip === d.ip || d.ipv4.includes(u.ip))))
}

export function deviceOf(full: Full, u: UpdateItem) {
  return full.devices.find((d) => (u.mac && d.mac === u.mac) || (u.ip && (d.ip === u.ip || d.ipv4.includes(u.ip))))
}

export function UpdateRow({ u, onClick }: { u: UpdateItem; onClick?: () => void }) {
  const st = u.update === true ? 'warn' : u.update === false ? 'ok' : 'dim'
  const Ic = u.update === true ? ArrowUpCircle : u.update === false ? CheckCircle2 : HelpCircle
  return (
    <div className={'upd' + (onClick ? ' click' : '')} onClick={onClick}
      title={[u.note, u.error, u.checked ? 'geprüft ' + ago(u.checked) : ''].filter(Boolean).join(' · ')}>
      <Ic size={17} className={'upd-ic ' + st} />
      <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
        <span className="ell" style={{ fontWeight: 550 }}>{u.name}</span>
        <span className="dim ell" style={{ fontSize: 11.5 }}>
          {u.update === true ? <><span className="mono">{u.current || '?'}</span> → <b className="mono" style={{ color: 'var(--warn)' }}>{u.latest || 'neu'}</b></>
            : <span className="mono">{u.current || '–'}</span>}
          {u.update === false && ' · aktuell'}
          {u.error ? <span style={{ color: 'var(--bad)' }}> · {u.error}</span> : u.note ? ' · ' + u.note : ''}
        </span>
      </div>
      {u.url && <a href={u.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ fontSize: 12 }}>Changelog</a>}
    </div>
  )
}
