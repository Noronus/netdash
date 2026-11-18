import React, { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Link2, Save } from 'lucide-react'
import AssignDialog from '../components/Assign'
import PortDrawer from '../components/PortDrawer'
import { Globe, Network, Router, Server, Wifi } from 'lucide-react'
import { api, Device, Full, SwPort } from '../api'
import { openDevice, wanRates } from '../App'
import { speedColor, speedLabel } from '../components/Attach'
import { Badge, DevIcon, Signal, SrcError } from '../components/ui'
import { rate } from '../format'

function DevChip({ d, sub, hint, onAssign }: { d: Device; sub?: React.ReactNode; hint?: string; onAssign?: (d: Device) => void }) {
  const tip = [d.name, d.ip || d.mac, hint, d.vendor, d.online ? 'online' : 'offline'].filter(Boolean).join(' · ')
  return (
    <div className={'tdev' + (d.online ? '' : ' off')} onClick={() => openDevice(d.mac)} title={tip}>
      <DevIcon icon={d.icon || d.icon_auto} on={d.online} size={14} />
      <div className="col grow" style={{ gap: 0, minWidth: 0 }}>
        <span className="ell" style={{ fontWeight: 550 }}>{d.name}</span>
        <span className="dim ell mono" style={{ fontSize: 11 }}>{sub ?? d.ip}</span>
      </div>
      {d.attach?.manual && <span className="dim" style={{ fontSize: 10 }} title="manuell zugewiesen">manuell</span>}
      {d.down + d.up > 2000 && <span className="dot ok" title={rate(d.down + d.up)} />}
      {onAssign && <button className="icon-btn" style={{ width: 24, height: 24 }} title="Anschluss zuweisen" onClick={(e) => { e.stopPropagation(); onAssign(d) }}><Link2 size={13} /></button>}
    </div>
  )
}

/** show the first `n` children, the rest behind a "+N weitere" toggle */
function More({ items, n = 3 }: { items: React.ReactNode[]; n?: number }) {
  const [open, setOpen] = useState(false)
  if (n > 0 ? items.length <= n + 1 : items.length === 0) return <>{items}</>
  return (
    <>
      {open ? items : items.slice(0, n)}
      <button className="tmore" onClick={() => setOpen(!open)}>
        {open ? <><ChevronUp size={13} />weniger</> : <><ChevronDown size={13} />{items.length - n} weitere</>}
      </button>
    </>
  )
}

function PortPanel({ ports, uplink, sel, onSel }: { ports: SwPort[]; uplink?: string; sel: string | null; onSel: (p: string) => void }) {
  const groups: [string, SwPort[]][] = []
  const add = (label: string, list: SwPort[]) => { if (list.length) groups.push([label, list]) }
  const maxOf = (l: SwPort[]) => speedLabel(Math.max(...l.map((p) => (p.name.startsWith('MGE') ? 2500 : 10000))))
  const mge = ports.filter((p) => p.name.startsWith('MGE'))
  const rj = ports.filter((p) => !p.name.startsWith('MGE') && p.form !== 'sfp')
  const sfp = ports.filter((p) => !p.name.startsWith('MGE') && p.form === 'sfp')
  add(maxOf(mge) + ' RJ45', mge)
  add('10G RJ45', rj)
  add('10G SFP+', sfp)
  const Sq = ({ p }: { p: SwPort }) => (
    <button className={'tport' + (p.form === 'sfp' ? ' sfp' : '') + (p.up ? ' up' : '') + (sel === p.name ? ' sel' : '') + (p.name === uplink ? ' uplink' : '')}
      style={p.up ? { borderColor: speedColor(p.speed), color: speedColor(p.speed) } : undefined}
      title={`${p.name} (${p.form === 'sfp' ? 'SFP+' : 'RJ45'})${p.descr ? ' · ' + p.descr : ''} · ${p.up ? speedLabel(p.speed) : 'kein Link'}${p.name === uplink ? ' · Uplink zur OPNsense' : ''}`}
      onClick={() => onSel(p.name)}>
      <span>{p.name.replace(/^MGE|^TE/, '')}</span>
      <i>{p.up ? speedLabel(p.speed) : ''}</i>
    </button>
  )
  return (
    <div className="tpanel">
      {groups.map(([label, list]) => (
        <div key={label} className="col" style={{ gap: 4 }}><span className="dim" style={{ fontSize: 10.5 }}>{label}</span><div className="row" style={{ gap: 4 }}>{list.map((p) => <Sq key={p.name} p={p} />)}</div></div>
      ))}
    </div>
  )
}

