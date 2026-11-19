import React, { useState } from 'react'
import { Activity, ArrowUpCircle, Cpu, Globe, HardDrive, MonitorSmartphone, Network, ShieldCheck, Waypoints } from 'lucide-react'
import { api, Full } from '../api'
import { go, openDevice, wanRates } from '../App'
import { AreaChart, Donut, Sparkline } from '../components/charts'
import { Badge, Card, DevIcon, Dot, Meter, Rate, SrcError } from '../components/ui'
import DomainList from '../components/DomainList'
import { deviceOf, UpdateRow } from '../components/Updates'
import { vpnPeers } from './Networks'
import { bytes, dur, num, pct, rate, rateShort, tone } from '../format'

export function wanHistory(full: Full, ifHist: Record<string, [number, number, number][]>) {
  const wans = full.interfaces.filter((i) => i.wan).map((i) => i.device)
  const map = new Map<number, [number, number]>()
  for (const w of wans) for (const [t, rx, tx] of ifHist[w] || []) {
    const cur = map.get(t) || [0, 0]
    map.set(t, [cur[0] + rx, cur[1] + tx])
  }
  const pts = [...map.entries()].sort((a, b) => a[0] - b[0])
  return { down: pts.map(([t, v]) => [t, v[0]] as [number, number]), up: pts.map(([t, v]) => [t, v[1]] as [number, number]) }
}

