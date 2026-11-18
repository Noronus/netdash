import React, { useState } from 'react'
import { Eye, Lightbulb, Network, RotateCw, Unplug, Wifi } from 'lucide-react'
import { api, Full } from '../api'
import { go, openDevice } from '../App'
import { Badge, Card, DevIcon, Meter, Signal, SrcError } from '../components/ui'
import { dur, radio } from '../format'

async function uni(what: string, body: any) {
  return api('/api/unifi/' + what, { method: 'POST', body: JSON.stringify(body) })
}

function WlanCard({ w, clients, say }: { w: NonNullable<Full['wlans']>[number]; clients: number; say: (m: string) => void }) {
  const [pass, setPass] = useState<string | null>(null)
  const [edit, setEdit] = useState(false)
  const [np, setNp] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (body: any, msg: string, warn?: string) => {
    if (warn && !confirm(warn)) return
    setBusy(true)
    try { await uni('wlan', { id: w.id, ...body }); say(msg); setEdit(false); setNp('') } catch (e: any) { say('Fehler: ' + e.message) } finally { setBusy(false) }
  }
  return (
    <Card className="c4" title={w.name} icon={<Wifi size={16} />}
      act={<button className={'switch' + (w.enabled ? ' on' : '')} disabled={busy} title={w.enabled ? 'WLAN abschalten' : 'WLAN einschalten'}
        onClick={() => run({ enabled: !w.enabled }, `${w.name} ${w.enabled ? 'abgeschaltet' : 'eingeschaltet'}`, w.enabled ? `${w.name} abschalten? ${clients} Geräte verlieren die Verbindung.` : undefined)}><i /></button>}>
      <div className="kpi"><div className="v">{clients}<small>Clients</small></div>
        <div className="s"><span>{(w.bands || []).map((b) => b.replace('g', ' GHz').replace('2 GHz', '2,4 GHz')).join(' · ')}</span><span>{w.wpa?.toUpperCase()}</span>{w.hidden && <span>versteckt</span>}</div></div>
      <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
        <button className="btn sm" onClick={async () => { if (pass) return setPass(null); try { const r: any = await uni('wlanpass', { id: w.id }); setPass(r.pass || '') } catch (e: any) { say(e.message) } }}><Eye size={13} />{pass != null ? 'verbergen' : 'Passwort'}</button>
        <button className="btn sm" onClick={() => setEdit(!edit)}>ändern</button>
        <button className="btn sm ghost" disabled={busy} onClick={() => run({ hidden: !w.hidden }, w.hidden ? 'SSID sichtbar' : 'SSID versteckt')}>{w.hidden ? 'sichtbar machen' : 'verstecken'}</button>
      </div>
      {pass != null && <div className="mono" style={{ marginTop: 8, padding: '6px 10px', borderRadius: 8, background: 'var(--surface-2)', userSelect: 'all' }}>{pass || '(kein Passwort)'}</div>}
      {edit && (
        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <input className="input mono grow" type="text" placeholder="neues Passwort (8–63 Zeichen)" value={np} onChange={(e) => setNp(e.target.value)} />
          <button className="btn sm primary" disabled={busy || np.length < 8} onClick={() => run({ pass: np }, 'Passwort geändert', `Passwort von ${w.name} ändern? Alle ${clients} Geräte müssen sich mit dem neuen Passwort neu verbinden.`)}>Speichern</button>
        </div>
      )}
    </Card>
  )
}

