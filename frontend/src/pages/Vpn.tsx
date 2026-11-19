import React, { useState } from 'react'
import { FileCode, Pencil, Play, Plus, Square, Trash2, Waypoints } from 'lucide-react'
import { EditTunnel, NewTunnel, WgConfigView } from '../components/WgTunnel'
import { api, Full, refreshState } from '../api'
import { Badge, Card, Dot, SrcError } from '../components/ui'
import { ago, bytes } from '../format'

function VpsWireGuard({ full }: { full: Full }) {
  const v = full.vps as any
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [show, setShow] = useState<{ name: string; config: string; fresh?: boolean } | null>(null)
  const tunnels: any[] = v?.wg || []
  if (!v) return null
  async function act(name: string, action: string, warn?: string) {
    if (warn && !confirm(warn)) return
    setBusy(name); setMsg('')
    try { await api('/api/vps/wg', { method: 'POST', body: JSON.stringify({ name, action }) }); await refreshState() }
    catch (e: any) { setMsg(e.message) } finally { setBusy(null) }
  }
  async function showConfig(name: string) {
    try { const r = await api<{ config: string }>('/api/vps/wg', { method: 'POST', body: JSON.stringify({ name, action: 'config' }) }); setShow({ name, config: r.config }) }
    catch (e: any) { setMsg(e.message) }
  }
  const sorted = [...tunnels].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
  return (
    <Card title={`${v.name || 'VPS'} · WireGuard-Tunnel`} icon={<Waypoints size={16} />} flush
      act={<><span>{tunnels.filter((t) => t.active).length} von {tunnels.length} aktiv</span><button className="btn sm primary" onClick={() => setCreating(true)}><Plus size={14} />Neuer Tunnel</button></>}>
      {v.wg_error && <div className="err" style={{ padding: '0 16px' }}>{v.wg_error}</div>}
      {msg && <div className="err" style={{ padding: '4px 16px' }}>{msg}</div>}
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Tunnel</th><th>Status</th><th>Adresse / Port</th><th>Gegenstelle</th><th>Netze</th><th className="r">Letzter Handshake</th><th className="r">Empfangen</th><th className="r">Gesendet</th><th></th></tr></thead>
          <tbody>
            {sorted.map((t) => {
              const p = t.peers[0] || {}
              const fresh = p.handshake && Date.now() / 1000 - p.handshake < 180
              const label = t.name.replace(/^wg-/, '') || t.name
              const note = (t.peers || []).map((x: any) => x.comment).filter(Boolean).join(', ')
              return (
                <tr key={t.name} className={t.active ? '' : 'off'} style={{ cursor: 'default' }}>
                  <td><div className="row gap6"><Dot t={!t.active ? 'off' : fresh ? 'ok' : 'warn'} /><b>{label}</b><span className="dim mono" style={{ fontSize: 11 }}>{t.name}</span>{note && <span className="dim ell" style={{ fontSize: 11.5, maxWidth: 160 }} title={note}>{note}</span>}{t.created && <span className="badge acc" style={{ padding: '1px 6px' }} title="vom Dashboard angelegt">netdash</span>}</div></td>
                  <td><div className="row gap6">{t.active ? <Badge t={fresh ? 'ok' : 'warn'}>{fresh ? 'verbunden' : 'aktiv, kein Handshake'}</Badge> : <Badge>aus</Badge>}{t.autostart && <Badge>Autostart</Badge>}</div></td>
                  <td className="mono" style={{ fontSize: 12 }}>{t.address}<span className="dim"> · {t.port}</span></td>
                  <td className="mono dim" style={{ fontSize: 12 }}>{p.endpoint || '–'}</td>
                  <td className="mono dim ell" style={{ fontSize: 12, maxWidth: 220 }} title={p.allowed}>{p.allowed}</td>
                  <td className="r num dim">{p.handshake ? ago(p.handshake) : 'nie'}</td>
                  <td className="r num">{p.rx != null ? bytes(p.rx) : '–'}</td>
                  <td className="r num">{p.tx != null ? bytes(p.tx) : '–'}</td>
                  <td className="r">
                    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      {t.active
                        ? <button className="btn sm" disabled={busy === t.name} onClick={() => act(t.name, 'down', `Tunnel ${label} stoppen? Die Gegenstelle verliert die Verbindung.`)}><Square size={12} />Stopp</button>
                        : <button className="btn sm" disabled={busy === t.name} onClick={() => act(t.name, 'up')}><Play size={12} />Start</button>}
                      <button className="btn sm ghost" disabled={busy === t.name} title="beim Booten des VPS starten" onClick={() => act(t.name, t.autostart ? 'autostart_off' : 'autostart_on')}>{t.autostart ? 'Autostart aus' : 'Autostart an'}</button>
                      <button className="icon-btn" title="Bearbeiten (Adresse, Port, AllowedIPs, Bezeichnung)" disabled={busy === t.name} onClick={() => setEditing(t.name)}><Pencil size={14} /></button>
                      {t.has_client && <button className="icon-btn" title="Client-Konfiguration / QR-Code" onClick={() => showConfig(t.name)}><FileCode size={14} /></button>}
                      {t.created && <button className="icon-btn" title="Tunnel löschen" disabled={busy === t.name} onClick={() => act(t.name, 'delete', `Tunnel ${label} löschen? Das Gerät kann sich danach nicht mehr verbinden. Die Konfiguration wird auf dem VPS archiviert.`)}><Trash2 size={14} /></button>}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {creating && <NewTunnel defs={v.wg_defaults} onClose={() => setCreating(false)} onCreated={(name, config) => { setCreating(false); setShow({ name, config, fresh: true }) }} />}
      {editing && tunnels.find((t) => t.name === editing) && <EditTunnel t={tunnels.find((t) => t.name === editing)} others={tunnels} onClose={() => setEditing(null)} />}
      {show && <WgConfigView name={show.name} config={show.config} fresh={show.fresh} onClose={() => setShow(null)} />}
    </Card>
  )
}

export default function Vpn({ full }: { full: Full }) {
  const nb = full.netbird
  const wg = full.wireguard || []
  // wt0 is NetBird (shown above with names), not a hand-made WireGuard tunnel
  const wgIfs = wg.filter((r) => r.type === 'interface' && !String(r.if).startsWith('wt'))
  return (
    <>
      <Card title="NetBird" icon={<Waypoints size={16} />}
        act={nb && <><Badge t={nb.management ? 'ok' : 'bad'}>Management</Badge><Badge t={nb.signal ? 'ok' : 'bad'}>Signal</Badge><span className="mono">{nb.ip}</span></>} flush>
        <SrcError src={full.sources.netbird} label="NetBird" />
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Peer</th><th>IP</th><th>Status</th><th>Verbindung</th><th className="r">Latenz</th><th className="r">Empfangen</th><th className="r">Gesendet</th><th className="r">Letzter Handshake</th></tr></thead>
            <tbody>
              {(nb?.peers || []).map((p) => (
                <tr key={p.fqdn} style={{ cursor: 'default' }} className={p.status === 'Connected' ? '' : 'off'}>
                  <td><div className="row gap6"><Dot t={p.status === 'Connected' ? 'ok' : 'off'} /><b>{p.name}</b></div></td>
                  <td className="mono">{p.ip}</td>
                  <td>{p.status === 'Connected' ? 'verbunden' : p.status === 'Connecting' ? 'nicht erreichbar' : p.status}</td>
                  <td>{p.status === 'Connected' ? <Badge t={p.type === 'P2P' ? 'ok' : 'warn'}>{p.type === 'P2P' ? 'direkt (P2P)' : 'über Relay'}</Badge> : '–'}</td>
                  <td className="r num">{p.status === 'Connected' && p.latency_ms ? p.latency_ms + ' ms' : '–'}</td>
                  <td className="r num">{p.rx ? bytes(p.rx) : '–'}</td>
                  <td className="r num">{p.tx ? bytes(p.tx) : '–'}</td>
                  <td className="r num dim">{p.handshake ? ago(Date.parse(p.handshake) / 1000) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <VpsWireGuard full={full} />
      {wgIfs.map((i) => {
        const peers = wg.filter((r) => r.type === 'peer' && r.if === i.if)
        return (
          <Card key={i.if} title={`WireGuard · ${i.ifname || i.if}`} icon={<Waypoints size={16} />}
            act={<><Badge t={i.status === 'up' ? 'ok' : 'bad'}>{i.status}</Badge><span className="mono">Port {i['listen-port']}</span></>} flush>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Peer</th><th>Endpoint</th><th>Erlaubte Netze</th><th className="r">Empfangen</th><th className="r">Gesendet</th><th className="r">Letzter Handshake</th></tr></thead>
                <tbody>
                  {peers.map((p) => {
                    const on = p['latest-handshake-age'] != null && p['latest-handshake-age'] < 300
                    return (
                      <tr key={p['public-key']} style={{ cursor: 'default' }} className={on ? '' : 'off'}>
                        <td><div className="row gap6"><Dot t={on ? 'ok' : 'off'} /><b>{p.name || p['public-key'].slice(0, 10)}</b></div></td>
                        <td className="mono">{p.endpoint || '–'}</td>
                        <td className="mono dim">{p['allowed-ips']}</td>
                        <td className="r num">{bytes(p['transfer-rx'])}</td>
                        <td className="r num">{bytes(p['transfer-tx'])}</td>
                        <td className="r num dim">{p['latest-handshake'] ? ago(p['latest-handshake']) : 'nie'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )
      })}
    </>
  )
}
