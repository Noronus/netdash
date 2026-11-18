import React, { useEffect, useState } from 'react'
import { Copy, Download, X } from 'lucide-react'
import QRCode from 'qrcode'
import { api, refreshState } from '../api'

/** shows a client config with QR code, copy and download */
export function WgConfigView({ name, config, onClose, fresh }: { name: string; config: string; onClose: () => void; fresh?: boolean }) {
  const [svg, setSvg] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => { QRCode.toString(config, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(setSvg).catch(() => setSvg('')) }, [config])
  const download = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([config], { type: 'text/plain' }))
    a.download = name + '.conf'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" style={{ width: 'min(760px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="row"><b className="grow">{fresh ? `Tunnel ${name} ist angelegt` : `Client-Konfiguration ${name}`}</b><button className="icon-btn" onClick={onClose}><X size={16} /></button></div>
        <div className="row wrap" style={{ gap: 16, alignItems: 'flex-start' }}>
          <div style={{ width: 220, background: '#fff', borderRadius: 12, padding: 8, flex: 'none' }} dangerouslySetInnerHTML={{ __html: svg }} />
          <div className="col grow" style={{ gap: 8, minWidth: 260 }}>
            <pre className="console" style={{ minHeight: 0, maxHeight: 300, fontSize: 11.5 }}>{config}</pre>
            <div className="row wrap" style={{ gap: 8 }}>
              <button className="btn sm primary" onClick={download}><Download size={13} />{name}.conf herunterladen</button>
              <button className="btn sm" onClick={() => navigator.clipboard.writeText(config).then(() => setCopied(true))}><Copy size={13} />{copied ? 'kopiert' : 'kopieren'}</button>
            </div>
          </div>
        </div>
        <div className="dim" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          Handy: WireGuard-App → „+“ → QR-Code scannen. PC: Datei in WireGuard importieren.
          {fresh && <> Den UDP-Port aus „Endpoint“ gegebenenfalls zusätzlich in der Firewall deines VPS-Anbieters freigeben.</>}
          {' '}Die Konfiguration enthält den privaten Schlüssel, nicht weitergeben.
        </div>
      </div>
    </div>
  )
}

type WgDefaults = { home_routes?: string; dns?: string; tun_net?: string; ports?: string }

export function NewTunnel({ onClose, onCreated, defs }: { onClose: () => void; onCreated: (name: string, config: string) => void; defs?: WgDefaults }) {
  const [name, setName] = useState('')
  const [route, setRoute] = useState<'home' | 'all'>('home')
  const [dns, setDns] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const valid = /^[a-z0-9][a-z0-9-]{0,11}$/.test(name)
  async function create() {
    setBusy(true); setErr('')
    try {
      const r = await api<{ name: string; config: string }>('/api/vps/wg', { method: 'POST', body: JSON.stringify({ action: 'create', name, route, dns: dns && defs?.dns ? 'adguard' : 'none' }) })
      await refreshState()
      onCreated(r.name, r.config)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row"><b className="grow">Neuer WireGuard-Tunnel auf dem VPS</b><button className="icon-btn" onClick={onClose}><X size={16} /></button></div>
        <label className="dlabel">Name (für wen / welches Gerät)
          <input className="input mono" autoFocus value={name} maxLength={12} placeholder="z. B. tablet" onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && valid && !busy && create()} />
        </label>
        <div className="dim" style={{ fontSize: 12, marginTop: -4 }}>wird zu wg-{name || 'name'}, höchstens 12 Zeichen (a-z, 0-9, -)</div>
        <div className="lbl-sm">Was soll durch den Tunnel?</div>
        <label className="check" style={{ alignSelf: 'flex-start', padding: 0 }}><input type="radio" checked={route === 'home'} onChange={() => setRoute('home')} />Nur das Heimnetz{defs?.home_routes ? ` (${defs.home_routes})` : ''}, Internet normal</label>
        <label className="check" style={{ alignSelf: 'flex-start', padding: 0 }}><input type="radio" checked={route === 'all'} onChange={() => setRoute('all')} />Alles, auch Internet über den VPS</label>
        {defs?.dns && <label className="check" style={{ alignSelf: 'flex-start', padding: 0 }}><input type="checkbox" checked={dns} onChange={(e) => setDns(e.target.checked)} />DNS-Server im Heimnetz verwenden ({defs.dns}), damit lokale Namen funktionieren</label>}
        <div className="dim" style={{ fontSize: 12 }}>Netz und Port sucht der VPS selbst aus (nächstes freies /30{defs?.tun_net ? ` in ${defs.tun_net}` : ''}{defs?.ports ? `, Port ${defs.ports}` : ''}). Der Tunnel startet sofort mit Autostart.</div>
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onClose}>Abbrechen</button>
          <button className="btn primary" disabled={!valid || busy} onClick={create}>{busy ? 'Lege an …' : 'Tunnel anlegen'}</button>
        </div>
      </div>
    </div>
  )
}