export default function Topology({ full }: { full: Full }) {
  const [sel, setSel] = useState<string | null>(null)
  const [portEdit, setPortEdit] = useState<string | null>(null)
  const [assign, setAssign] = useState<Device | null>(null)
  const [saving, setSaving] = useState('')
  const sw = full.switch
  const devs = full.devices
  const byMac = useMemo(() => new Map(devs.map((d) => [d.mac, d])), [devs])
  const wan = wanRates(full)
  const gw = (full.gateways || []).find((g) => g.delay && g.delay !== '~')
  const wanIf = full.interfaces.find((i) => i.kind === 'wan')
  const trunk = full.interfaces.find((i) => i.kind === 'port')
  const uplink = sw?.uplink || undefined
  const apMacs = new Set((full.unifi_devices || []).filter((d) => d.type === 'uap').map((d) => d.mac))
  const cols = (sw?.ports || []).filter((p) => p.up && p.name !== uplink)
  const attached = new Set(devs.filter((d) => d.attach).map((d) => d.mac))
  const wanSide = devs.filter((d) => d.attach?.kind === 'firewall' && d.attach.wan)
  const gwIps = new Set((full.gateways || []).map((g) => g.address))
  const upstream = wanSide.filter((d) => gwIps.has(d.ip || '') || d.icon_auto === 'router')
  const wanOthers = wanSide.filter((d) => !upstream.includes(d)).sort((a, b) => Number(b.online) - Number(a.online))
  const direct = devs.filter((d) => d.online && d.attach?.kind === 'firewall' && !d.attach.wan)
  // ports with a link but no known MAC: guess the device from the port description
  const guesses = new Map<string, Device>()
  for (const p of cols) {
    if (p.lldp.length || devs.some((d) => d.attach?.kind === 'switch' && d.attach.port === p.name)) continue
    const g = p.descr ? devs.find((d) => !d.attach && (d.name.toLowerCase().includes(p.descr.toLowerCase()) || p.descr.toLowerCase().includes(d.name.toLowerCase().split(' ')[0]))) : undefined
    if (g) guesses.set(p.name, g)
  }
  const guessed = new Set([...guesses.values()].map((d) => d.mac))
  const unknown = devs.filter((d) => d.online && !d.attach && d.mac !== sw?.mac && !guessed.has(d.mac))

  return (
    <div className="topo">
      <div className="tnode">
        <span className="tic"><Globe size={20} /></span>
        <div className="col" style={{ gap: 0 }}><b>Internet</b><span className="dim" style={{ fontSize: 12 }}>{gw ? `${gw.name} · Ping ${gw.delay}` : ''}</span></div>
        <span className="num" style={{ fontSize: 12.5, marginLeft: 'auto' }}><span style={{ color: 'var(--down)' }}>↓ {rate(wan.rx)}</span> · <span style={{ color: 'var(--up)' }}>↑ {rate(wan.tx)}</span></span>
      </div>
      {upstream.map((d, i) => (
        <React.Fragment key={d.mac}>
          <div className="tconn" />
          <div className="tnode" style={{ flexWrap: 'wrap' }}>
            <div className="row click" style={{ cursor: 'pointer', gap: 12, flex: 1, minWidth: 0 }} onClick={() => openDevice(d.mac)}>
              <DevIcon icon={d.icon || d.icon_auto} on={d.online} size={20} />
              <div className="col" style={{ gap: 0, minWidth: 0 }}><b>{d.name}</b><span className="dim ell" style={{ fontSize: 12 }}>{d.ip} · vor der Firewall ({d.attach?.iface})</span></div>
            </div>
            {i === 0 && wanOthers.length > 0 && (
              <div className="row wrap" style={{ gap: 4, flexBasis: '100%', paddingLeft: 52 }}>
                {wanOthers.map((o) => (
                  <span key={o.mac} className={'tmini' + (o.online ? '' : ' off')} title={[o.name, o.ip || o.mac, o.vendor, o.online ? 'online' : 'offline'].filter(Boolean).join(' · ')} onClick={() => openDevice(o.mac)}>
                    <DevIcon icon={o.icon || o.icon_auto} on={o.online} size={11} />{o.name.length > 18 ? o.name.slice(0, 17) + '…' : o.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </React.Fragment>
      ))}
      {!upstream.length && wanOthers.length > 0 && (
        <div className="tnode" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6, borderStyle: 'dashed', marginTop: 8 }}>
          <span className="dim" style={{ fontSize: 12 }}>{wanOthers.length} weitere Geräte im {upstream[0]?.attach?.iface || 'WAN'}-Netz ({wanOthers.filter((d) => d.online).length} online)</span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6 }}>
            <More n={0} items={wanOthers.map((d) => <DevChip key={d.mac} d={d} />)} />
          </div>
        </div>
      )}
      <div className="tconn"><span>{wanIf ? `${wanIf.device} · ${wanIf.descr}` : 'WAN'}</span></div>
      <div className="tnode">
        <span className="tic"><Router size={20} /></span>
        <div className="col" style={{ gap: 0 }}><b>OPNsense</b><span className="dim" style={{ fontSize: 12 }}>{full.system?.model} · CPU {full.system?.cpu ?? '–'} %</span></div>
        <div className="row wrap" style={{ gap: 4, marginLeft: 'auto' }}>
          {full.interfaces.filter((i) => i.kind === 'wan' || i.kind === 'port' || (i.kind === 'net' && !i.parent)).map((i) => (
            <span key={i.device} className="badge" title={i.media || ''}>{i.device}{i.kind === 'port' ? ' Trunk' : i.kind === 'wan' ? ' WAN' : ''}</span>
          ))}
        </div>
      </div>
      {sw ? (
        <>
          <div className="tconn"><span>{trunk?.device || 'LAN'} ↔ {uplink || '?'} · {speedLabel(sw.ports.find((p) => p.name === uplink)?.speed)}</span></div>
          <div className="tnode wide">
            <span className="tic"><Network size={20} /></span>
            <div className="col" style={{ gap: 0 }}><b>{sw.name}</b><span className="dim" style={{ fontSize: 12 }}>{sw.model} · {sw.ip} · FW {sw.fw}</span>
              {sw.unsaved && <div className="row gap6" style={{ marginTop: 6 }}>
                <Badge t="warn">nicht gespeicherte Änderungen</Badge>
                <button className="btn sm" disabled={!!saving} onClick={async () => { setSaving('…'); try { await api('/api/switch/save', { method: 'POST', body: '{}' }); setSaving('') } catch (e: any) { setSaving(e.message) } }}><Save size={13} />Auf Switch speichern</button>
                {saving && saving !== '…' && <span className="err" style={{ fontSize: 12 }}>{saving}</span>}
              </div>}
            </div>
            <div style={{ marginLeft: 'auto' }}><PortPanel ports={sw.ports} uplink={uplink} sel={sel} onSel={(p) => { setSel(p); setPortEdit(p) }} /></div>
          </div>
          <div className="tbus" />
          <div className="tcols">
            {cols.map((p) => {
              const host = p.lldp[0]
              const hostDev = host ? byMac.get(host.mac) : undefined
              const isAp = !!(host && apMacs.has(host.mac))
              const here = devs.filter((d) => d.attach?.kind === 'switch' && d.attach.port === p.name && !d.attach.via && d.mac !== hostDev?.mac)
              const behind = devs.filter((d) => d.attach?.via_mac && d.attach.via_mac === host?.mac)
              const wifi = isAp ? devs.filter((d) => d.attach?.kind === 'wifi' && d.attach.ap_mac === host!.mac) : []
              const ssids = [...new Set(wifi.map((d) => d.attach?.ssid || '?'))]
              return (
                <div key={p.name} id={'tp-' + p.name} className={'tcol' + (sel === p.name ? ' sel' : '')}>
                  <div className="row gap6" style={{ marginBottom: 8, cursor: 'pointer' }} onClick={() => setPortEdit(p.name)} title="Port-Einstellungen">
                    <b>{p.name}</b>
                    <span className="badge" style={{ color: speedColor(p.speed) }}>{speedLabel(p.speed)} {p.form === 'sfp' ? 'SFP+' : 'RJ45'}</span>
                    <span className="dim ell" style={{ fontSize: 12 }}>{p.descr}</span>
                  </div>
                  {hostDev && <DevChip d={hostDev} hint={isAp ? `Access Point · ${wifi.length} Clients` : behind.length ? behind.length + ' Geräte dahinter' : undefined}
                    sub={isAp ? `Access Point · ${wifi.length} Clients` : `${hostDev.ip || ''}${behind.length ? ' · ' + behind.length + ' dahinter' : ''}`} />}
                  {!hostDev && host && <div className="tdev"><span className="dev-ic"><Server size={14} /></span><span>{host.name || host.mac}</span></div>}
                  {isAp && ssids.map((s) => (
                    <div key={s} className="tsub">
                      <div className="dim row gap6" style={{ fontSize: 11.5, margin: '2px 0 4px' }}><Wifi size={12} />{s}</div>
                      <More items={wifi.filter((d) => (d.attach?.ssid || '?') === s).sort((a, b) => (b.up + b.down) - (a.up + a.down) || (b.wifi?.signal || -99) - (a.wifi?.signal || -99)).map((d) => (
                        <DevChip key={d.mac} d={d} hint={`${s} · ${d.wifi?.signal ?? '?'} dBm`} sub={<span className="row gap6"><Signal dbm={d.wifi?.signal} />{d.ip}</span>} />
                      ))} />
                    </div>
                  ))}
                  {behind.length > 0 && (
                    <div className="tsub">
                      <div className="dim" style={{ fontSize: 11.5, margin: '2px 0 4px' }}>über {hostDev?.name || host?.name}</div>
                      <More items={[...behind].sort((a, b) => Number(b.online) - Number(a.online) || (b.up + b.down) - (a.up + a.down)).map((d) => <DevChip key={d.mac} d={d} />)} />
                    </div>
                  )}
                  <More items={here.map((d) => <DevChip key={d.mac} d={d} hint={d.attach?.stale ? 'zuletzt an diesem Port gesehen' : d.attach?.manual ? 'manuell zugewiesen' : undefined} sub={d.attach?.stale ? <span>{d.ip} · zuletzt gesehen</span> : undefined} />)} />
                  {!hostDev && !host && !here.length && (() => {
                    const guess = guesses.get(p.name)
                    return guess ? <><DevChip d={guess} hint={`laut Port-Name „${p.descr}“ (gerade keine MAC am Port)`} sub={<span>{guess.ip} · laut Port-Name</span>} /></> : <div className="dim" style={{ fontSize: 12 }}>Gerät unbekannt (MAC nicht zugeordnet)</div>
                  })()}
                </div>
              )
            })}
          </div>
        </>
      ) : <div style={{ marginTop: 16 }}><SrcError src={full.sources.switch} label="Switch" /></div>}

      {portEdit && sw && sw.ports.find((p) => p.name === portEdit) && <PortDrawer port={sw.ports.find((p) => p.name === portEdit)!} full={full} onClose={() => { setPortEdit(null); setSel(null) }} />}
      {assign && <AssignDialog d={assign} full={full} onClose={() => setAssign(null)} />}
      {(direct.length > 0 || unknown.length > 0) && (
        <div className="tcols" style={{ marginTop: 26, borderTop: 0 }}>
          {direct.length > 0 && (
            <div className="tcol">
              <div className="row gap6" style={{ marginBottom: 8 }}><b>Direkt an der OPNsense</b></div>
              <More items={direct.map((d) => <DevChip key={d.mac} d={d} hint={d.attach?.iface || undefined} sub={`${d.ip} · ${d.attach?.iface || ''}`} />)} />
            </div>
          )}
          {unknown.length > 0 && (
            <div className="tcol">
              <div className="row gap6" style={{ marginBottom: 8 }}><b>Anschluss unbekannt</b><Badge>{unknown.length}</Badge></div>
              <div className="dim" style={{ fontSize: 11.5, marginBottom: 6 }}>online, aber gerade in keiner MAC-Tabelle (z. B. an einem nicht verwalteten Switch)</div>
              <More items={unknown.map((d) => <DevChip key={d.mac} d={d} onAssign={setAssign} />)} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
