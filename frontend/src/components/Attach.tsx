import React from 'react'
import { Cable, Router, Server, Wifi } from 'lucide-react'
import { Device } from '../api'
import { Signal } from './ui'

export function speedLabel(s?: number | null) {
  if (!s) return ''
  return s >= 1000 ? (s / 1000).toString().replace('.', ',') + 'G' : s + 'M'
}

export function speedColor(s?: number | null) {
  if (!s) return 'var(--text-3)'
  if (s >= 10000) return 'var(--violet)'
  if (s >= 2500) return 'var(--accent)'
  if (s >= 1000) return 'var(--ok)'
  return 'var(--warn)'
}

/** short "where is it plugged in" cell */
export default function AttachCell({ d, long }: { d: Device; long?: boolean }) {
  const a = d.attach
  if (!a) return <span className="dim">{d.online ? 'unbekannt' : ''}</span>
  if (a.kind === 'wifi') return (
    <span className="row gap6" title={`${a.ssid} über ${a.ap}${a.port ? ' (Switch ' + a.port + ')' : ''}`}>
      <Signal dbm={d.wifi?.signal} /><span className="ell" style={{ maxWidth: long ? 300 : 150 }}>{a.ssid}{long && a.ap ? <span className="dim"> · {a.ap}</span> : null}</span>
    </span>
  )
  if (a.kind === 'switch') return (
    <span className="row gap6" title={`${a.switch} Port ${a.port}${a.descr ? ' („' + a.descr + '“)' : ''}${a.via ? ' über ' + a.via : ''}${a.stale ? ' (zuletzt gesehen)' : ''}`}>
      {a.via ? <Server size={14} className="dim" /> : <Cable size={14} className="dim" />}
      <span>{a.via ? <>über <b style={{ fontWeight: 550 }}>{a.via}</b> · </> : null}{a.port}</span>
      {a.speed ? <span className="badge" style={{ color: speedColor(a.speed), padding: '1px 6px' }}>{speedLabel(a.speed)}</span> : null}
      {long && a.descr && !a.via ? <span className="dim">„{a.descr}“</span> : null}
      {a.stale ? <span className="dim" style={{ fontSize: 11 }}>zuletzt</span> : null}
    </span>
  )
  return <span className="row gap6 dim"><Router size={14} />OPNsense{a.iface ? ' · ' + a.iface : ''}</span>
}

export const AttachIcon = { Wifi }
