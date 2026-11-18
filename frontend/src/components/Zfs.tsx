import React, { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Database, RefreshCw, X } from 'lucide-react'
import { api } from '../api'
import { Badge, Meter } from './ui'
import { bytes, tone } from '../format'

type Ds = { name: string; used: number; avail: number; refer: number; snap: number; child: number; ratio: number; quota: number | null; type: string; mount: string | null }
type Pool = { name: string; health: string; frag: number | null; cap: number; raw_size: number; raw_alloc: number; used: number; total: number; datasets: Ds[] }

/** popup with ZFS pools and the space used per dataset on the Unraid server */
export default function ZfsDialog({ onClose, title }: { onClose: () => void; title?: string }) {
  const [d, setD] = useState<{ t: number; pools: Pool[] } | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const load = (force = false) => {
    setBusy(true); setErr('')
    api<{ t: number; pools: Pool[] }>('/api/unraid/zfs' + (force ? '?force=1' : '')).then(setD).catch((e) => setErr(e.message)).finally(() => setBusy(false))
  }
  useEffect(() => {
    load()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  function rows(pool: Pool, parent: string, depth: number): React.ReactNode[] {
    const kids = pool.datasets.filter((x) => x.name.slice(0, x.name.lastIndexOf('/')) === parent).sort((a, b) => b.used - a.used)
    return kids.flatMap((x) => {
      const hasKids = pool.datasets.some((y) => y.name.startsWith(x.name + '/'))
      const open = !closed[x.name]
      const short = x.name.slice(parent.length + 1)
      const share = (100 * x.used) / pool.total
      return [
        <tr key={x.name} style={{ cursor: hasKids ? 'pointer' : 'default' }} onClick={() => hasKids && setClosed((c) => ({ ...c, [x.name]: open }))}>
          <td>
            <div className="row" style={{ gap: 4, paddingLeft: depth * 18 }}>
              <span style={{ width: 14, display: 'inline-flex' }}>{hasKids && (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}</span>
              <b className="ell" title={x.name}>{short}</b>
              {x.type === 'volume' && <Badge>zvol</Badge>}
            </div>
          </td>
          <td style={{ width: '24%', minWidth: 120 }}><Meter value={x.used} max={pool.total} t={share > 50 ? 'warn' : undefined} /></td>
          <td className="r num"><b>{bytes(x.used)}</b></td>
          <td className="r num dim">{share >= 0.1 ? share.toLocaleString('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + ' %' : '< 0,1 %'}</td>
          <td className="r num dim" title="belegt durch Snapshots">{x.snap ? bytes(x.snap) : '–'}</td>
          <td className="r num dim" title="Kompressionsfaktor">{x.ratio.toLocaleString('de-DE', { minimumFractionDigits: 2 })}×</td>
          <td className="r num dim">{x.quota ? bytes(x.quota) : '–'}</td>
          <td className="mono dim ell" style={{ fontSize: 11.5, maxWidth: 220 }} title={x.mount || ''}>{x.mount || '–'}</td>
        </tr>,
        ...(hasKids && open ? rows(pool, x.name, depth + 1) : []),
      ]
    })
  }

  return (
    <div className="modal-wrap" style={{ zIndex: 95 }} onClick={onClose}>
      <div className="modal" style={{ width: 'min(1080px, 100%)', maxHeight: '88vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ gap: 8 }}>
          <Database size={16} />
          <b className="grow">{title || 'Unraid'} · ZFS-Speicher</b>
          {d && <span className="dim" style={{ fontSize: 12 }}>Stand {new Date(d.t * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
          <button className="icon-btn" title="neu laden" disabled={busy} onClick={() => load(true)}><RefreshCw size={14} /></button>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        {err && <div className="err">{err}</div>}
        {!d && !err && <div className="dim">Lade …</div>}
        {d?.pools.map((p) => {
          const pc = (100 * p.used) / p.total
          return (
            <div key={p.name} className="col" style={{ gap: 6, marginTop: 6 }}>
              <div className="row wrap" style={{ gap: 10 }}>
                <b style={{ fontSize: 15 }}>{p.name}</b>
                <Badge t={p.health === 'ONLINE' ? 'ok' : 'bad'}>{p.health}</Badge>
                <span className="num">{bytes(p.used)} <span className="dim">von {bytes(p.total)} nutzbar · frei {bytes(p.total - p.used)}</span></span>
                <span className="grow" />
                <span className="dim" style={{ fontSize: 12 }} title="zpool list: Rohkapazität inkl. Parität">roh {bytes(p.raw_alloc)} / {bytes(p.raw_size)} · Fragmentierung {p.frag ?? '–'} %</span>
              </div>
              <Meter value={p.used} max={p.total} t={tone(pc, 80, 90)} />
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Dataset</th><th></th><th className="r">Belegt</th><th className="r">Anteil</th><th className="r">Snapshots</th><th className="r">Kompr.</th><th className="r">Quota</th><th>Mountpoint</th></tr></thead>
                  <tbody>{rows(p, p.name, 0)}</tbody>
                </table>
              </div>
            </div>
          )
        })}
        <div className="dim" style={{ fontSize: 12 }}>„Belegt“ enthält Unter-Datasets und Snapshots. Klick auf eine Zeile mit Pfeil klappt die Unter-Datasets ein oder aus.</div>
      </div>
    </div>
  )
}
