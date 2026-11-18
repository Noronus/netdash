import React, { useEffect, useState } from 'react'
import { ListFilter, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../api'
import { Badge, Card } from './ui'
import { dateTime, num } from '../format'

type F = { id: number; name: string; url: string; enabled: boolean; rules: number; updated: string }
type St = { enabled: boolean; protection: boolean; filters: F[]; user_rules: string[] }

export default function AdguardSettings({ toast }: { toast: (m: string) => void }) {
  const [st, setSt] = useState<St | null>(null)
  const [rules, setRules] = useState('')
  const [busy, setBusy] = useState('')
  const [nf, setNf] = useState({ name: '', url: '' })
  const load = () => api<St>('/api/adguard/filtering').then((s) => { setSt(s); setRules(s.user_rules.join('\n')) })
  useEffect(() => { load() }, [])
  async function post(what: string, body: any, msg: string) {
    setBusy(what)
    try { const r = await api<{ filtering: St }>('/api/adguard/' + what, { method: 'POST', body: JSON.stringify(body) }); setSt(r.filtering); setRules(r.filtering.user_rules.join('\n')); toast(msg) }
    catch (e: any) { toast('Fehler: ' + e.message) } finally { setBusy('') }
  }
  if (!st) return null
  const dirty = rules.trim() !== st.user_rules.join('\n').trim()
  return (
    <Card title="Filter & Regeln" icon={<ListFilter size={16} />}
      act={<>
        <span className="row gap6" style={{ color: 'var(--text)' }}>Schutz
          <button className={'switch' + (st.protection ? ' on' : '')} disabled={!!busy} onClick={() => post('protection', { enabled: !st.protection }, st.protection ? 'Schutz ausgeschaltet' : 'Schutz eingeschaltet')}><i /></button></span>
        <button className="btn sm" disabled={!!busy} onClick={() => post('refresh', {}, 'Filterlisten aktualisiert')}><RefreshCw size={13} className={busy === 'refresh' ? 'spin' : ''} />Listen aktualisieren</button>
      </>}>
      <div className="grid" style={{ gap: 14 }}>
        <div className="c7 col" style={{ gap: 8 }}>
          <div className="lbl-sm">Sperrlisten</div>
          {st.filters.map((f) => (
            <div key={f.url} className="row" style={{ padding: '8px 10px', borderRadius: 10, background: 'var(--surface-2)' }}>
              <button className={'switch' + (f.enabled ? ' on' : '')} disabled={!!busy} onClick={() => post('filter', { url: f.url, enabled: !f.enabled }, `${f.name} ${f.enabled ? 'aus' : 'an'}`)}><i /></button>
              <div className="col grow" style={{ gap: 0 }}><b className="ell">{f.name}</b><span className="dim mono ell" style={{ fontSize: 11 }}>{f.url}</span></div>
              <span className="num dim" style={{ fontSize: 12 }}>{f.rules ? num(f.rules) + ' Regeln' : ''}</span>
              <span className="dim" style={{ fontSize: 11.5, width: 110, textAlign: 'right' }}>{f.updated && !f.updated.startsWith('0001') ? dateTime(Date.parse(f.updated) / 1000) : ''}</span>
              <button className="icon-btn" title="entfernen" onClick={() => confirm(`${f.name} entfernen?`) && post('filter', { url: f.url, delete: true }, 'Liste entfernt')}><Trash2 size={13} /></button>
            </div>
          ))}
          <div className="row" style={{ gap: 6 }}>
            <input className="input" style={{ width: 160 }} placeholder="Name" value={nf.name} onChange={(e) => setNf({ ...nf, name: e.target.value })} />
            <input className="input mono grow" placeholder="https://… Liste im Hosts- oder AdBlock-Format" value={nf.url} onChange={(e) => setNf({ ...nf, url: e.target.value })} />
            <button className="btn sm" disabled={!nf.url || !!busy} onClick={() => post('filter', { add: true, ...nf }, 'Liste hinzugefügt').then(() => setNf({ name: '', url: '' }))}>Hinzufügen</button>
          </div>
        </div>
        <div className="c5 col" style={{ gap: 8 }}>
          <div className="lbl-sm">Eigene Regeln <Badge>{st.user_rules.length}</Badge></div>
          <textarea className="input mono" style={{ minHeight: 160, fontSize: 12 }} value={rules} onChange={(e) => setRules(e.target.value)} placeholder={'||werbung.example^\n@@||erlaubt.example^$important'} />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm primary" disabled={!dirty || !!busy} onClick={() => post('rules', { rules: rules.split('\n') }, 'Regeln gespeichert')}>Speichern</button>
            <span className="dim" style={{ fontSize: 12 }}>||domain^ sperrt, @@||domain^ erlaubt. In den Listen unten geht das auch per Klick.</span>
          </div>
        </div>
      </div>
    </Card>
  )
}