export default function WifiPage({ full }: { full: Full }) {
  const [toast, setToast] = useState('')
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(''), 5000) }
  const src = full.sources.unifi
  const infra = full.unifi_devices || []
  const wifi = full.devices.filter((d) => d.online && d.link === 'wifi')
  if (!infra.length) {
    return (
      <Card title="UniFi" icon={<Wifi size={16} />}>
        <SrcError src={src} label="UniFi" />
        <p className="muted" style={{ maxWidth: 640 }}>
          Für WLAN-Daten (Signal, Access Point, verbunden seit) braucht das Dashboard einen lokalen UniFi-Benutzer.
          Lege in UniFi OS unter <b>Admins &amp; Users</b> den Benutzer <span className="mono">netdash</span> an
          („Restrict to local access only“, Network-Rolle Site Admin) und trage ihn unter Einstellungen → Integrationen → UniFi ein.
        </p>
      </Card>
    )
  }
  const ssids = new Map<string, number>()
  for (const d of wifi) ssids.set(d.wifi?.essid || '?', (ssids.get(d.wifi?.essid || '?') || 0) + 1)
  const blocked = new Set(full.wifi_blocked || [])
  const aps = infra.filter((d) => d.type === 'uap')
  const sws = infra.filter((d) => d.type !== 'uap')
  return (
    <>
      <div className="grid">
        {(full.wlans || []).map((w) => <WlanCard key={w.id} w={w} clients={ssids.get(w.name) || 0} say={say} />)}
      </div>
      <div className="grid">
        {aps.map((ap) => (
          <Card key={ap.mac} className="c6" title={ap.name} icon={<Wifi size={16} />}
            act={<><Badge t={ap.state === 1 ? 'ok' : 'bad'}>{ap.state === 1 ? 'verbunden' : 'getrennt'}</Badge>{ap.upgradable && <Badge t="warn">Update</Badge>}
              <button className="icon-btn" title="LED blinken lassen (30 s)" onClick={async () => { await uni('device', { cmd: 'set-locate', mac: ap.mac }); say('LED blinkt'); setTimeout(() => uni('device', { cmd: 'unset-locate', mac: ap.mac }), 30000) }}><Lightbulb size={14} /></button>
              <button className="icon-btn" title="neu starten" onClick={async () => { if (!confirm(`${ap.name} neu starten? Alle WLAN-Geräte sind etwa 2 Minuten offline.`)) return; try { await uni('device', { cmd: 'restart', mac: ap.mac }); say(ap.name + ' startet neu') } catch (e: any) { say(e.message) } }}><RotateCw size={14} /></button></>}>
            <div className="dim" style={{ fontSize: 12.5, marginBottom: 10 }}>{ap.model} · {ap.ip} · v{ap.version} · läuft {dur(ap.uptime)}</div>
            {(ap.radios || []).map((r: any) => (
              <div key={r.radio} className="row" style={{ marginBottom: 8 }}>
                <span style={{ width: 70 }}>{radio(r.radio)}</span>
                <span className="dim" style={{ width: 70 }}>Kanal {r.channel}</span>
                <div className="grow"><Meter value={r.cu || 0} t={(r.cu || 0) > 70 ? 'bad' : (r.cu || 0) > 45 ? 'warn' : 'ok'} /></div>
                <span className="num dim" style={{ width: 90, textAlign: 'right' }}>{r.cu ?? 0} % Last</span>
                <span className="num" style={{ width: 70, textAlign: 'right' }}>{r.clients} Clients</span>
              </div>
            ))}
            <div className="list" style={{ margin: '8px -16px -8px' }}>
              {wifi.filter((d) => d.wifi?.ap_mac === ap.mac).sort((a, b) => (b.wifi?.signal || -99) - (a.wifi?.signal || -99)).map((d) => (
                <div key={d.mac} className="li click" onClick={() => openDevice(d.mac)}>
                  <DevIcon icon={d.icon || d.icon_auto} on size={15} />
                  <span className="ell grow">{d.name}</span>
                  <span className="dim" style={{ fontSize: 12 }}>{radio(d.wifi?.radio)}</span>
                  <Signal dbm={d.wifi?.signal} />
                  <span className="num dim" style={{ width: 60, textAlign: 'right', fontSize: 12 }}>{d.wifi?.signal} dBm</span>
                  <button className="icon-btn hide-btn" title="vom WLAN trennen (verbindet sich neu)" onClick={async (e) => { e.stopPropagation(); await uni('client', { cmd: 'kick-sta', mac: d.mac }); say(d.name + ' getrennt') }}><Unplug size={13} /></button>
                </div>
              ))}
            </div>
          </Card>
        ))}
        {sws.map((sw) => (
          <Card key={sw.mac} className="c6" title={sw.name} icon={<Network size={16} />} act={<Badge t={sw.state === 1 ? 'ok' : 'bad'}>{sw.state === 1 ? 'verbunden' : 'getrennt'}</Badge>}>
            <div className="dim" style={{ fontSize: 12.5, marginBottom: 10 }}>{sw.model} · {sw.ip} · v{sw.version}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(46px, 1fr))', gap: 6 }}>
              {(sw.ports || []).map((p: any) => (
                <div key={p.idx} title={`${p.name}: ${p.up ? p.speed + ' Mbit/s' : 'kein Link'}`} style={{ textAlign: 'center', padding: '6px 0', borderRadius: 8, background: p.up ? 'var(--ok-soft)' : 'var(--surface-2)', color: p.up ? 'var(--ok)' : 'var(--text-3)', fontSize: 11.5, fontWeight: 600 }}>
                  {p.idx}<div style={{ fontSize: 10, fontWeight: 500 }}>{p.up ? (p.speed >= 1000 ? p.speed / 1000 + 'G' : p.speed + 'M') : '–'}</div>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
