import React, { useState } from 'react'
import { X } from 'lucide-react'
import { Device, Full, saveDevice } from '../api'

/** manual "where is this device plugged in" for devices the switch/UniFi cannot place */
export default function AssignDialog({ d, full, onClose }: { d: Device; full: Full; onClose: () => void }) {
  const cur = d.place
  const [kind, setKind] = useState<'switch' | 'via' | 'firewall' | 'none'>(cur?.kind || 'switch')
  const [port, setPort] = useState(cur?.port || '')
  const [via, setVia] = useState(cur?.via_mac || '')
  const [iface, setIface] = useState(cur?.iface || d.network || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const ports = full.switch?.ports || []
  const hosts = full.devices.filter((x) => x.mac !== d.mac && (x.online || x.infra)).sort((a, b) => a.name.localeCompare(b.name))
  const nets = full.interfaces.filter((i) => i.kind !== 'port' && i.kind !== 'vpn')
  async function save() {
    setBusy(true); setErr('')
    try {
      const place = kind === 'none' ? null : kind === 'switch' ? { kind, port } : kind === 'via' ? { kind, via_mac: via } : { kind, iface }
      await saveDevice(d.mac, { place } as any)
      onClose()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const ok = kind === 'none' || (kind === 'switch' && port) || (kind === 'via' && via) || (kind === 'firewall' && iface)
  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row"><b className="grow">Anschluss von {d.name} festlegen</b><button className="icon-btn" onClick={onClose}><X size={16} /></button></div>
        <div className="dim" style={{ fontSize: 12.5 }}>Gilt immer, auch wenn das Gerät aus ist. Nur wenn der Switch oder UniFi das Gerät gerade live an einem anderen Anschluss sieht, wird dieser angezeigt.</div>
        <label className="check" style={{ alignSelf: 'flex-start', padding: 0 }}><input type="radio" checked={kind === 'switch'} onChange={() => setKind('switch')} />Am Switch-Port</label>
        {kind === 'switch' && (
          <select className="input" value={port} onChange={(e) => setPort(e.target.value)}>
            <option value="">– Port wählen –</option>
            {ports.map((p) => <option key={p.name} value={p.name}>{p.name}{p.descr ? ' · ' + p.descr : ''}{p.up ? '' : ' (kein Link)'}</option>)}
          </select>
        )}
        <label className="check" style={{ alignSelf: 'flex-start', padding: 0 }}><input type="radio" checked={kind === 'via'} onChange={() => setKind('via')} />Hinter einem anderen Gerät (z. B. Mini-Switch, Server)</label>
        {kind === 'via' && (
          <select className="input" value={via} onChange={(e) => setVia(e.target.value)}>
            <option value="">– Gerät wählen –</option>
            {hosts.map((h) => <option key={h.mac} value={h.mac}>{h.name} · {h.ip || h.mac}</option>)}
          </select>
        )}
        <label className="check" style={{ alignSelf: 'flex-start', padding: 0 }}><input type="radio" checked={kind === 'firewall'} onChange={() => setKind('firewall')} />Direkt an der OPNsense</label>
        {kind === 'firewall' && (
          <select className="input" value={iface} onChange={(e) => setIface(e.target.value)}>
            {nets.map((i) => <option key={i.device} value={i.descr}>{i.descr}</option>)}
          </select>
        )}
        {cur && <label className="check" style={{ alignSelf: 'flex-start', padding: 0 }}><input type="radio" checked={kind === 'none'} onChange={() => setKind('none')} />Zuweisung entfernen</label>}
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onClose}>Abbrechen</button>
          <button className="btn primary" disabled={busy || !ok} onClick={save}>Speichern</button>
        </div>
      </div>
    </div>
  )
}
