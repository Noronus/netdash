import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { api, Device, Full, refreshState, SwPort } from '../api'
import { go } from '../App'
import { speedLabel } from './Attach'
import { Badge, DevIcon } from './ui'

const COPPER = [['auto', 'Automatisch'], ['auto_100', 'Auto bis 100M'], ['auto_1000', 'Auto bis 1G'], ['auto_2500', 'Auto bis 2,5G'], ['10', 'fest 10M'], ['100', 'fest 100M']]
const TENG = [['auto', 'Automatisch'], ['1000', 'fest 1G'], ['10000', 'fest 10G']]

function VlanEditor({ port, full, isUplink, isMine }: { port: SwPort; full: Full; isUplink: boolean; isMine: boolean }) {
  const [info, setInfo] = useState<{ mode: number; all: number[]; untagged: number | null; tagged: number[] } | null>(null)
  const [u, setU] = useState<number | null>(null)
  const [t, setT] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const load = () => api<any>('/api/switch/vlaninfo?port=' + port.name).then((r) => {
    // an incomplete answer must not take the whole page down
    const i = { mode: r.mode ?? 0, all: r.all || [], untagged: r.untagged ?? null, tagged: r.tagged || [] }
    setInfo(i); setU(i.untagged); setT(i.tagged)
  }).catch((e) => setMsg('Fehler: ' + e.message))
  useEffect(() => { load() }, [port.name])
  const vname = (v: number) => {
    const i = full.interfaces.find((x) => Number(x.vlan) === v)
    return v === 1 ? 'Default (untagged LAN)' : i ? i.descr : ''
  }
  if (!info) return <div className="form"><div className="lbl-sm">VLANs</div><span className="dim">lade …</span></div>
  const dirty = u !== info.untagged || [...t].sort().join(',') !== [...info.tagged].sort().join(',')
  async function save(force = false) {
    if ((isUplink || isMine) && !confirm(isUplink ? 'Das ist der Uplink zur OPNsense. Falsche VLANs trennen Netze oder den ganzen Switch. Wirklich ändern?' : 'Dein Gerät hängt an diesem Port. Wenn das Untagged-VLAN nicht passt, verlierst du die Verbindung. Wirklich ändern?')) return
    setBusy(true); setMsg('')
    try { const r = await api<any>('/api/switch/vlans', { method: 'POST', body: JSON.stringify({ port: port.name, untagged: u, tagged: t, force: force || isUplink }) }); setInfo(r.vlans); setMsg('Gespeichert, bleibt auch nach einem Neustart des Switches.'); refreshState() }
    catch (e: any) { setMsg('Fehler: ' + e.message) } finally { setBusy(false) }
  }
  return (
    <div className="form">
      <div className="lbl-sm">VLANs ({info.mode === 2 ? 'Trunk' : info.mode === 1 ? 'Access' : 'Modus ' + info.mode})</div>
      <label>Untagged / Native VLAN (PVID)
        <select className="input" value={u ?? ''} onChange={(e) => setU(Number(e.target.value))}>
          {info.all.map((v) => <option key={v} value={v}>VLAN {v}{vname(v) ? ' · ' + vname(v) : ''}</option>)}
        </select>
      </label>
      {info.mode === 2 && (
        <>
          <div className="lbl-sm" style={{ fontWeight: 500 }}>Tagged VLANs</div>
          <div className="row wrap" style={{ gap: 6 }}>
            {info.all.filter((v) => v !== u).map((v) => (
              <label key={v} className="check" style={{ padding: '4px 8px', borderRadius: 8, background: 'var(--surface-2)', alignSelf: 'auto' }}>
                <input type="checkbox" checked={t.includes(v)} onChange={(e) => setT(e.target.checked ? [...t, v] : t.filter((x) => x !== v))} />VLAN {v}{vname(v) ? <span className="dim"> {vname(v)}</span> : null}
              </label>
            ))}
          </div>
        </>
      )}
      {msg && <div style={{ fontSize: 12.5, color: msg.startsWith('Fehler') ? 'var(--bad)' : 'var(--ok)' }}>{msg}</div>}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={busy || !dirty || u == null} onClick={() => save()}>{busy ? 'Übertrage …' : 'VLANs übernehmen'}</button>
        {dirty && <button className="btn ghost" onClick={() => { setU(info.untagged); setT(info.tagged) }}>zurücksetzen</button>}
      </div>
    </div>
  )
}

