import React, { useEffect, useState } from 'react'
import { Activity, Pencil, Play, Plus, Radar, RotateCw, Square } from 'lucide-react'
import { api, Full, GatusEp, refreshState } from '../api'
import GatusEditor, { Ep } from './GatusEditor'
import { Badge, Card, Dot, Hist, SrcError } from '../components/ui'
import { pct } from '../format'

export default function Services({ full }: { full: Full }) {
  const svc = full.services || []
  const gatus = full.gatus || []
  const [cfg, setCfg] = useState<{ available: boolean; endpoints: Ep[]; groups: string[] } | null>(null)
  const [edit, setEdit] = useState<Ep | null | 'new'>(null)
  const [toast, setToast] = useState('')
  const [svcBusy, setSvcBusy] = useState<string | null>(null)
  const CRITICAL = ['nginx', 'webgui', 'lighttpd', 'netbird', 'dnsmasq', 'AdGuardHome', 'openssh', 'unbound']
  async function svcAction(id: string, action: 'start' | 'stop' | 'restart', label: string) {
    const name = id.split('/')[0]
    if (name === 'netdash' && action !== 'start') {
      if (!confirm(action === 'stop' ? 'Das Dashboard selbst stoppen? Diese Seite ist danach weg. Wieder starten nur in der OPNsense: Lobby → Dashboard → Dienste, oder System → Diagnose → Dienste.' : 'Das Dashboard neu starten? Die Seite verbindet sich nach ein paar Sekunden von selbst wieder.')) return
    } else if (CRITICAL.includes(name) && action !== 'start' && !confirm(`${label} ${action === 'stop' ? 'stoppen' : 'neu starten'}? Davon hängen DNS, VPN oder dieses Dashboard ab.`)) return
    setSvcBusy(id)
    try { await api('/api/service', { method: 'POST', body: JSON.stringify({ id, action }) }); setToast(`${label}: ${action === 'stop' ? 'gestoppt' : action === 'start' ? 'gestartet' : 'neu gestartet'}`) }
    catch (e: any) { setToast(e.message) } finally { setSvcBusy(null) }
  }
  const load = () => api('/api/gatus/endpoints').then(setCfg).catch(() => {})
  useEffect(() => { load() }, [])
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(''), 6000); return () => clearTimeout(t) } }, [toast])
  const findEp = (g: GatusEp) => cfg?.endpoints.find((e) => e.name === g.name && (e.group || '') === (g.group || ''))
  // checks that exist in the config but have no results yet (just created)
  const pending = (cfg?.endpoints || []).filter((e) => !gatus.some((g) => g.name === e.name && (g.group || '') === (e.group || '')))
  const groups = new Map<string, GatusEp[]>()
  for (const g of gatus) groups.set(g.group || 'Allgemein', [...(groups.get(g.group || 'Allgemein') || []), g])
  return (
    <>
      <Card title="Monitoring (Gatus)" icon={<Radar size={16} />}
        act={<>{cfg?.available && <button className="btn sm primary" onClick={() => setEdit('new')}><Plus size={14} />Neuer Check</button>}<Badge t={gatus.some((g) => g.ok === false) ? 'bad' : 'ok'}>{gatus.filter((g) => g.ok).length}/{gatus.length} ok</Badge></>}>
        {pending.length > 0 && <div className="dim" style={{ fontSize: 12.5, marginBottom: 10 }}>Wird gerade aktiv: {pending.map((p) => p.name).join(', ')}</div>}
        <SrcError src={full.sources.gatus} label="Gatus" />
        <div className="col" style={{ gap: 18 }}>
          {[...groups.entries()].map(([grp, eps]) => (
            <div key={grp}>
              <div className="dim" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>{grp}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 8 }}>
                {eps.sort((a, b) => Number(a.ok) - Number(b.ok)).map((g) => {
                  const ep = findEp(g)
                  return (
                  <div key={g.key} className="card ep-card" style={{ background: 'var(--surface-2)', boxShadow: 'none', borderColor: g.ok === false ? 'color-mix(in srgb, var(--bad) 40%, transparent)' : undefined }}>
                    <div className="card-b" style={{ padding: 11 }}>
                      <div className="row"><Dot t={g.ok == null ? 'off' : g.ok ? 'ok' : 'bad'} /><b className="ell grow">{g.name}</b><span className="num dim" style={{ fontSize: 12 }}>{g.ms != null ? g.ms + ' ms' : ''}</span><span className="num" style={{ fontSize: 12 }}>{pct(g.uptime, 1)}</span>
                        {ep ? <button className="icon-btn ep-act" style={{ width: 26, height: 26, margin: '-4px -6px -4px 0' }} title="Bearbeiten" onClick={() => setEdit(ep)}><Pencil size={13} /></button> : <span className="dim" title="kommt von vpn-push.sh" style={{ fontSize: 11 }}>extern</span>}</div>
                      <div style={{ marginTop: 8 }}><Hist h={g.hist} /></div>
                      {g.ok === false && g.errors?.length ? <div className="err" style={{ fontSize: 12, marginTop: 6 }}>{g.errors[0]}</div> : null}
                    </div>
                  </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card title="OPNsense-Dienste" icon={<Activity size={16} />} act={<Badge t={svc.some((x) => !x.running) ? 'bad' : 'ok'}>{svc.filter((x) => x.running).length}/{svc.length} laufen</Badge>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
          {[...svc].sort((a, b) => a.running - b.running || a.description.localeCompare(b.description)).map((x) => (
            <div key={x.id} className="row" style={{ padding: '9px 11px', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border-soft)' }}>
              <Dot t={x.running ? 'ok' : 'bad'} />
              <div className="col grow" style={{ gap: 0 }}>
                <b className="ell">{x.description}</b>
                <span className="dim mono" style={{ fontSize: 11 }}>{x.id}</span>
              </div>
              {x.locked ? <Badge>System</Badge> : null}
              <button className="icon-btn" style={{ width: 28, height: 28 }} disabled={svcBusy === x.id} title="neu starten" onClick={() => svcAction(x.id, 'restart', x.description)}><RotateCw size={14} className={svcBusy === x.id ? 'spin' : ''} /></button>
              {!x.locked && (x.running
                ? <button className="icon-btn" style={{ width: 28, height: 28 }} disabled={svcBusy === x.id} title="stoppen" onClick={() => svcAction(x.id, 'stop', x.description)}><Square size={13} /></button>
                : <button className="icon-btn" style={{ width: 28, height: 28, color: 'var(--ok)' }} disabled={svcBusy === x.id} title="starten" onClick={() => svcAction(x.id, 'start', x.description)}><Play size={14} /></button>)}
            </div>
          ))}
        </div>
      </Card>
      {edit && <GatusEditor ep={edit === 'new' ? null : edit} groups={cfg?.groups || []} onClose={() => setEdit(null)}
        onSaved={(m) => { setEdit(null); setToast(m); load(); refreshState().catch(() => {}) }} />}
      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
