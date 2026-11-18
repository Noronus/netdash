import React, { useMemo, useState } from 'react'
import { Cable, Wifi } from 'lucide-react'
import { Device, Full } from '../api'
import { go } from '../App'
import { Card, DevIcon, Rate, Seg, Signal } from '../components/ui'
import AttachCell from '../components/Attach'
import { ago, bytes, num, radio, since } from '../format'

type Col = 'name' | 'ip' | 'network' | 'down' | 'up' | 'today' | 'month' | 'dns' | 'since'

const ipKey = (ip?: string | null) => (ip || '999.999.999.999').split('.').map((x) => x.padStart(3, '0')).join('.')

export function linkCell(d: Device) {
  if (d.link === 'wifi' && d.wifi) {
    return (
      <span className="row gap6" title={`${d.wifi.ap || ''} · ${radio(d.wifi.radio)} · Kanal ${d.wifi.channel}`}>
        <Signal dbm={d.wifi.signal} /><span className="ell" style={{ maxWidth: 130 }}>{d.wifi.essid}</span>
      </span>
    )
  }
  if (d.link === 'wired') return <span className="row gap6 dim"><Cable size={14} />{d.switch?.name ? `${d.switch.name}${d.switch.port ? ' · Port ' + d.switch.port : ''}` : 'LAN'}</span>
  return <span className="dim">{d.online ? '–' : ''}</span>
}

export default function Devices({ full, q }: { full: Full; q?: string }) {
  const [status, setStatus] = useState<'online' | 'all' | 'offline'>('online')
  const [link, setLink] = useState<'all' | 'wifi' | 'wired'>('all')
  const [net, setNet] = useState<string>('')
  const [sort, setSort] = useState<[Col, 1 | -1]>(['down', -1])
  const nets = useMemo(() => [...new Set(full.devices.map((d) => d.network).filter(Boolean))].sort() as string[], [full.devices.length])
  let query = (q || '').trim().toLowerCase()
  let netFilter = net
  if (query.startsWith('net:')) { netFilter = q!.slice(4); query = '' }

  let list = full.devices.filter((d) => {
    if (status === 'online' && !d.online) return false
    if (status === 'offline' && d.online) return false
    if (link !== 'all' && d.link !== link) return false
    if (netFilter && d.network !== netFilter) return false
    if (query) {
      const hay = [d.name, d.hostname, d.ip, d.mac, d.vendor, ...(d.ipv4 || []), d.network, d.wifi?.essid].join(' ').toLowerCase()
      if (!hay.includes(query)) return false
    }
    return true
  })
  const [col, dir] = sort
  const val = (d: Device): any => {
    switch (col) {
      case 'name': return (d.name || '').toLowerCase()
      case 'ip': return ipKey(d.ip)
      case 'network': return d.network || ''
      case 'down': return d.down + (d.online ? 1e-9 : 0)
      case 'up': return d.up + (d.online ? 1e-9 : 0)
      case 'today': return d.today_down + d.today_up
      case 'month': return d.month_down + d.month_up
      case 'dns': return d.dns_q24
      case 'since': return d.connected_since ? -d.connected_since : -1e12
    }
  }
  list = [...list].sort((a, b) => {
    const x = val(a), y = val(b)
    if (x === y) return (a.name || '').localeCompare(b.name || '')
    return (x > y ? 1 : -1) * dir
  })
  const th = (c: Col, label: string, r = false) => (
    <th className={r ? 'r' : ''} onClick={() => setSort([c, sort[0] === c ? (sort[1] === 1 ? -1 : 1) : (c === 'name' || c === 'ip' || c === 'network' ? 1 : -1)])}>
      {label}{sort[0] === c && <span className="sort">{sort[1] === 1 ? '▲' : '▼'}</span>}
    </th>
  )
  const onCount = full.devices.filter((d) => d.online).length
  const hasUnifi = !!(full.unifi_devices && full.unifi_devices.length)

  return (
    <>
      <div className="filters">
        <Seg value={status} onChange={setStatus} options={[['online', `Online ${onCount}`], ['all', `Alle ${full.devices.length}`], ['offline', 'Offline']]} />
        <Seg value={link} onChange={setLink} options={[['all', 'Alle'], ['wifi', 'WLAN'], ['wired', 'LAN']]} />
        <select className="input" value={netFilter} onChange={(e) => { setNet(e.target.value); if (q?.startsWith('net:')) go('devices') }}>
          <option value="">Alle Netze</option>
          {nets.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        {q && <button className="btn sm ghost" onClick={() => go('devices')}>Suche „{q}“ entfernen ✕</button>}
        <span className="dim" style={{ marginLeft: 'auto' }}>{list.length} Geräte</span>
      </div>
      <Card flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                {th('name', 'Gerät')}
                {th('ip', 'IP')}
                <th className="hide-m hide-l">MAC</th>
                {th('network', 'Netz')}
                <th className="hide-m">Anschluss</th>
                {th('down', 'Download', true)}
                {th('up', 'Upload', true)}
                {th('today', 'Heute', true)}
                {th('month', 'Monat', true)}
                {th('dns', 'DNS 24 Std', true)}
                {th('since', 'Verbunden seit', true)}
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.mac} className={d.online ? '' : 'off'} onClick={() => go('devices', d.mac, q)}>
                  <td>
                    <div className="row">
                      <DevIcon icon={d.icon || d.icon_auto} on={d.online} />
                      <div className="col" style={{ gap: 0 }}>
                        <b className="ell" style={{ maxWidth: 230 }}>{d.name}{d.blocked && <span className="badge bad" style={{ marginLeft: 6 }}>kein Internet</span>}</b>
                        <span className="dim ell" style={{ fontSize: 12, maxWidth: 230 }}>{d.vendor || d.hostname || ''}</span>
                      </div>
                    </div>
                  </td>
                  <td className="mono">{d.ip || '–'}</td>
                  <td className="mono dim hide-m hide-l">{d.mac}</td>
                  <td>{d.network || '–'}</td>
                  <td className="hide-m"><AttachCell d={d} /></td>
                  <td className="r"><Rate v={d.down} dir="d" /></td>
                  <td className="r"><Rate v={d.up} dir="u" /></td>
                  <td className="r num" title={`↓ ${bytes(d.today_down)} · ↑ ${bytes(d.today_up)}`}>{d.today_down + d.today_up ? bytes(d.today_down + d.today_up) : '–'}</td>
                  <td className="r num dim" title={`↓ ${bytes(d.month_down)} · ↑ ${bytes(d.month_up)}`}>{d.month_down + d.month_up ? bytes(d.month_down + d.month_up) : '–'}</td>
                  <td className="r num">{d.dns_q24 ? num(d.dns_q24) : '–'}{d.dns_b24 > 0 && <span className="dim" style={{ marginLeft: 6, color: 'var(--bad)' }}>{num(d.dns_b24)}</span>}</td>
                  <td className="r num dim">{d.online ? since(d.connected_since) : ago(d.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.length && <div className="empty">Keine Geräte gefunden</div>}
        </div>
      </Card>
    </>
  )
}
