import React, { useEffect, useMemo, useState } from 'react'
import { ArrowLeftRight, ExternalLink, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { api, Full } from '../api'
import { Badge, Card } from '../components/ui'

type Entry = {
  uuid: string; domain: string; host: string; port: string; https: boolean; websocket: boolean
  rewrite: string | null; locations: any[]; certificate: string
}
// domain suffix and rewrite answer come from the box (most common parent domain of the existing entries, LAN IP)
let SUFFIX = ''
let ANSWER = ''

function statusInfo(e: Entry, s: number | string | undefined): [('ok' | 'warn' | 'bad' | undefined), string, string?] {
  if (s === undefined) return [undefined, 'prüfe …']
  if (typeof s === 'string') return ['bad', s.includes('Timeout') ? 'keine Antwort' : 'nicht erreichbar', 'Das Ziel antwortet nicht. Läuft das Gerät bzw. der Dienst?']
  if (s < 400) return ['ok', String(s)]
  if (s === 400 && !e.https && ['443', '8443', '9443'].includes(e.port)) return ['bad', '400', 'Das Ziel erwartet HTTPS. Stell das Protokoll auf HTTPS.']
  if (s === 502 || s === 504) return ['bad', String(s), 'nginx erreicht das Ziel nicht. Ist der Dienst gestartet, stimmt der Port?']
  if (s === 401 || s === 403) return ['ok', String(s), 'Ziel verlangt eine Anmeldung, das ist normal.']
  return ['warn', String(s)]
}

export default function Proxy({ full }: { full: Full }) {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [health, setHealth] = useState<Record<string, number | string>>({})
  const [edit, setEdit] = useState<Entry | 'new' | null>(null)
  const [toast, setToast] = useState('')
  const [err, setErr] = useState('')
  const load = () => api<{ entries: Entry[]; suffix: string; answer: string }>('/api/proxy').then((r) => { SUFFIX = r.suffix || ''; ANSWER = r.answer || ''; setEntries(r.entries) }).catch((e) => setErr(e.message))
  const check = () => { setHealth({}); api('/api/proxy/health').then(setHealth).catch(() => {}) }
  useEffect(() => { load(); check() }, [])
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(''), 7000); return () => clearTimeout(t) } }, [toast])
  const byIp = useMemo(() => {
    const m = new Map<string, string>()
    for (const d of full.devices) for (const ip of d.ipv4) m.set(ip, d.name)
    m.set('127.0.0.1', 'OPNsense (lokal)')
    return m
  }, [full.devices])

  return (
    <>
      <Card title="Reverse Proxy" icon={<ArrowLeftRight size={16} />} flush
        act={<><button className="btn sm ghost" onClick={check}><RefreshCw size={13} />Status prüfen</button><button className="btn sm primary" onClick={() => setEdit('new')}><Plus size={14} />Neuer Eintrag</button></>}>
        {err && <div className="err" style={{ padding: 16 }}>{err}</div>}
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Domain</th><th>Ziel</th><th>Protokoll</th><th>DNS (AdGuard)</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {(entries || []).map((e) => {
                const [t, label, hint] = statusInfo(e, health[e.domain])
                return (
                  <tr key={e.uuid} onClick={() => setEdit(e)}>
                    <td><div className="row gap6"><b>{e.domain}</b><a href={'https://' + e.domain} target="_blank" rel="noreferrer" onClick={(x) => x.stopPropagation()} className="dim" title="Öffnen"><ExternalLink size={13} /></a></div></td>
                    <td><div className="col" style={{ gap: 0 }}><span className="mono">{e.host}:{e.port}</span><span className="dim" style={{ fontSize: 12 }}>{byIp.get(e.host) || ''}</span></div></td>
                    <td><div className="row gap6"><Badge t={e.https ? 'acc' : undefined}>{e.https ? 'HTTPS' : 'HTTP'}</Badge>{e.websocket && <Badge>WebSocket</Badge>}</div></td>
                    <td>{e.rewrite ? <span className="mono dim">→ {e.rewrite}</span> : (
                      <button className="btn sm" onClick={async (x) => { x.stopPropagation(); await api('/api/proxy/rewrite', { method: 'POST', body: JSON.stringify({ domain: e.domain }) }); setToast('DNS-Rewrite für ' + e.domain + ' angelegt.'); load() }}>
                        <Plus size={13} />Rewrite anlegen</button>)}</td>
                    <td title={hint}><div className="col" style={{ gap: 2 }}><Badge t={t}>{label}</Badge>{hint && t !== 'ok' && <span className="dim" style={{ fontSize: 11.5, whiteSpace: 'normal', maxWidth: 260 }}>{hint}</span>}</div></td>
                    <td className="r"><Pencil size={14} className="dim" /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!entries && !err && <div className="empty">Lade …</div>}
        </div>
      </Card>
      <div className="dim" style={{ fontSize: 12.5 }}>
        Ein Eintrag hier legt im nginx-Plugin automatisch Upstream-Server, Upstream, Location und HTTP-Server an und auf Wunsch den
        DNS-Rewrite in AdGuard. Neue Einträge übernehmen Zertifikat und Einstellungen eines bestehenden Eintrags.{SUFFIX && <> Am besten passt ein Wildcard-Zertifikat für *{SUFFIX}.</>}
      </div>
      {edit && <ProxyEditor entry={edit === 'new' ? null : edit} full={full} onClose={() => setEdit(null)}
        onDone={(m) => { setEdit(null); setToast(m); load(); setTimeout(check, 1500) }} />}
      {toast && <div className="toast">{toast}</div>}
    </>
  )
}

function ProxyEditor({ entry, full, onClose, onDone }: { entry: Entry | null; full: Full; onClose: () => void; onDone: (m: string) => void }) {
  const isNew = !entry
  const [sub, setSub] = useState(entry ? '' : '')
  const [custom, setCustom] = useState(false)
  const [domain, setDomain] = useState(entry?.domain || '')
  const [host, setHost] = useState(entry?.host || '')
  const [port, setPort] = useState(entry?.port || '')
  const [https, setHttps] = useState(entry?.https || false)
  const [ws, setWs] = useState(entry?.websocket || false)
  const [rewrite, setRewrite] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const [delDns, setDelDns] = useState(true)
  const fqdn = isNew ? (custom || !SUFFIX ? domain.trim().toLowerCase() : (sub.trim().toLowerCase() ? sub.trim().toLowerCase() + SUFFIX : '')) : entry!.domain
  const devs = [...full.devices].filter((d) => d.ip).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))

  async function save() {
    setBusy(true); setErr('')
    try {
      if (isNew) {
        const r = await api<{ dns: boolean }>('/api/proxy', { method: 'POST', body: JSON.stringify({ domain: fqdn, host, port, https, websocket: ws, rewrite }) })
        onDone(`${fqdn} angelegt${rewrite ? (r.dns ? ' inkl. DNS-Rewrite' : ' (DNS-Rewrite gab es schon)') : ''}.`)
      } else {
        await api('/api/proxy/update', { method: 'POST', body: JSON.stringify({ uuid: entry!.uuid, host, port, https, websocket: ws }) })
        onDone(`${fqdn} gespeichert.`)
      }
    } catch (x: any) { setErr(x.message) } finally { setBusy(false) }
  }
  async function del() {
    setBusy(true); setErr('')
    try {
      await api('/api/proxy/delete', { method: 'POST', body: JSON.stringify({ uuid: entry!.uuid, rewrite: delDns }) })
      onDone(`${entry!.domain} gelöscht${delDns ? ' inkl. DNS-Rewrite' : ''}.`)
    } catch (x: any) { setErr(x.message) } finally { setBusy(false) }
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-h">
          <div className="col grow"><b style={{ fontSize: 17 }}>{isNew ? 'Neuer Proxy-Eintrag' : entry!.domain}</b><span className="dim" style={{ fontSize: 12.5 }}>nginx-Reverse-Proxy auf der OPNsense</span></div>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="drawer-b">
          <div className="form">
            {isNew && (
              custom ? (
                <label>Domain<input className="input mono" value={domain} onChange={(x) => setDomain(x.target.value)} placeholder="dienst.example.com" autoFocus /></label>
              ) : (
                <label>Domain
                  <div className="row" style={{ gap: 0 }}>
                    <input className="input mono grow" style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }} value={sub} onChange={(x) => setSub(x.target.value.replace(/[^a-zA-Z0-9-]/g, ''))} placeholder="z. B. grafana" autoFocus />
                    <span className="input mono dim" style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: 0, width: 'auto' }}>{SUFFIX}</span>
                  </div>
                </label>
              )
            )}
            {isNew && <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setCustom(!custom)}>{custom ? `Subdomain von ${SUFFIX.slice(1)}` : 'Andere Domain eingeben'}</button>}
            {isNew && custom && !fqdn.endsWith(SUFFIX) && fqdn && <div className="src-err">Das Wildcard-Zertifikat gilt nur für *{SUFFIX}. Für andere Domains zeigt der Browser eine Zertifikatswarnung.</div>}
            <label>Ziel-Gerät
              <select className="input" value={devs.some((d) => d.ip === host) ? host : ''} onChange={(x) => x.target.value && setHost(x.target.value)}>
                <option value="">– aus der Geräteliste wählen –</option>
                {devs.map((d) => <option key={d.mac} value={d.ip!}>{d.name} · {d.ip}{d.online ? '' : ' (offline)'}</option>)}
              </select>
            </label>
            <div className="row" style={{ gap: 10 }}>
              <label className="grow">IP oder Hostname<input className="input mono" value={host} onChange={(x) => setHost(x.target.value.trim())} placeholder="192.168.1.20" /></label>
              <label style={{ width: 110 }}>Port<input className="input mono" value={port} onChange={(x) => setPort(x.target.value.replace(/\D/g, ''))} placeholder="8080" /></label>
            </div>
            <label>Protokoll zum Ziel
              <div className="seg">
                <button type="button" className={!https ? 'on' : ''} onClick={() => setHttps(false)}>HTTP</button>
                <button type="button" className={https ? 'on' : ''} onClick={() => setHttps(true)}>HTTPS (Zertifikat des Ziels wird nicht geprüft)</button>
              </div>
            </label>
            <label className="check" style={{ alignSelf: 'flex-start', paddingBottom: 0 }}><input type="checkbox" checked={ws} onChange={(x) => setWs(x.target.checked)} />WebSocket erlauben <span className="dim" style={{ fontWeight: 400 }}>(Home Assistant, Unraid, UniFi, Terminals …)</span></label>
            {isNew && (
              <label className="check" style={{ alignSelf: 'flex-start', paddingBottom: 0 }}><input type="checkbox" checked={rewrite} onChange={(x) => setRewrite(x.target.checked)} />
                DNS-Rewrite in AdGuard anlegen <span className="dim mono" style={{ fontWeight: 400 }}>{fqdn || 'domain'} → {ANSWER || 'OPNsense'}</span></label>
            )}
          </div>
          {err && <div className="err">{err}</div>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" disabled={busy || !fqdn || !host || !port} onClick={save}>{busy ? 'Richte ein …' : isNew ? 'Anlegen' : 'Speichern'}</button>
            <span className="grow" />
            {!isNew && !confirmDel && <button className="btn" style={{ color: 'var(--bad)' }} onClick={() => setConfirmDel(true)}><Trash2 size={14} />Löschen</button>}
          </div>
          {confirmDel && (
            <div className="form" style={{ borderColor: 'color-mix(in srgb, var(--bad) 45%, transparent)' }}>
              <b>{entry!.domain} wirklich löschen?</b>
              <label className="check" style={{ alignSelf: 'flex-start', paddingBottom: 0 }}><input type="checkbox" checked={delDns} onChange={(x) => setDelDns(x.target.checked)} />DNS-Rewrite in AdGuard auch löschen</label>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" style={{ background: 'var(--bad)', borderColor: 'var(--bad)', color: '#fff' }} disabled={busy} onClick={del}>Endgültig löschen</button>
                <button className="btn ghost" onClick={() => setConfirmDel(false)}>Abbrechen</button>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