export default function PortDrawer({ port, full, onClose }: { port: SwPort; full: Full; onClose: () => void }) {
  const [descr, setDescr] = useState(port.descr)
  const [enabled, setEnabled] = useState(port.admin)
  const [speed, setSpeed] = useState((port as any).admin_speed || 'auto')
  // follow changes from the switch (e.g. after saving) unless the field is being edited
  const base = useRef({ descr: port.descr, enabled: port.admin, speed: (port as any).admin_speed || 'auto' })
  useEffect(() => {
    const nb = { descr: port.descr, enabled: port.admin, speed: (port as any).admin_speed || 'auto' }
    const ob = base.current
    if (descr === ob.descr) setDescr(nb.descr)
    if (enabled === ob.enabled) setEnabled(nb.enabled)
    if (speed === ob.speed) setSpeed(nb.speed)
    base.current = nb
  }, [port.descr, port.admin, (port as any).admin_speed])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [me, setMe] = useState<{ ip: string; mac: string | null } | null>(null)
  useEffect(() => { api('/api/whoami').then(setMe).catch(() => {}) }, [])
  const sw = full.switch!
  const isUplink = sw.uplink === port.name
  const mine = me?.mac ? full.devices.find((d) => d.mac === me.mac) : undefined
  const myPort = mine?.attach?.kind === 'switch' ? mine.attach.port : mine?.attach?.kind === 'wifi' ? mine.attach.port : undefined
  const isMine = myPort === port.name
  const opts = port.name.startsWith('MGE') ? COPPER : TENG
  const devs = full.devices.filter((d) => d.attach?.port === port.name)
  const byMac = new Map(full.devices.map((d) => [d.mac, d]))
  const dirty = descr !== port.descr || enabled !== port.admin || speed !== ((port as any).admin_speed || 'auto')

  async function save(force = false) {
    setBusy(true); setErr(''); setOk('')
    try {
      await api('/api/switch/port', { method: 'POST', body: JSON.stringify({ port: port.name, descr, enabled, speed, force }) })
      base.current = { descr, enabled, speed }
      await refreshState()
      setOk('Gespeichert, bleibt auch nach einem Neustart des Switches.')
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-h">
          <div className="col grow">
            <b style={{ fontSize: 17 }}>Port {port.name}{port.descr ? ' · ' + port.descr : ''}</b>
            <div className="row gap6"><Badge t={port.up ? 'ok' : undefined}>{port.up ? 'Link ' + speedLabel(port.speed) : 'kein Link'}</Badge>{isUplink && <Badge t="acc">Uplink zur OPNsense</Badge>}{isMine && <Badge t="warn">dein Gerät hängt hier</Badge>}<Badge>{port.form === 'sfp' ? 'SFP+' : 'RJ45'}</Badge><span className="dim" style={{ fontSize: 12 }}>{port.type}</span></div>
          </div>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="drawer-b">
          <div className="form">
            <label>Beschreibung<input className="input" maxLength={32} value={descr} onChange={(e) => setDescr(e.target.value)} placeholder="z. B. Büro-PC" /></label>
            <label className="check" style={{ alignSelf: 'flex-start', padding: 0 }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Port eingeschaltet</label>
            {!enabled && (isUplink || isMine) && (
              <div className="src-err"><AlertTriangle size={14} />{isUplink ? 'Abschalten trennt den kompletten Switch von der OPNsense, auch das Dashboard.' : 'Dein aktuelles Gerät hängt an diesem Port, du sperrst dich aus.'} Die Änderung wird sofort dauerhaft gespeichert, zurück geht es dann nur noch direkt am Switch.</div>
            )}
            <label>Geschwindigkeit<select className="input" value={speed} onChange={(e) => setSpeed(e.target.value)}>
              {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              {!opts.some(([v]) => v === speed) && <option value={speed}>{speed}</option>}
            </select></label>
            {err && <div className="err">{err}</div>}
            {ok && <div style={{ color: 'var(--ok)', fontSize: 13 }}>{ok}</div>}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn primary" disabled={busy || !dirty} onClick={() => save(!enabled && isUplink)}>{busy ? 'Übertrage …' : 'Übernehmen'}</button>
            </div>
          </div>
          <VlanEditor port={port} full={full} isUplink={isUplink} isMine={isMine} />
          <div className="form">
            <div className="lbl-sm">Geräte an diesem Port ({port.macs.length} MAC-Adressen)</div>
            {devs.map((d) => (
              <div key={d.mac} className="tdev" onClick={() => go('devices', d.mac)}>
                <DevIcon icon={d.icon || d.icon_auto} on={d.online} size={14} />
                <span className="grow ell">{d.name}</span><span className="dim mono" style={{ fontSize: 11 }}>{d.ip}</span>
              </div>
            ))}
            {port.macs.filter((m) => !byMac.has(m.mac)).map((m) => <div key={m.mac} className="dim mono" style={{ fontSize: 12 }}>{m.mac} · VLAN {m.vlan}</div>)}
            {port.lldp.map((l) => <div key={l.mac} className="dim" style={{ fontSize: 12 }}>LLDP: {l.name || l.mac}</div>)}
          </div>
        </div>
      </aside>
    </>
  )
}
