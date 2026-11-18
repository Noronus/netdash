import React, { useMemo, useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { api } from '../api'

export type Ep = Record<string, any> & { name: string; group?: string; url: string; conditions: string[] }
type Kind = 'http' | 'ping' | 'tcp' | 'dns' | 'other'

const PRESETS: Record<Kind, string[]> = {
  http: ['[STATUS] == 200', '[STATUS] < 400', '[RESPONSE_TIME] < 1000', '[CERTIFICATE_EXPIRATION] > 240h', '[BODY] == pat(*text*)'],
  ping: ['[CONNECTED] == true', '[RESPONSE_TIME] < 100'],
  tcp: ['[CONNECTED] == true', '[RESPONSE_TIME] < 500'],
  dns: ['[DNS_RCODE] == NOERROR', '[BODY] == 1.2.3.4'],
  other: ['[CONNECTED] == true'],
}
const DEFAULT_COND: Record<Kind, string> = { http: '[STATUS] == 200', ping: '[CONNECTED] == true', tcp: '[CONNECTED] == true', dns: '[DNS_RCODE] == NOERROR', other: '[CONNECTED] == true' }

function kindOf(ep: Ep): Kind {
  if (ep.dns) return 'dns'
  const u = ep.url || ''
  if (/^https?:\/\//.test(u)) return 'http'
  if (u.startsWith('icmp://')) return 'ping'
  if (u.startsWith('tcp://')) return 'tcp'
  return u ? 'other' : 'http'
}

export default function GatusEditor({ ep, groups, onClose, onSaved }: {
  ep: Ep | null; groups: string[]; onClose: () => void; onSaved: (msg: string) => void
}) {
  const isNew = !ep
  const [e, setE] = useState<Ep>(() => ep ? JSON.parse(JSON.stringify(ep)) : { name: '', group: groups[0] || '', url: 'https://', interval: '1m', conditions: ['[STATUS] == 200'] })
  const [kind, setKind] = useState<Kind>(kindOf(e))
  const [json, setJson] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const alert = (e.alerts || []).find((a: any) => a.type === 'custom')
  const up = (patch: Partial<Ep>) => setE((x) => ({ ...x, ...patch }))
  const host = useMemo(() => e.url.replace(/^[a-z]+:\/\//, '').replace(/:\d+$/, ''), [e.url])
  const port = useMemo(() => (e.url.match(/:(\d+)$/) || [])[1] || '', [e.url])

  function switchKind(k: Kind) {
    setKind(k)
    const h = host || ''
    const patch: Partial<Ep> = { conditions: [DEFAULT_COND[k]] }
    if (k === 'http') patch.url = 'https://' + h
    if (k === 'ping') patch.url = 'icmp://' + h
    if (k === 'tcp') patch.url = 'tcp://' + h + ':' + (port || '80')
    if (k === 'dns') { patch.url = (h || '127.0.0.1') + ':53'; patch.dns = e.dns || { 'query-name': 'example.com', 'query-type': 'A' } }
    else { const { dns, ...rest } = { ...e, ...patch } as any; setE(rest); return }
    up(patch)
  }

  function setAlert(on: boolean, patch: Record<string, any> = {}) {
    const others = (e.alerts || []).filter((a: any) => a.type !== 'custom')
    if (!on) return up({ alerts: others.length ? others : undefined })
    const cur = alert || { type: 'custom' }
    const next = { ...cur, ...patch }
    for (const k of Object.keys(next)) if (next[k] === '' || next[k] == null) delete next[k]
    up({ alerts: [...others, next] })
  }

  async function save() {
    setBusy(true); setErr('')
    try {
      let body = e
      if (json != null) body = JSON.parse(json)
      await api('/api/gatus/endpoint', { method: 'POST', body: JSON.stringify({ ep: body, old: ep ? { group: ep.group, name: ep.name } : null }) })
      onSaved(isNew ? `„${body.name}“ angelegt, ist in etwa 30 s aktiv.` : `„${body.name}“ gespeichert, ist in etwa 30 s aktiv.`)
    } catch (x: any) { setErr(x.message) } finally { setBusy(false) }
  }

  async function remove() {
    if (!ep || !confirm(`Check „${ep.name}“ wirklich löschen? Der Verlauf in Gatus geht verloren.`)) return
    setBusy(true); setErr('')
    try {
      await api('/api/gatus/delete', { method: 'POST', body: JSON.stringify({ group: ep.group, name: ep.name }) })
      onSaved(`„${ep.name}“ gelöscht.`)
    } catch (x: any) { setErr(x.message) } finally { setBusy(false) }
  }

  const client = e.client || {}
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-h">
          <div className="col grow"><b style={{ fontSize: 17 }}>{isNew ? 'Neuer Check' : e.name || 'Check'}</b><span className="dim" style={{ fontSize: 12.5 }}>Gatus-Monitoring</span></div>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="drawer-b">
          {json == null ? (
            <>
              <div className="form">
                <label>Name<input className="input" value={e.name} onChange={(x) => up({ name: x.target.value })} placeholder="z. B. Jellyfin" autoFocus={isNew} /></label>
                <label>Gruppe<input className="input" list="gatus-groups" value={e.group || ''} onChange={(x) => up({ group: x.target.value })} />
                  <datalist id="gatus-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist></label>
                <label>Art
                  <div className="seg">
                    {([['http', 'Webseite / HTTP'], ['ping', 'Ping'], ['tcp', 'TCP-Port'], ['dns', 'DNS'], ['other', 'Andere URL']] as [Kind, string][]).map(([k, l]) => (
                      <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => switchKind(k)}>{l}</button>
                    ))}
                  </div>
                </label>
                {kind === 'http' && <label>URL<input className="input mono" value={e.url} onChange={(x) => up({ url: x.target.value })} placeholder="https://host:port/pfad" /></label>}
                {kind === 'ping' && <label>Host / IP<input className="input mono" value={host} onChange={(x) => up({ url: 'icmp://' + x.target.value })} /></label>}
                {kind === 'tcp' && (
                  <div className="row" style={{ gap: 10 }}>
                    <label className="grow">Host / IP<input className="input mono" value={host} onChange={(x) => up({ url: 'tcp://' + x.target.value + ':' + port })} /></label>
                    <label style={{ width: 110 }}>Port<input className="input mono" value={port} onChange={(x) => up({ url: 'tcp://' + host + ':' + x.target.value })} /></label>
                  </div>
                )}
                {kind === 'dns' && (
                  <>
                    <label>DNS-Server<input className="input mono" value={e.url} onChange={(x) => up({ url: x.target.value })} placeholder="192.168.1.1:53" /></label>
                    <div className="row" style={{ gap: 10 }}>
                      <label className="grow">Abfrage<input className="input mono" value={e.dns?.['query-name'] || ''} onChange={(x) => up({ dns: { ...e.dns, 'query-name': x.target.value } })} /></label>
                      <label style={{ width: 110 }}>Typ<select className="input" value={e.dns?.['query-type'] || 'A'} onChange={(x) => up({ dns: { ...e.dns, 'query-type': x.target.value } })}>{['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'PTR', 'SRV'].map((t) => <option key={t}>{t}</option>)}</select></label>
                    </div>
                  </>
                )}
                {kind === 'other' && <label>URL<input className="input mono" value={e.url} onChange={(x) => up({ url: x.target.value })} placeholder="ssh://, tls://, starttls://, udp://, ws://" /></label>}
                <div className="row" style={{ gap: 10 }}>
                  <label style={{ width: 140 }}>Intervall<select className="input" value={e.interval || '1m'} onChange={(x) => up({ interval: x.target.value })}>
                    {[...new Set(['30s', '1m', '2m', '5m', '10m', '30m', '1h', e.interval || '1m'])].map((i) => <option key={i}>{i}</option>)}
                  </select></label>
                  {kind === 'http' && <label style={{ width: 140 }}>Timeout<input className="input" value={client.timeout || ''} placeholder="10s" onChange={(x) => up({ client: clean({ ...client, timeout: x.target.value }) })} /></label>}
                  {kind === 'http' && <label className="check"><input type="checkbox" checked={!!client.insecure} onChange={(x) => up({ client: clean({ ...client, insecure: x.target.checked || undefined }) })} />Zertifikat nicht prüfen</label>}
                </div>
              </div>

              <div className="form">
                <div className="lbl-sm">Bedingungen (alle müssen erfüllt sein)</div>
                {e.conditions.map((c, i) => (
                  <div key={i} className="row" style={{ gap: 6 }}>
                    <input className="input mono grow" value={c} onChange={(x) => up({ conditions: e.conditions.map((y, j) => (j === i ? x.target.value : y)) })} />
                    <button className="icon-btn" title="Entfernen" onClick={() => up({ conditions: e.conditions.filter((_, j) => j !== i) })}><Trash2 size={15} /></button>
                  </div>
                ))}
                <div className="row wrap" style={{ gap: 6 }}>
                  {PRESETS[kind].filter((p) => !e.conditions.includes(p)).map((p) => (
                    <button key={p} className="btn sm" onClick={() => up({ conditions: [...e.conditions, p] })}><Plus size={13} />{p}</button>
                  ))}
                </div>
              </div>

              <div className="form">
                <label className="check" style={{ alignSelf: "flex-start", paddingBottom: 0 }}><input type="checkbox" checked={!!alert} onChange={(x) => setAlert(x.target.checked)} />Push-Alarm aufs Handy (ntfy)</label>
                {alert && (
                  <div className="row" style={{ gap: 10 }}>
                    <label style={{ width: 170 }}>nach Fehlschlägen<input className="input" type="number" min={1} max={20} value={alert['failure-threshold'] || ''} placeholder="3 (Standard)" onChange={(x) => setAlert(true, { 'failure-threshold': x.target.value ? Number(x.target.value) : undefined })} /></label>
                    <label className="grow">Text im Alarm<input className="input" value={alert.description || ''} placeholder="optional" onChange={(x) => setAlert(true, { description: x.target.value })} /></label>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="form">
              <div className="lbl-sm">Alle Felder als JSON (für Sonderfälle wie Header, Body, SSH)</div>
              <textarea className="input mono" style={{ minHeight: 380, fontSize: 12 }} value={json} onChange={(x) => setJson(x.target.value)} />
            </div>
          )}
          {err && <div className="err">{err}</div>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Prüfe mit Gatus …' : 'Speichern'}</button>
            <button className="btn ghost" onClick={() => setJson(json == null ? JSON.stringify(e, null, 2) : null)}>{json == null ? 'Als JSON bearbeiten' : 'Zum Formular'}</button>
            <span className="grow" />
            {!isNew && <button className="btn" style={{ color: 'var(--bad)' }} disabled={busy} onClick={remove}><Trash2 size={14} />Löschen</button>}
          </div>
          <div className="dim" style={{ fontSize: 12 }}>Vor dem Speichern startet das Dashboard Gatus testweise mit der neuen Konfiguration (ca. 6 s). Ist sie fehlerhaft, bleibt alles beim Alten.</div>
        </div>
      </aside>
    </>
  )
}

function clean(o: Record<string, any>) {
  const r: Record<string, any> = {}
  for (const [k, v] of Object.entries(o)) if (v !== '' && v != null && v !== false) r[k] = v
  return Object.keys(r).length ? r : undefined
}
