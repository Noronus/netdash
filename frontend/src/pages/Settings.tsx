import React, { useEffect, useState } from 'react'
import { Plug, Save, Zap } from 'lucide-react'
import { api } from '../api'
import { Badge, Card, Dot } from '../components/ui'
import { ago } from '../format'

type Field = { key: string; label: string; kind: 'text' | 'secret'; value: string; set: boolean | null }
type Integ = {
  name: string; label: string; desc: string; core: boolean; enabled: boolean; configured: boolean
  fields: Field[]; status: { ok?: boolean; error?: string; updated?: number; failed?: number }
}

export default function Settings() {
  const [list, setList] = useState<Integ[] | null>(null)
  const load = () => api<{ integrations: Integ[] }>('/api/integrations').then((r) => setList(r.integrations))
  useEffect(() => { load() }, [])
  return (
    <>
      <Card title="Integrationen" icon={<Plug size={16} />}>
        <div className="dim" style={{ fontSize: 13, marginBottom: 14 }}>
          Zugangsdaten liegen nur auf der OPNsense (secrets.json, nur für root lesbar). Passwortfelder bleiben leer, solange du
          nichts Neues einträgst. Beim Speichern wird die Verbindung zuerst getestet, Änderungen gelten sofort ohne Neustart.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 14 }}>
          {(list || []).map((i) => <IntegCard key={i.name} i={i} onSaved={load} />)}
        </div>
        {!list && <div className="empty">Lade …</div>}
      </Card>
    </>
  )
}

function IntegCard({ i, onSaved }: { i: Integ; onSaved: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(i.fields.map((f) => [f.key, f.kind === 'text' ? f.value || '' : ''])))
  const [enabled, setEnabled] = useState(i.enabled)
  const [busy, setBusy] = useState<'' | 'test' | 'save'>('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const dirty = enabled !== i.enabled || i.fields.some((f) => (f.kind === 'text' ? vals[f.key] !== (f.value || '') : vals[f.key] !== ''))
  const st = i.status
  const state: ['ok' | 'bad' | 'off' | 'warn', string] = !i.enabled ? ['off', 'deaktiviert']
    : st.ok ? ['ok', 'aktiv' + (st.updated ? ' · ' + ago(st.updated) : '')]
    : st.error === 'not configured' ? ['warn', 'nicht eingerichtet'] : st.error ? ['bad', st.error] : ['warn', 'noch keine Daten']

  async function run(kind: 'test' | 'save', force = false) {
    setBusy(kind); setMsg(null)
    try {
      const r = await api<{ ok: boolean; message: string; saved?: boolean }>(`/api/integrations/${i.name}${kind === 'test' ? '/test' : ''}`,
        { method: 'POST', body: JSON.stringify({ ...vals, enabled, force }) })
      setMsg({ ok: r.ok, text: r.message + (kind === 'save' ? ' · gespeichert' : '') })
      if (kind === 'save') onSaved()
    } catch (e: any) {
      setMsg({ ok: false, text: e.message + (kind === 'save' ? ' · nicht gespeichert' : '') })
    } finally { setBusy('') }
  }

  return (
    <div className="form" style={{ background: 'var(--surface-2)' }}>
      <div className="row">
        <Dot t={state[0]} />
        <b className="grow">{i.label}</b>
        {i.core ? <Badge>Kern</Badge> : (
          <label className="check" style={{ padding: 0, alignSelf: 'center' }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />aktiv
          </label>
        )}
      </div>
      <div className="dim" style={{ fontSize: 12.5, marginTop: -6 }}>{i.desc}</div>
      <div className="dim" style={{ fontSize: 12, marginTop: -6, color: state[0] === 'bad' ? 'var(--bad)' : undefined }}>Status: {state[1]}</div>
      {i.fields.map((f) => (
        <label key={f.key}>{f.label}
          <input className={'input' + (f.kind === 'text' && f.key === 'url' ? ' mono' : '')} type={f.kind === 'secret' ? 'password' : 'text'}
            autoComplete="off" value={vals[f.key]} placeholder={f.kind === 'secret' ? (f.set ? 'gespeichert, leer lassen = unverändert' : 'nicht gesetzt') : ''}
            onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
        </label>
      ))}
      {msg && <div className={msg.ok ? '' : 'err'} style={{ fontSize: 12.5, color: msg.ok ? 'var(--ok)' : undefined }}>{msg.text}</div>}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn sm" disabled={!!busy} onClick={() => run('test')}><Zap size={13} />{busy === 'test' ? 'Teste …' : 'Verbindung testen'}</button>
        <button className="btn sm primary" disabled={!!busy || !dirty} onClick={() => run('save')}><Save size={13} />{busy === 'save' ? 'Speichere …' : 'Speichern'}</button>
        {msg && !msg.ok && dirty && <button className="btn sm ghost" onClick={() => run('save', true)}>trotzdem speichern</button>}
      </div>
    </div>
  )
}
