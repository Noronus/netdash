import React from 'react'
import { Cable, Cloud, Globe, Network, Waypoints } from 'lucide-react'
import { Full, Iface, VpsIf } from '../api'
import { go } from '../App'
import { AreaChart } from '../components/charts'
import { Badge, Card, Rate } from '../components/ui'
import { bytes, rate } from '../format'

type Hist = Record<string, [number, number, number][]>

export default function Networks({ full, ifHist }: { full: Full; ifHist: Hist }) {
  const ifs = full.interfaces
  const byDev = new Map(ifs.map((i) => [i.device, i]))
  const wans = ifs.filter((i) => i.kind === 'wan')
  const ports = ifs.filter((i) => i.kind === 'port')
  const inPort = new Set(ports.flatMap((p) => [p.device + '.untagged', ...(p.children || [])]))
  const solo = ifs.filter((i) => (i.kind === 'net' || i.kind === 'vlan') && !inPort.has(i.device) && (i.nets.length || i.rx || i.tx))
  const vpns = ifs.filter((i) => i.kind === 'vpn' && i.device !== 'wireguard')
  const loops = ifs.filter((i) => i.kind === 'loopback')
  const online = full.devices.filter((d) => d.online)
  const gws = full.gateways || []
  const count = (i: Iface) => online.filter((d) => d.netif === i.netif).length

  return (
    <>
      <div className="grid">
        {wans.map((i) => {
          const h = ifHist[i.device] || []
          return (
            <Card key={i.device} className={wans.length > 1 ? 'c6' : 'c12'} title={`${i.descr} · Internet`} icon={<Globe size={16} />}
              act={<span className="mono">{i.device}{i.addr4 ? ' · ' + i.addr4 : ''}</span>}>
              <div className="row wrap" style={{ gap: 28, marginBottom: 10 }}>
                <div className="kpi"><span className="dim">Download</span><b className="num" style={{ color: 'var(--down)', fontSize: 20 }}>{rate(i.rx)}</b></div>
                <div className="kpi"><span className="dim">Upload</span><b className="num" style={{ color: 'var(--up)', fontSize: 20 }}>{rate(i.tx)}</b></div>
                <div className="kpi"><span className="dim">Heute</span><b className="num">↓ {bytes(i.today_rx)} · ↑ {bytes(i.today_tx)}</b></div>
                <div className="kpi"><span className="dim">Monat</span><b className="num">↓ {bytes(i.month_rx)} · ↑ {bytes(i.month_tx)}</b></div>
                <div className="kpi"><span className="dim">Medium</span><span>{i.media || '–'}</span></div>
              </div>
              <AreaChart h={200} fmt={rate} series={[
                { label: 'Download', color: 'var(--down)', data: h.map((p) => [p[0], p[1]]) },
                { label: 'Upload', color: 'var(--up)', data: h.map((p) => [p[0], p[2]]) },
              ]} />
            </Card>
          )
        })}
      </div>

      {ports.map((p) => {
        const members = [byDev.get(p.device + '.untagged'), ...(p.children || []).map((c) => byDev.get(c))].filter(Boolean) as Iface[]
        members.sort((a, b) => (a.untagged ? -1 : b.untagged ? 1 : Number(a.vlan || 0) - Number(b.vlan || 0)))
        return (
          <Card key={p.device} title={`Port ${p.device} · Trunk mit ${members.length} Netzen`} icon={<Cable size={16} />}
            act={<><span className="mono">{p.media}</span><Badge t={p.status === 'up' ? 'ok' : undefined}>{p.status || '–'}</Badge></>}>
            <div className="row wrap dim" style={{ gap: 22, marginBottom: 14, fontSize: 13 }}>
              <span>Gesamt über den Port (alle Netze zusammen):</span>
              <span className="row" style={{ gap: 12 }}><Rate v={p.tx} dir="d" /><Rate v={p.rx} dir="u" /></span>
              <span>heute ↓ {bytes(p.today_tx)} · ↑ {bytes(p.today_rx)}</span>
              <span>Monat {bytes(p.month_rx + p.month_tx)}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
              {members.map((i) => <NetCard key={i.device} i={i} h={ifHist[i.device] || []} n={count(i)} />)}
            </div>
          </Card>
        )
      })}

      {solo.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
          {solo.map((i) => <NetCard key={i.device} i={i} h={ifHist[i.device] || []} n={count(i)} card />)}
        </div>
      )}

      <Card title="Gateways" icon={<Globe size={16} />} flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Adresse</th><th>Status</th><th className="r">Ping</th><th className="r">Jitter</th><th className="r">Verlust</th></tr></thead>
            <tbody>
              {gws.map((g) => (
                <tr key={g.name} style={{ cursor: 'default' }}>
                  <td><b>{g.name}</b></td><td className="mono">{g.address}</td>
                  <td><Badge t={g.status_translated === 'Online' ? 'ok' : 'bad'}>{g.status_translated}</Badge></td>
                  <td className="r num">{g.delay}</td><td className="r num">{g.stddev}</td><td className="r num">{g.loss}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {vpns.length > 0 && (
        <Card title="VPN" icon={<Waypoints size={16} />} act={<a style={{ cursor: 'pointer' }} onClick={() => go('vpn')}>Peers</a>}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
            {vpns.map((i) => <NetCard key={i.device} i={i} h={ifHist[i.device] || []} n={0} vpn={vpnPeers(full, i)} />)}
          </div>
        </Card>
      )}
      <VpsSection full={full} ifHist={ifHist} />
      {loops.length > 0 && (
        <Card title="System" icon={<Network size={16} />}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
            {loops.map((i) => <NetCard key={i.device} i={i} h={ifHist[i.device] || []} n={0} loopback />)}
          </div>
        </Card>
      )}
    </>
  )
}

export function vpnPeers(full: Full, i: Iface): { up: number; total: number; label: string } {
  if (i.device.startsWith('wt')) {
    const p = full.netbird?.peers || []
    return { up: p.filter((x) => x.status === 'Connected').length, total: p.length, label: 'NetBird' }
  }
  const peers = (full.wireguard || []).filter((r) => r.type === 'peer' && r.if === i.device)
  return { up: peers.filter((p) => p['latest-handshake-age'] != null && p['latest-handshake-age'] < 300).length, total: peers.length, label: 'WireGuard' }
}

function NetCard({ i, h, n, card, vpn, loopback }: { i: Iface; h: [number, number, number][]; n: number; card?: boolean; vpn?: { up: number; total: number; label: string }; loopback?: boolean }) {
  return (
    <div className="card" style={{ background: card ? undefined : 'var(--surface-2)', boxShadow: card ? undefined : 'none' }}>
      <div className="card-b" style={{ padding: 13 }}>
        <div className="row" style={{ marginBottom: 2 }}>
          <Network size={15} className="dim" />
          <b className="grow ell">{i.descr}</b>
          {i.vlan ? <Badge>VLAN {i.vlan}</Badge> : i.untagged ? <Badge>untagged</Badge> : null}
          {vpn && <Badge t={vpn.up ? 'ok' : undefined}>{vpn.label}</Badge>}
        </div>
        <div className="mono dim" style={{ fontSize: 11.5, marginBottom: 8 }}>{i.netif} · {i.nets.filter((x) => !x.includes(':')).join(' · ') || 'keine IPv4'}</div>
        <AreaChart h={80} fmt={rate} series={[
          { label: vpn ? 'in den Tunnel' : 'zu Geräten', color: 'var(--down)', data: h.map((p) => [p[0], p[2]]) },
          { label: vpn ? 'aus dem Tunnel' : 'von Geräten', color: 'var(--up)', data: h.map((p) => [p[0], p[1]]) },
        ]} />
        <div className="row wrap" style={{ justifyContent: 'space-between', marginTop: 6, gap: 6 }}>
          <span className="row" style={{ gap: 12 }}><Rate v={i.tx} dir="d" /><Rate v={i.rx} dir="u" /></span>
          {loopback ? <span className="dim" style={{ fontSize: 12 }}>Verkehr der Firewall mit sich selbst</span>
            : vpn ? <a style={{ cursor: 'pointer' }} onClick={() => go('vpn')}>{vpn.up}/{vpn.total} Peers aktiv</a>
            : <a style={{ cursor: 'pointer' }} onClick={() => go('devices', undefined, 'net:' + i.descr)}>{n} Geräte</a>}
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>heute ↓ {bytes(i.today_tx)} · ↑ {bytes(i.today_rx)} · Monat {bytes(i.month_rx + i.month_tx)}</div>
      </div>
    </div>
  )
}

const VPS_ORDER = { public: 0, wireguard: 1, netbird: 2, docker: 3, other: 4, loopback: 5 }

function VpsSection({ full, ifHist }: { full: Full; ifHist: Hist }) {
  const all = full.vps_ifaces || []
  if (!all.length) return null
  const vps = full.vps as any
  const pub = all.find((i) => i.kind === 'public')
  const main = all.filter((i) => i.kind !== 'loopback' && (i.state !== 'DOWN' || i.rx_total || i.tx_total))
    .sort((a, b) => VPS_ORDER[a.kind] - VPS_ORDER[b.kind] || a.name.localeCompare(b.name))
  const rest = all.filter((i) => !main.includes(i))
  return (
    <Card title={`${vps?.name || 'VPS'} · Interfaces auf dem VPS`} icon={<Cloud size={16} />}
      style={{ borderColor: 'var(--accent)', borderStyle: 'dashed' }}
      act={<><span className="badge acc">extern · nicht im Heimnetz</span><span className="mono">{pub?.addrs.find((a) => !a.includes(':'))?.split('/')[0]}</span></>}>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 12 }}>
        Interfaces des externen Servers, alle 10 s per SSH abgefragt. ↓ = beim VPS angekommen, ↑ = vom VPS gesendet.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
        {main.map((i) => <VpsCard key={i.name} i={i} h={ifHist['vps:' + i.name] || []} />)}
      </div>
      {rest.length > 0 && (
        <div className="dim" style={{ fontSize: 12, marginTop: 10 }}>
          Außerdem auf dem VPS: {rest.map((i) => `${i.name} (${i.label.replace('Docker · ', 'Docker ')}${i.state === 'DOWN' ? ', aus' : ''})`).join(' · ')}
        </div>
      )}
    </Card>
  )
}