export default function Overview({ full, ifHist }: { full: Full; ifHist: Record<string, [number, number, number][]> }) {
  const wan = wanRates(full)
  const wh = wanHistory(full, ifHist)
  const gw = (full.gateways || []).filter((g) => g.delay && g.delay !== '~')
  const mainGw = gw[0]
  const devs = full.devices
  const online = devs.filter((d) => d.online)
  const wifi = online.filter((d) => d.link === 'wifi').length
  const top = [...online].sort((a, b) => b.up + b.down - (a.up + a.down)).slice(0, 7)
  const topToday = [...devs].sort((a, b) => b.today_up + b.today_down - (a.today_up + a.today_down)).slice(0, 7)
  const maxNow = Math.max(...top.map((d) => d.up + d.down), 1)
  const maxToday = Math.max(...topToday.map((d) => d.today_up + d.today_down), 1)
  const ag = full.adguard
  const gatus = full.gatus || []
  const gBad = gatus.filter((g) => g.ok === false)
  const nb = full.netbird
  const nbConn = (nb?.peers || []).filter((p) => p.status === 'Connected').length
  const wgPeers = (full.wireguard || []).filter((r) => r.type === 'peer')
  const wgUp = wgPeers.filter((p) => p['latest-handshake-age'] != null && p['latest-handshake-age'] < 300).length
  const sys = full.system
  const svc = full.services || []
  const svcDown = svc.filter((x) => !x.running)
  const un = full.unraid
  const lans = full.interfaces.filter((i) => ((i.kind === 'net' || i.kind === 'vlan') && i.nets.some((n) => !n.includes(':'))) || (i.kind === 'vpn' && i.device !== 'wireguard'))
  const [dv, du] = rateShort(wan.rx)
  const [uv, uu] = rateShort(wan.tx)

  return (
    <>
      <div className="grid">
        <Card className="c2" title="Internet" icon={<Globe size={16} />} onClick={() => go('networks')}
          act={mainGw ? <Badge t={mainGw.status_translated === 'Online' ? 'ok' : 'bad'}>{mainGw.status_translated}</Badge> : null}>
          <div className="kpi">
            <div className="v num" style={{ color: 'var(--down)' }}>{dv}<small>{du}</small></div>
            <div className="s"><span style={{ color: 'var(--up)' }}>↑ {uv} {uu}</span>{mainGw && <span>Ping {mainGw.delay}</span>}{mainGw && mainGw.loss !== '0.0 %' && <span>Verlust {mainGw.loss}</span>}</div>
          </div>
          <div style={{ marginTop: 8 }}><Sparkline data={wh.down.slice(-90).map((p) => p[1])} color="var(--down)" /></div>
        </Card>

        <Card className="c2" title="Geräte" icon={<MonitorSmartphone size={16} />} onClick={() => go('devices')}>
          <div className="kpi">
            <div className="v">{online.length}<small>online</small></div>
            <div className="s"><span>{wifi} WLAN</span><span>{online.length - wifi} LAN/sonst.</span><span>{devs.length - online.length} offline</span></div>
          </div>
          <div style={{ marginTop: 12 }}><Meter value={online.length} max={devs.length} /></div>
        </Card>

        <Card className="c2" title="DNS" icon={<ShieldCheck size={16} />} onClick={() => go('dns')}
          act={ag ? <Badge t={ag.protection ? 'ok' : 'warn'}>{ag.protection ? 'Schutz an' : 'Schutz aus'}</Badge> : null}>
          {ag ? (
            <div className="kpi">
              <div className="v">{num(ag.queries)}<small>Anfragen</small></div>
              <div className="s"><span>{pct((100 * ag.blocked) / Math.max(ag.queries, 1), 1)} blockiert</span><span>Ø {ag.avg_ms} ms</span></div>
              <div style={{ marginTop: 8 }}><Sparkline data={ag.series_q.slice(-24)} color="var(--violet)" /></div>
            </div>
          ) : <SrcError src={full.sources.adguard} label="AdGuard" />}
        </Card>

        <Card className="c2" title="Monitoring" icon={<Activity size={16} />} onClick={() => go('services')}
          act={<Badge t={gBad.length ? 'bad' : 'ok'}>{gBad.length ? gBad.length + ' Fehler' : 'alles ok'}</Badge>}>
          <div className="kpi">
            <div className="v">{gatus.length - gBad.length}<small>/ {gatus.length} erreichbar</small></div>
            <div className="s">{gBad.length ? gBad.slice(0, 3).map((g) => <span key={g.key} style={{ color: 'var(--bad)' }}>{g.name}</span>) : <span>Gatus · {svc.filter((x) => x.running).length}/{svc.length} Dienste laufen</span>}</div>
          </div>
        </Card>

        <Card className="c2" title="VPN" icon={<Waypoints size={16} />} onClick={() => go('vpn')}
          act={nb ? <Badge t={nb.management ? 'ok' : 'bad'}>NetBird</Badge> : null}>
          <div className="kpi">
            <div className="v">{nbConn}<small>/ {nb?.peers.length || 0} Peers</small></div>
            <div className="s"><span>WireGuard {wgUp}/{wgPeers.length} aktiv</span></div>
          </div>
        </Card>

        <Card className="c2" title="Firewall" icon={<Cpu size={16} />} onClick={() => go('servers')}>
          {sys && (
            <div className="kpi">
              <div className="v num">{pct(sys.cpu)}<small>CPU</small></div>
              <div className="s"><span>RAM {pct((100 * sys.mem_used) / sys.mem_total)}</span>{sys.temps[0] && <span>{sys.temps[0].c.toFixed(0)} °C</span>}<span>{num(sys.pf_states)} States</span></div>
              <div style={{ marginTop: 8 }}><Sparkline data={sys.cpu_hist.slice(-90).map((p) => p[1])} color="var(--accent)" /></div>
            </div>
          )}
        </Card>
      </div>

      <div className="grid">
        <Card className="c8" fill title="Internet-Durchsatz" icon={<Globe size={16} />}
          act={<div className="legend"><span><i style={{ background: 'var(--down)' }} />Download</span><span><i style={{ background: 'var(--up)' }} />Upload</span><span className="dim">letzte 15 Min</span></div>}>
          <AreaChart h={260} grow fmt={rate} series={[
            { label: 'Download', color: 'var(--down)', data: wh.down },
            { label: 'Upload', color: 'var(--up)', data: wh.up },
          ]} />
        </Card>
        <Card className="c4" title="Aktivste Geräte jetzt" icon={<MonitorSmartphone size={16} />} flush>
          <div className="list">
            {top.map((d) => (
              <div key={d.mac} className="li click" onClick={() => openDevice(d.mac)}>
                <DevIcon icon={d.icon || d.icon_auto} on size={16} />
                <div className="col grow">
                  <div className="row"><b className="ell grow">{d.name}</b><span className="num dim" style={{ fontSize: 12 }}>{rate(d.up + d.down)}</span></div>
                  <div className="meter" style={{ height: 4 }}><i style={{ width: (100 * (d.up + d.down)) / maxNow + '%', background: 'linear-gradient(90deg, var(--down), var(--up))' }} /></div>
                </div>
              </div>
            ))}
            {!top.length && <div className="empty">Keine Aktivität</div>}
          </div>
        </Card>
      </div>

      <div className="grid">
        <Card className="c8" fill title="Netzwerke" icon={<Network size={16} />} act={<a onClick={() => go('networks')} style={{ cursor: 'pointer' }}>Alle</a>}>
          <div className="tiles">
            {lans.map((i) => {
              const vp = i.kind === 'vpn' ? vpnPeers(full, i) : null
              const n = vp ? vp.up : online.filter((d) => d.netif === i.netif).length
              const h = (ifHist[i.device] || []).slice(-60).map((p) => p[1] + p[2])
              return (
                <div key={i.device} className="card click tile" style={{ background: 'var(--surface-2)', boxShadow: 'none' }} onClick={() => vp ? go('vpn') : go('devices', undefined, 'net:' + i.descr)}>
                  <div className="card-b" style={{ padding: 12 }}>
                    <div className="row"><b className="grow ell">{i.descr}</b>{vp ? <span className="dim" style={{ fontSize: 11.5 }}>{vp.label}</span> : i.vlan ? <span className="dim" style={{ fontSize: 11.5 }}>VLAN {i.vlan}</span> : i.untagged ? <span className="dim" style={{ fontSize: 11.5 }}>untagged</span> : null}<span className={'badge' + (vp && vp.up ? ' ok' : '')} title={vp ? `${vp.up} von ${vp.total} Peers aktiv` : 'Geräte online'}>{n}</span></div>
                    <div className="dim mono" style={{ fontSize: 11.5, margin: '2px 0 6px' }}>{i.nets.find((x) => !x.includes(':')) || i.device}</div>
                    <Sparkline data={h} h={26} color="var(--accent)" grow />
                    <div className="row" style={{ justifyContent: 'space-between', marginTop: 4, fontSize: 12 }}>
                      <Rate v={i.tx} dir="d" /><Rate v={i.rx} dir="u" />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
        <Card className="c4" title="Meiste Daten heute" icon={<HardDrive size={16} />} flush>
          <div className="list">
            {topToday.map((d) => (
              <div key={d.mac} className="li click" onClick={() => openDevice(d.mac)}>
                <DevIcon icon={d.icon || d.icon_auto} on={d.online} size={16} />
                <div className="col grow">
                  <div className="row"><b className="ell grow">{d.name}</b><span className="num dim" style={{ fontSize: 12 }}>{bytes(d.today_up + d.today_down)}</span></div>
                  <div className="meter" style={{ height: 4 }}><i style={{ width: (100 * (d.today_up + d.today_down)) / maxToday + '%', background: 'var(--violet)' }} /></div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid">
        <Card className="c4" title="OPNsense-Dienste" icon={<Activity size={16} />} act={<Badge t={svcDown.length ? 'bad' : 'ok'}>{svc.length - svcDown.length}/{svc.length}</Badge>}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '6px 12px' }}>
            {[...svcDown, ...svc.filter((x) => x.running)].slice(0, 16).map((x) => (
              <div key={x.id} className="row gap6" style={{ fontSize: 12.5 }}><Dot t={x.running ? 'ok' : 'bad'} /><span className="ell">{x.description}</span></div>
            ))}
          </div>
        </Card>
        <Card className="c4" title={'Unraid' + (un ? ' · ' + un.hostname : '')} icon={<HardDrive size={16} />} onClick={() => go('servers')}
          act={un ? <Badge t={un.array_state === 'STARTED' ? 'ok' : 'warn'}>{un.array_state === 'STARTED' ? 'läuft' : un.array_state}</Badge> : null}>
          {un ? (
            <div className="col" style={{ gap: 10 }}>
              <div className="row"><span className="dim" style={{ width: 70 }}>CPU</span><div className="grow"><Meter value={un.cpu} t={tone(un.cpu, 70, 90)} /></div><span className="num" style={{ width: 52, textAlign: 'right' }}>{pct(un.cpu)}</span></div>
              <div className="row"><span className="dim" style={{ width: 70 }}>RAM</span><div className="grow"><Meter value={un.mem.total - un.mem.available} max={un.mem.total} /></div><span className="num" style={{ width: 52, textAlign: 'right' }}>{pct((100 * (un.mem.total - un.mem.available)) / un.mem.total)}</span></div>
              {un.pools.filter((p) => p.fs_size).map((p) => (
                <div key={p.name} className="row"><span className="dim ell" style={{ width: 70 }}>{p.name}</span><div className="grow"><Meter value={p.fs_used || 0} max={p.fs_size || 1} t={tone((100 * (p.fs_used || 0)) / (p.fs_size || 1), 80, 92)} /></div><span className="num" style={{ width: 52, textAlign: 'right' }}>{pct((100 * (p.fs_used || 0)) / (p.fs_size || 1))}</span></div>
              ))}
              <div className="dim" style={{ fontSize: 12.5 }}>{un.containers.filter((c) => c.state === 'RUNNING').length} von {un.containers.length} Containern laufen</div>
            </div>
          ) : <SrcError src={full.sources.unraid} label="Unraid" />}
        </Card>
        <Card className="c4" title="Blockiert (24 Std)" icon={<ShieldCheck size={16} />} flush act={<a style={{ cursor: 'pointer' }} onClick={() => go('dns')}>DNS</a>}>
          {full.dns_top ? <DomainList rows={full.dns_top.blocked.slice(0, 7)} bad /> : <div className="card-b"><SrcError src={full.sources.adguard} label="AdGuard" /></div>}
        </Card>
      </div>
      <Updates full={full} />
    </>
  )
}

function Updates({ full }: { full: Full }) {
  const [busy, setBusy] = useState('')
  const items = full.updates || []
  if (!items.length) return null
  const n = items.filter((u) => u.update).length
  const check = async () => {
    setBusy('läuft …')
    try { await api('/api/updates/check', { method: 'POST', body: '{}' }); setBusy('Prüfung gestartet, OPNsense braucht etwa eine Minute') }
    catch (e: any) { setBusy('Fehler: ' + e.message) }
  }
  return (
    <div className="grid">
      <Card className="c12" title="Updates" icon={<ArrowUpCircle size={16} />}
        act={<div className="row gap6">
          {busy && <span className="dim" style={{ fontSize: 12 }}>{busy}</span>}
          <Badge t={n ? 'warn' : 'ok'}>{n ? `${n} verfügbar` : 'alles aktuell'}</Badge>
          <button className="btn sm" onClick={check}>Jetzt prüfen</button>
        </div>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
          {items.map((u) => {
            const d = deviceOf(full, u)
            return <UpdateRow key={u.id} u={u} onClick={d ? () => openDevice(d.mac) : u.own ? () => go('servers') : undefined} />
          })}
        </div>
      </Card>
    </div>
  )
}
