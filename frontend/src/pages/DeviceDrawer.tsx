import React, { useEffect, useState } from 'react'
import { Ban, Cable, Check, Database, Pencil, Pin, Power, X } from 'lucide-react'
import ZfsDialog from '../components/Zfs'
import { api, Detail, Full, refreshState, saveDevice } from '../api'
import { AreaChart, Bars } from '../components/charts'
import DomainList from '../components/DomainList'
import AttachCell from '../components/Attach'
import AssignDialog from '../components/Assign'
import { Badge, Card, DevIcon, ICONS, Rate, Seg, Signal } from '../components/ui'
import { ago, bytes, clock, dateTime, day, num, radio, rate, since } from '../format'

function slots(rows: any[], step: number, n: number, key: string) {
  const by = new Map(rows.map((r) => [r[key], r]))
  const end = step === 3600 ? Math.floor(Date.now() / 3600000) * 3600 : Math.floor(Date.now() / 86400000) * 86400
  const out: { t: number; up: number; down: number }[] = []
  for (let i = n - 1; i >= 0; i--) {
    const t = end - i * step
    const r = by.get(t)
    out.push({ t, up: r?.up || 0, down: r?.down || 0 })
  }
  return out
}

export default function DeviceDrawer({ mac, full, onClose }: { mac: string; full: Full; onClose: () => void }) {
  const [det, setDet] = useState<Detail | null>(null)
  const [err, setErr] = useState('')
  const [edit, setEdit] = useState(false)
  const [name, setName] = useState('')
  const [icon, setIcon] = useState<string | null>(null)
  const [range, setRange] = useState<'48h' | '30d'>('48h')
  const [dnsTab, setDnsTab] = useState<'top' | 'blocked' | 'recent'>('top')
  const [assign, setAssign] = useState(false)
  const [busyAct, setBusyAct] = useState('')
  const [msg, setMsg] = useState('')
  const [staticForm, setStaticForm] = useState<{ ip: string; hostname: string } | null>(null)
  async function act(what: string, body: any, ok: string) {
    setBusyAct(what); setMsg('')
    try { await api('/api/device/' + mac + '/' + what, { method: 'POST', body: JSON.stringify(body) }); await refreshState(); reload(); setMsg(ok); setStaticForm(null) }
    catch (e: any) { setMsg('Fehler: ' + e.message) } finally { setBusyAct('') }
  }
  const dev = full.devices.find((d) => d.mac === mac) || det?.device
  const [zfs, setZfs] = useState(false)
  const un = full.unraid
  const isUnraid = !!(un?.zfs && un.ip && dev && (dev.ip === un.ip || dev.ipv4?.includes(un.ip)))

  const reload = () => api<Detail>('/api/device/' + mac).then(setDet).catch(() => {})
  useEffect(() => {
    let alive = true
    const load = () => api<Detail>('/api/device/' + mac).then((d) => alive && setDet(d)).catch((e) => alive && setErr(e.message))
    load()
    const t = setInterval(load, 4000)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => { alive = false; clearInterval(t); window.removeEventListener('keydown', esc) }
  }, [mac])

  if (!dev) return null
  const w = dev.wifi
  const live = det?.live || []
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-h">
          <DevIcon icon={edit ? icon || dev.icon_auto : dev.icon || dev.icon_auto} on={dev.online} lg />
          <div className="col grow">
            {edit ? (
              <input className="input" autoFocus value={name} placeholder={dev.hostname || dev.ip || ''} onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && save()} />
            ) : (
              <div className="row"><b style={{ fontSize: 17 }} className="ell">{dev.name}</b>
                <button className="icon-btn" title="Umbenennen" onClick={() => { setEdit(true); setName(dev.custom_name || ''); setIcon(dev.icon || null) }}><Pencil size={15} /></button></div>
            )}
            <div className="row gap6 wrap">
              <Badge t={dev.online ? 'ok' : undefined}>{dev.online ? 'online' : 'offline'}</Badge>
              {dev.blocked && <Badge t="bad">kein Internet</Badge>}
              {dev.link === 'wifi' && <Badge t="acc">WLAN</Badge>}
              {dev.link === 'wired' && <Badge>LAN</Badge>}
              {dev.network && <Badge>{dev.network}</Badge>}
              <span className="dim ell" style={{ fontSize: 12.5 }}>{dev.vendor}</span>
            </div>
          </div>
          {edit ? (
            <>
              <button className="icon-btn" title="Speichern" onClick={save}><Check size={18} /></button>
              <button className="icon-btn" title="Abbrechen" onClick={() => setEdit(false)}><X size={18} /></button>
            </>
          ) : <button className="icon-btn" onClick={onClose} title="Schließen"><X size={18} /></button>}
        </div>
        <div className="drawer-b">
          {edit && (
            <Card title="Symbol">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: 8 }}>
                {Object.entries(ICONS).map(([k, [C, label]]) => (
                  <button key={k} className="btn" style={{ flexDirection: 'column', gap: 4, padding: 8, borderColor: (icon || dev.icon_auto) === k ? 'var(--accent)' : undefined }}
                    onClick={() => setIcon(k === dev.icon_auto ? null : k)}>
                    <C size={20} /><span style={{ fontSize: 11 }}>{label}</span>
                  </button>
                ))}
              </div>
            </Card>
          )}
          {edit && (
            <Card title="Anschluss">
              <div className="row wrap" style={{ gap: 10 }}>
                <span className="grow"><AttachCell d={dev} long />{dev.attach?.manual && <span className="dim" style={{ fontSize: 12 }}> · fest zugewiesen</span>}</span>
                <button className="btn sm" onClick={() => setAssign(true)}><Cable size={13} />{dev.place ? 'Anschluss ändern' : 'Switch-Port fest zuweisen'}</button>
              </div>
            </Card>
          )}
          {err && <div className="err">{err}</div>}

          <div className="row wrap" style={{ gap: 8 }}>
            {isUnraid && <button className="btn sm primary" onClick={() => setZfs(true)}><Database size={13} />ZFS-Speicher</button>}
            <button className="btn sm" disabled={!!busyAct} onClick={() => act('wol', {}, 'Magic Packet gesendet.')}><Power size={13} />Aufwecken (WoL)</button>
            {dev.link !== 'wifi' && <button className="btn sm" onClick={() => setAssign(true)}><Cable size={13} />{dev.place ? 'Switch-Port ändern' : 'Switch-Port fest zuweisen'}</button>}
            <button className={'btn sm' + (dev.blocked ? ' primary' : '')} disabled={!!busyAct}
              onClick={() => (dev.blocked || confirm(`${dev.name} vom Internet trennen? Lokale Netze bleiben erreichbar.`)) && act('block', { on: !dev.blocked }, dev.blocked ? 'Internet wieder freigegeben.' : 'Internet gesperrt.')}>
              <Ban size={13} />{dev.blocked ? 'Internet freigeben' : 'Internet sperren'}</button>
            {dev.dhcp && <button className="btn sm" disabled={!!busyAct} onClick={() => setStaticForm({ ip: dev.ip || '', hostname: dev.hostname || dev.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') })}>
              <Pin size={13} />{dev.dhcp === 'static' ? 'Statisches DHCP-Lease ändern' : 'Statisches DHCP-Lease anlegen'}</button>}
            {dev.link === 'wifi' && <button className="btn sm" disabled={!!busyAct} onClick={async () => { setBusyAct('wifi'); try { await api('/api/unifi/client', { method: 'POST', body: JSON.stringify({ cmd: 'kick-sta', mac }) }); setMsg('Vom WLAN getrennt, verbindet sich neu.') } catch (e: any) { setMsg('Fehler: ' + e.message) } finally { setBusyAct('') } }}>WLAN trennen</button>}
            {(dev.link === 'wifi' || (full.wifi_blocked || []).includes(mac)) && <button className="btn sm" disabled={!!busyAct} onClick={async () => {
              const isB = (full.wifi_blocked || []).includes(mac)
              if (!isB && !confirm(`${dev.name} im WLAN blockieren? Es kann sich dann gar nicht mehr verbinden.`)) return
              setBusyAct('wifi'); try { await api('/api/unifi/client', { method: 'POST', body: JSON.stringify({ cmd: isB ? 'unblock-sta' : 'block-sta', mac }) }); await refreshState(); setMsg(isB ? 'WLAN-Sperre aufgehoben.' : 'Im WLAN blockiert.') } catch (e: any) { setMsg('Fehler: ' + e.message) } finally { setBusyAct('') } }}>
              {(full.wifi_blocked || []).includes(mac) ? 'WLAN freigeben' : 'WLAN blockieren'}</button>}
            {dev.dhcp === 'static' && <button className="btn sm ghost" disabled={!!busyAct} onClick={() => confirm('Statisches DHCP-Lease entfernen? Das Gerät bekommt dann wieder eine dynamische Adresse.') && act('static', { remove: true }, 'Statisches DHCP-Lease entfernt.')}>Lease entfernen</button>}
            {busyAct && <span className="dim" style={{ fontSize: 12.5 }}>läuft …</span>}
            {msg && <span style={{ fontSize: 12.5, color: msg.startsWith('Fehler') ? 'var(--bad)' : 'var(--ok)' }}>{msg}</span>}
          </div>
          {staticForm && (
            <div className="form">
              <div className="row" style={{ gap: 10 }}>
                <label className="grow">IP-Adresse<input className="input mono" value={staticForm.ip} onChange={(e) => setStaticForm({ ...staticForm, ip: e.target.value.trim() })} /></label>
                <label className="grow">Hostname<input className="input mono" value={staticForm.hostname} onChange={(e) => setStaticForm({ ...staticForm, hostname: e.target.value })} /></label>
              </div>
              <div className="dim" style={{ fontSize: 12 }}>Statisches DHCP-Lease in dnsmasq: das Gerät (MAC {dev.mac}) bekommt per DHCP immer diese Adresse. Wirkt beim nächsten DHCP-Erneuern des Geräts.</div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm primary" disabled={!!busyAct} onClick={() => act('static', { ...staticForm, descr: dev.name }, 'Statisches DHCP-Lease gespeichert.')}>Speichern</button>
                <button className="btn sm ghost" onClick={() => setStaticForm(null)}>Abbrechen</button>
              </div>
            </div>
          )}

          <div className="grid" style={{ gap: 10 }}>
            <Card className="c6"><div className="kpi"><span className="dim">Jetzt</span><div className="row" style={{ gap: 14 }}><Rate v={dev.down} dir="d" /><Rate v={dev.up} dir="u" /></div><span className="dim" style={{ fontSize: 12 }}>{dev.conns} Verbindungen</span></div></Card>
            <Card className="c6"><div className="kpi"><span className="dim">Heute / Monat</span><b className="num">{bytes(dev.today_down + dev.today_up)} <span className="dim">/ {bytes(dev.month_down + dev.month_up)}</span></b><span className="dim" style={{ fontSize: 12 }}>↓ {bytes(dev.today_down)} · ↑ {bytes(dev.today_up)} heute</span></div></Card>
          </div>

          <Card title="Live (5 Min)" act={<div className="legend"><span><i style={{ background: 'var(--down)' }} />Download</span><span><i style={{ background: 'var(--up)' }} />Upload</span></div>}>
            {live.length > 2 ? (
              <AreaChart h={150} fmt={rate} series={[
                { label: 'Download', color: 'var(--down)', data: live.map((p) => [p[0], p[2]]) },
                { label: 'Upload', color: 'var(--up)', data: live.map((p) => [p[0], p[1]]) },
              ]} />
            ) : <div className="empty">Gerade kein Datenverkehr</div>}
          </Card>

          <Card title="Datenvolumen" act={<Seg value={range} onChange={setRange} options={[['48h', '48 Std'], ['30d', '30 Tage']]} />}>
            {range === '48h' ? (
              <Bars h={150} fmt={bytes} a={{ color: 'var(--down)', label: 'Download' }} b={{ color: 'var(--up)', label: 'Upload' }}
                data={slots(det?.hours || [], 3600, 48, 'hour').map((h) => ({ label: clock(h.t), title: day(h.t) + ' ' + clock(h.t), a: h.down, b: h.up }))} />
            ) : (
              <Bars h={150} fmt={bytes} a={{ color: 'var(--down)', label: 'Download' }} b={{ color: 'var(--up)', label: 'Upload' }}
                data={slots(det?.days || [], 86400, 30, 'day').map((h) => ({ label: day(h.t).slice(4), title: day(h.t), a: h.down, b: h.up }))} />
            )}
          </Card>

          {w && (
            <Card title="WLAN">
              <dl className="kv">
                <dt>Netz (SSID)</dt><dd>{w.essid}{w.guest ? ' (Gast)' : ''}</dd>
                <dt>Access Point</dt><dd>{w.ap || w.ap_mac}</dd>
                <dt>Band / Kanal</dt><dd>{radio(w.radio)} · Kanal {w.channel} {w.proto ? '· Wi-Fi ' + w.proto : ''}</dd>
                <dt>Signal</dt><dd className="row gap6"><Signal dbm={w.signal} /> {w.signal} dBm</dd>
                <dt>Qualität</dt><dd>{w.satisfaction != null ? w.satisfaction + ' %' : '–'}</dd>
                <dt>Link-Rate</dt><dd>↓ {w.tx_rate ? Math.round(w.tx_rate / 1000) + ' Mbit/s' : '–'} · ↑ {w.rx_rate ? Math.round(w.rx_rate / 1000) + ' Mbit/s' : '–'}</dd>
                <dt>Verbunden seit</dt><dd>{w.uptime ? since(Date.now() / 1000 - w.uptime) : '–'}</dd>
              </dl>
            </Card>
          )}

          <Card title="Details">
            <dl className="kv">
              <dt>IPv4</dt><dd className="mono">{dev.ipv4.length ? dev.ipv4.join(', ') : dev.ip || '–'}</dd>
              {dev.ipv6.length > 0 && <><dt>IPv6</dt><dd className="mono" style={{ fontSize: 11.5 }}>{dev.ipv6.join('\n')}</dd></>}
              <dt>MAC</dt><dd className="mono">{dev.mac}{dev.private_mac ? <span className="dim"> · private/zufällige MAC</span> : null}</dd>
              <dt>Angeschlossen</dt><dd className="row gap6"><AttachCell d={dev} long />{dev.attach?.manual && <Badge>fest zugewiesen</Badge>}<button className="btn sm" onClick={() => setAssign(true)}>{dev.place ? 'ändern' : 'fest zuweisen'}</button></dd>
              <dt>Netz</dt><dd>{(dev.networks && dev.networks.length ? dev.networks : [dev.network]).join(', ') || '–'}</dd>
              <dt>Hostname</dt><dd>{dev.hostname || '–'}</dd>
              <dt>DHCP</dt><dd>{dev.dhcp === 'static' ? 'statisches DHCP-Lease (dnsmasq)' : dev.dhcp === 'dynamic' ? `dynamisch, läuft ab ${dateTime(dev.lease_expire)}` : 'kein DHCP, IP ist am Gerät fest eingestellt'}</dd>
              <dt>{dev.online ? 'Verbunden seit' : 'Zuletzt gesehen'}</dt><dd>{dev.online ? `${since(dev.connected_since)} (${dateTime(dev.connected_since)})` : ago(dev.last_seen)}</dd>
              <dt>Zuerst gesehen</dt><dd>{dateTime(dev.first_seen)}</dd>
              {dev.switch && <><dt>Switch-Port</dt><dd>{dev.switch.name || dev.switch.mac} {dev.switch.port ? '· Port ' + dev.switch.port : ''}</dd></>}
            </dl>
          </Card>

          <Card title={`DNS · ${num(dev.dns_q24)} Anfragen in 24 Std`} act={dev.dns_b24 ? <Badge t="bad">{num(dev.dns_b24)} blockiert</Badge> : null}>
            {det && det.dns.hours.length > 0 && (
              <Bars h={90} fmt={num} a={{ color: 'var(--violet)', label: 'Anfragen' }} b={{ color: 'var(--bad)', label: 'Blockiert' }}
                data={det.dns.hours.map((h) => ({ label: clock(h.hour), a: h.q, b: h.b }))} />
            )}
            <div style={{ margin: '12px 0 8px' }}><Seg value={dnsTab} onChange={setDnsTab} options={[['top', 'Top-Domains'], ['blocked', 'Blockiert'], ['recent', 'Letzte Anfragen']]} /></div>
            <div className="list" style={{ margin: '0 -16px' }}>
              {dnsTab === 'top' && <DomainList rows={det?.dns.top || []} onHidden={reload} />}
              {dnsTab === 'blocked' && <DomainList rows={det?.dns.top_blocked || []} bad onHidden={reload} />}
              {dnsTab === 'recent' && (det?.dns.recent || []).slice(0, 60).map((r, i) => (
                <div key={i} className="li"><span className="dim num" style={{ width: 44, fontSize: 12 }}>{clock(r.t)}</span><span className="mono ell grow" style={{ color: r.blocked ? 'var(--bad)' : undefined }}>{r.domain}</span><span className="dim" style={{ fontSize: 11.5 }}>{r.type}</span></div>
              ))}
              {det && dnsTab === 'recent' && !det.dns.recent.length && <div className="empty">Keine Einträge</div>}
            </div>
          </Card>
        </div>
      </aside>
      {assign && <AssignDialog d={dev} full={full} onClose={() => setAssign(false)} />}
      {zfs && <ZfsDialog title={un?.hostname || dev.name} onClose={() => setZfs(false)} />}
    </>
  )

  async function save() {
    try {
      await saveDevice(mac, { name: name.trim() || null, icon })
      setEdit(false)
    } catch (e: any) { setErr(e.message) }
  }
}