function VpsCard({ i, h }: { i: VpsIf; h: [number, number, number][] }) {
  const kindBadge = { public: 'Internet', wireguard: 'WireGuard', netbird: 'NetBird', docker: 'Docker', loopback: 'System', other: i.kind }[i.kind]
  const title = i.kind === 'wireguard' ? i.label.replace(/^WireGuard /, 'Tunnel ') : i.kind === 'docker' ? i.label.replace('Docker · ', 'Netz ') : i.label
  return (
    <div className="card" style={{ background: 'var(--surface-2)', boxShadow: 'none', borderLeft: '3px solid var(--accent)', opacity: i.state === 'DOWN' ? 0.6 : 1 }}>
      <div className="card-b" style={{ padding: 13 }}>
        <div className="row" style={{ marginBottom: 2, gap: 6 }}>
          <Cloud size={15} className="dim" />
          <b className="grow ell" title={title}>{title}</b>
          <span className="badge acc" style={{ padding: '1px 6px' }}>VPS</span>
          <Badge t={i.state === 'DOWN' ? undefined : 'ok'}>{kindBadge}</Badge>
        </div>
        <div className="mono dim ell" style={{ fontSize: 11.5, marginBottom: 8 }} title={i.addrs.join(' · ')}>{i.name} · {i.addrs.filter((x) => !x.includes(':')).join(' · ') || i.addrs[0] || 'keine Adresse'}</div>
        <AreaChart h={80} fmt={rate} series={[
          { label: 'empfangen', color: 'var(--down)', data: h.map((p) => [p[0], p[1]]) },
          { label: 'gesendet', color: 'var(--up)', data: h.map((p) => [p[0], p[2]]) },
        ]} />
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
          <span className="row" style={{ gap: 12 }}><Rate v={i.rx} dir="d" /><Rate v={i.tx} dir="u" /></span>
          {i.kind === 'wireguard' || i.kind === 'netbird'
            ? <a style={{ cursor: 'pointer' }} onClick={() => go('vpn')}>Tunnel-Details</a>
            : <span className="dim" style={{ fontSize: 12 }}>MTU {i.mtu}</span>}
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>heute ↓ {bytes(i.today_rx)} · ↑ {bytes(i.today_tx)} · seit Start ↓ {bytes(i.rx_total)} · ↑ {bytes(i.tx_total)}</div>
      </div>
    </div>
  )
}
