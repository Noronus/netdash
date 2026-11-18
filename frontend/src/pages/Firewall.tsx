import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowLeftRight, Eye, EyeOff, Pause, Play, Pencil, Plus, RotateCcw, Shield, ShieldAlert, Trash2, X } from 'lucide-react'
import { api, Full } from '../api'
import { Badge, Card, Dot, Seg } from '../components/ui'
import { bytes, num } from '../format'

type Rule = {
  uuid: string; enabled: boolean; auto: boolean; sequence: number; action: string; quick: boolean
  interface: string; interface_label: string; direction: string; ipprotocol: string; protocol: string
  source: string; source_not: boolean; source_port: string; destination: string; destination_not: boolean
  destination_port: string; log: boolean; description: string; categories: string; gateway: string
  packets?: number; bytes?: number; states?: number
}
type Txn = { status: 'clean' | 'dirty' | 'applied'; pending: number; can_undo: boolean; remaining: number | null; history: { t: number; what: string; n: number; errors?: string[] }[] }
type Opt = { value: string; label: string; type?: string }
type Options = { interfaces: Opt[]; networks: Opt[]; choices: Record<string, Opt[]> }
type LogE = { seq: number; t: number; if: string; action: string; dir: string; proto: string; src: string; dst: string; sport?: string; dport?: string; rule: string; flags?: string }

const ACTION: Record<string, ['ok' | 'bad' | 'warn', string]> = { pass: ['ok', 'Erlauben'], block: ['bad', 'Blockieren'], reject: ['warn', 'Ablehnen'] }

function useNames(full: Full, opts: Options | null) {
  return useMemo(() => {
    const m = new Map<string, string>()
    for (const d of full.devices) for (const ip of [...d.ipv4, ...d.ipv6]) m.set(ip, d.name)
    const net = new Map<string, string>()
    for (const n of opts?.networks || []) net.set(n.value, n.label.replace(/ network$/, ' (Netz)').replace(/ address$/, ' (Adresse)'))
    net.set('any', 'alle'); net.set('(self)', 'Firewall selbst')
    const label = (v: string) => {
      if (!v) return 'alle'
      return v.split(',').map((x) => net.get(x) || m.get(x.replace(/\/(32|128)$/, '')) || x).join(', ')
    }
    const host = (ip: string) => m.get(ip) || ip
    return { label, host }
  }, [full.devices, opts])
}

export default function Firewall({ full }: { full: Full }) {
  const [tab, setTab] = useState<'rules' | 'live'>('rules')
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [txn, setTxn] = useState<Txn | null>(null)
  const [opts, setOpts] = useState<Options | null>(null)
  const [edit, setEdit] = useState<Rule | 'new' | null>(null)
  const [showAuto, setShowAuto] = useState(false)
  const [toast, setToast] = useState('')
  const [err, setErr] = useState('')
  const [stats, setStats] = useState<any>(null)
  const names = useNames(full, opts)
  const load = () => api<{ rules: Rule[]; txn: Txn }>('/api/firewall/rules').then((r) => { setRules(r.rules); setTxn(r.txn) }).catch((e) => setErr(e.message))
  useEffect(() => { load(); api<Options>('/api/firewall/options').then(setOpts).catch(() => {}) }, [])
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(''), 6000); return () => clearTimeout(t) } }, [toast])

  async function act(path: string, body: any, msg?: string) {
    setErr('')
    try {
      const r = await api<{ txn: Txn }>('/api/firewall/' + path, { method: 'POST', body: JSON.stringify(body) })
      setTxn(r.txn); if (msg) setToast(msg); await load()
    } catch (e: any) { setErr(e.message) }
  }

  const user = (rules || []).filter((r) => !r.auto)
  const groups = new Map<string, Rule[]>()
  for (const r of [...user].sort((a, b) => a.sequence - b.sequence)) {
    const k = r.interface ? (r.interface.includes(',') ? 'Mehrere Schnittstellen' : r.interface_label || r.interface) : 'Floating (alle Schnittstellen)'
    groups.set(k, [...(groups.get(k) || []), r])
  }
  const order = [...user].sort((a, b) => a.sequence - b.sequence)

  return (
    <>
      <div className="grid">
        <Card className="c3" title="Eigene Regeln" icon={<Shield size={16} />}><div className="kpi"><div className="v">{user.filter((r) => r.enabled).length}<small>/ {user.length} aktiv</small></div><div className="s">{(rules || []).length - user.length} System-Regeln</div></div></Card>
        <Card className="c3" title="Erlaubt (5 Min)"><div className="kpi"><div className="v" style={{ color: 'var(--ok)' }}>{stats ? num(stats.pass) : '–'}</div><div className="s">protokollierte Verbindungen</div></div></Card>
        <Card className="c3" title="Blockiert (5 Min)" icon={<ShieldAlert size={16} />}><div className="kpi"><div className="v" style={{ color: 'var(--bad)' }}>{stats ? num(stats.block) : '–'}</div><div className="s">{stats?.top_src?.[0] ? 'meist von ' + names.host(stats.top_src[0][0]) : ''}</div></div></Card>
        <Card className="c3" title="Firewall-States"><div className="kpi"><div className="v">{num(full.system?.pf_states)}</div><div className="s">aktive Verbindungen</div></div></Card>
      </div>

      <TxnBar txn={txn} setTxn={setTxn} onDone={(m) => { setToast(m); load() }} />
      {err && <div className="err">{err}</div>}

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <Seg value={tab} onChange={setTab} options={[['rules', 'Regeln'], ['live', 'Live-Ansicht']]} />
        {tab === 'rules' && (
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm ghost" onClick={() => setShowAuto(!showAuto)}>{showAuto ? <EyeOff size={13} /> : <Eye size={13} />}System-Regeln</button>
            <button className="btn sm primary" onClick={() => setEdit('new')}><Plus size={14} />Neue Regel</button>
          </div>
        )}
      </div>

      {tab === 'rules' ? (
        <>
          {[...groups.entries()].map(([g, rs]) => (
            <Card key={g} title={g} icon={<ArrowLeftRight size={16} />} flush act={<span>{rs.length} Regeln</span>}>
              <RuleTable rules={rs} names={names} onEdit={setEdit}
                onToggle={(r) => act('rule/toggle', { uuid: r.uuid, enabled: !r.enabled })}
                onMove={(r, dir) => {
                  const i = order.findIndex((x) => x.uuid === r.uuid)
                  if (dir < 0 && i > 0) act('rule/move', { uuid: r.uuid, before: order[i - 1].uuid })
                  if (dir > 0 && i < order.length - 1) act('rule/move', { uuid: order[i + 1].uuid, before: r.uuid })
                }} />
            </Card>
          ))}
          {showAuto && (
            <Card title="System-Regeln (automatisch, nur lesen)" flush>
              <RuleTable rules={(rules || []).filter((r) => r.auto)} names={names} readOnly />
            </Card>
          )}
          {!rules && !err && <div className="empty">Lade Regeln …</div>}
        </>
      ) : <Live full={full} names={names} onStats={setStats} />}
      {tab === 'rules' && <StatsPoller onStats={setStats} />}

      {edit && opts && <RuleEditor rule={edit === 'new' ? null : edit} opts={opts} full={full} onClose={() => setEdit(null)}
        onSave={async (body, uuid) => {
          const path = uuid ? 'rule/update' : 'rule'
          const r = await api<{ txn: Txn }>('/api/firewall/' + path, { method: 'POST', body: JSON.stringify(uuid ? { uuid, rule: body } : { rule: body }) })
          setTxn(r.txn); setEdit(null); setToast('Gespeichert, noch nicht aktiv: oben auf „Übernehmen“ klicken.'); load()
        }}
        onDelete={async (uuid) => {
          const r = await api<{ txn: Txn }>('/api/firewall/rule/delete', { method: 'POST', body: JSON.stringify({ uuid }) })
          setTxn(r.txn); setEdit(null); setToast('Regel gelöscht, noch nicht aktiv: „Übernehmen“ klicken.'); load()
        }} />}
      {toast && <div className="toast">{toast}</div>}
    </>
  )
}

function StatsPoller({ onStats }: { onStats: (s: any) => void }) {
  useEffect(() => {
    const f = () => api<any>('/api/firewall/log?since=999999999').then((r) => onStats(r.stats)).catch(() => {})
    f(); const t = setInterval(f, 10000); return () => clearInterval(t)
  }, [])
  return null
}

function TxnBar({ txn, setTxn, onDone }: { txn: Txn | null; setTxn: (t: Txn) => void; onDone: (m: string) => void }) {
  const okPolls = useRef(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (txn?.status !== 'applied') { okPolls.current = 0; return }
    const t = setInterval(async () => {
      try {
        const s = await api<Txn>('/api/firewall/txn')
        setTxn(s)
        if (s.status !== 'applied') return
        okPolls.current += 1
        if (okPolls.current >= 3) {
          const r = await api<{ txn: Txn }>('/api/firewall/confirm', { method: 'POST', body: '{}' })
          setTxn(r.txn); onDone('Regeln aktiv und bestätigt.')
        }
      } catch { /* connection lost: do not confirm, the firewall rolls back by itself */ }
    }, 2000)
    return () => clearInterval(t)
  }, [txn?.status])
  if (!txn) return null
  const post = async (path: string, msg: string) => {
    setBusy(true)
    try { const r = await api<{ txn: Txn }>('/api/firewall/' + path, { method: 'POST', body: '{}' }); setTxn(r.txn); onDone(msg) }
    catch (e: any) { onDone(e.message) } finally { setBusy(false) }
  }
  const last = txn.history[0]
  if (txn.status === 'dirty') return (
    <div className="banner warn">
      <b>{txn.pending} {txn.pending === 1 ? 'Änderung' : 'Änderungen'} noch nicht aktiv</b>
      <span className="dim grow">Beim Übernehmen bleibt 60 s Zeit: reißt die Verbindung ab, stellt die Firewall den alten Stand selbst wieder her.</span>
      <button className="btn sm ghost" disabled={busy} onClick={() => post('revert', 'Änderungen verworfen.')}>Verwerfen</button>
      <button className="btn sm primary" disabled={busy} onClick={() => post('apply', 'Übernommen, prüfe Verbindung …')}>Übernehmen</button>
    </div>
  )
  if (txn.status === 'applied') return (
    <div className="banner acc">
      <b>Neue Regeln aktiv, prüfe Verbindung …</b>
      <span className="dim grow">Ohne Rückmeldung wird in {txn.remaining ?? '–'} s automatisch zurückgenommen.</span>
      <button className="btn sm" disabled={busy} onClick={() => post('revert', 'Zurückgenommen.')}><RotateCcw size={13} />Zurücknehmen</button>
    </div>
  )
  if (txn.can_undo || (last && Date.now() / 1000 - last.t < 300)) return (
    <div className="banner">
      <span className="grow">{last ? `Letzte Aktion: ${last.what}${last.errors?.length ? ' (mit Fehlern: ' + last.errors.join('; ') + ')' : ''}` : ''}</span>
      {txn.can_undo && <button className="btn sm" disabled={busy} onClick={() => post('revert', 'Letzte Änderung rückgängig gemacht.')}><RotateCcw size={13} />Rückgängig</button>}
    </div>
  )
  return null
}

function RuleTable({ rules, names, onEdit, onToggle, onMove, readOnly }: {
  rules: Rule[]; names: ReturnType<typeof useNames>; onEdit?: (r: Rule) => void; onToggle?: (r: Rule) => void
  onMove?: (r: Rule, dir: number) => void; readOnly?: boolean
}) {
  const ports = (p: string) => (p ? ':' + p : '')
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead><tr>{!readOnly && <th style={{ width: 54 }}></th>}<th>Aktion</th><th>Richtung</th><th>Protokoll</th><th>Quelle</th><th>Ziel</th><th>Beschreibung</th><th className="r">Treffer</th>{!readOnly && <th></th>}</tr></thead>
        <tbody>
          {rules.map((r) => {
            const [t, l] = ACTION[r.action] || ['warn', r.action]
            return (
              <tr key={r.uuid} className={r.enabled ? '' : 'off'} onClick={() => !readOnly && onEdit?.(r)} style={readOnly ? { cursor: 'default' } : undefined}>
                {!readOnly && (
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="row" style={{ gap: 2 }}>
                      <button className={'switch' + (r.enabled ? ' on' : '')} title={r.enabled ? 'deaktivieren' : 'aktivieren'} onClick={() => onToggle?.(r)}><i /></button>
                    </div>
                  </td>
                )}
                <td><Badge t={r.enabled ? t : undefined}>{l}</Badge>{!r.quick && <span className="dim" style={{ fontSize: 11, marginLeft: 4 }} title="nicht quick">⇣</span>}</td>
                <td className="dim">{r.direction === 'in' ? 'rein' : r.direction === 'out' ? 'raus' : 'beide'}</td>
                <td>{r.protocol === 'any' ? <span className="dim">alle</span> : r.protocol}{r.ipprotocol === 'inet6' ? ' v6' : r.ipprotocol === 'inet' ? '' : ''}</td>
                <td className="ell" style={{ maxWidth: 220 }} title={r.source}>{r.source_not && '¬ '}{names.label(r.source)}<span className="dim">{ports(r.source_port)}</span></td>
                <td className="ell" style={{ maxWidth: 240 }} title={r.destination}>{r.destination_not && '¬ '}{names.label(r.destination)}<span className="dim">{ports(r.destination_port)}</span></td>
                <td className="ell" style={{ maxWidth: 260 }}>{r.description || <span className="dim">–</span>}{r.log && <span className="dim" style={{ fontSize: 11, marginLeft: 6 }}>Log</span>}</td>
                <td className="r num dim" title={r.bytes != null ? bytes(r.bytes) : ''}>{r.packets ? num(r.packets) : '–'}</td>
                {!readOnly && (
                  <td className="r" onClick={(e) => e.stopPropagation()}>
                    <div className="row" style={{ gap: 0, justifyContent: 'flex-end' }}>
                      <button className="icon-btn" style={{ width: 26, height: 26 }} title="nach oben" onClick={() => onMove?.(r, -1)}><ArrowUp size={13} /></button>
                      <button className="icon-btn" style={{ width: 26, height: 26 }} title="nach unten" onClick={() => onMove?.(r, 1)}><ArrowDown size={13} /></button>
                      <button className="icon-btn" style={{ width: 26, height: 26 }} title="bearbeiten" onClick={() => onEdit?.(r)}><Pencil size={13} /></button>
                    </div>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      {!rules.length && <div className="empty">Keine Regeln</div>}
    </div>
  )
}

function NetPicker({ label, value, not, port, showPort, onChange, opts, full }: {
  label: string; value: string; not: boolean; port: string; showPort: boolean
  onChange: (v: { value?: string; not?: boolean; port?: string }) => void; opts: Options; full: Full
}) {
  const known = new Set(['any', ...opts.networks.map((n) => n.value), ...full.devices.flatMap((d) => d.ipv4)])
  const [custom, setCustom] = useState(!!value && !known.has(value) && !known.has(value.replace(/\/32$/, '')))
  const devs = full.devices.filter((d) => d.ip).sort((a, b) => a.name.localeCompare(b.name))
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="lbl-sm">{label}</div>
      <div className="row" style={{ gap: 8 }}>
        {custom ? (
          <input className="input mono grow" value={value} placeholder="IP, Netz (192.168.1.0/24) oder Alias" onChange={(e) => onChange({ value: e.target.value })} />
        ) : (
          <select className="input grow" value={value.replace(/\/32$/, '') || 'any'} onChange={(e) => e.target.value === '__custom' ? setCustom(true) : onChange({ value: e.target.value })}>
            <option value="any">alle</option>
            <optgroup label="Netze">{opts.networks.filter((n) => n.type === 'networks' && n.value !== 'any').map((n) => <option key={n.value} value={n.value}>{n.label.replace(/ network$/, ' (Netz)').replace(/ address$/, ' (Adresse)')}</option>)}</optgroup>
            <optgroup label="Aliase">{opts.networks.filter((n) => n.type === 'aliases').map((n) => <option key={n.value} value={n.value}>{n.label}</option>)}</optgroup>
            <optgroup label="Geräte">{devs.map((d) => <option key={d.mac} value={d.ip!}>{d.name} · {d.ip}</option>)}</optgroup>
            <option value="__custom">Eigene Eingabe …</option>
          </select>
        )}
        {custom && <button className="btn sm ghost" onClick={() => setCustom(false)}>Liste</button>}
        <label className="check" style={{ padding: 0, alignSelf: 'center' }}><input type="checkbox" checked={not} onChange={(e) => onChange({ not: e.target.checked })} />nicht</label>
      </div>
      {showPort && <input className="input mono" value={port} placeholder="Port (leer = alle), z. B. 443, 8000-8100 oder Alias" onChange={(e) => onChange({ port: e.target.value })} />}
    </div>
  )
}

function RuleEditor({ rule, opts, full, onClose, onSave, onDelete }: {
  rule: Rule | null; opts: Options; full: Full; onClose: () => void
  onSave: (body: any, uuid?: string) => Promise<void>; onDelete: (uuid: string) => Promise<void>
}) {
  const [r, setR] = useState(() => rule ? {
    enabled: rule.enabled, action: rule.action, quick: rule.quick, interface: rule.interface, direction: rule.direction,
    ipprotocol: rule.ipprotocol, protocol: rule.protocol, source_net: rule.source || 'any', source_not: rule.source_not,
    source_port: rule.source_port, destination_net: rule.destination || 'any', destination_not: rule.destination_not,
    destination_port: rule.destination_port, log: rule.log, description: rule.description,
  } : {
    enabled: true, action: 'pass', quick: true, interface: '', direction: 'in', ipprotocol: 'inet', protocol: 'any',
    source_net: 'any', source_not: false, source_port: '', destination_net: 'any', destination_not: false, destination_port: '', log: false, description: '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const up = (p: Partial<typeof r>) => setR((x) => ({ ...x, ...p }))
  const ch = opts.choices
  const ifs = r.interface ? r.interface.split(',') : []
  const portProto = ['TCP', 'UDP', 'TCP/UDP'].includes(r.protocol)
  async function save() {
    setBusy(true); setErr('')
    try {
      const body: any = { ...r }
      if (!portProto) { body.source_port = ''; body.destination_port = '' }
      await onSave(body, rule?.uuid)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-h">
          <div className="col grow"><b style={{ fontSize: 17 }}>{rule ? (rule.description || 'Regel bearbeiten') : 'Neue Firewall-Regel'}</b><span className="dim" style={{ fontSize: 12.5 }}>wird erst mit „Übernehmen“ aktiv</span></div>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="drawer-b">
          <div className="form">
            <label>Aktion
              <div className="seg">{(ch.action || []).map((o) => <button key={o.value} type="button" className={r.action === o.value ? 'on' : ''} onClick={() => up({ action: o.value })}>{ACTION[o.value]?.[1] || o.label}</button>)}</div>
            </label>
            <label>Schnittstellen (leer = alle / floating)
              <div className="row wrap" style={{ gap: 6 }}>
                {opts.interfaces.filter((i) => i.type !== 'floating').map((i) => (
                  <button key={i.value} type="button" className={'btn sm' + (ifs.includes(i.value) ? ' primary' : '')}
                    onClick={() => up({ interface: (ifs.includes(i.value) ? ifs.filter((x) => x !== i.value) : [...ifs, i.value]).join(',') })}>{i.label}</button>
                ))}
              </div>
            </label>
            <div className="row" style={{ gap: 10 }}>
              <label className="grow">Richtung<select className="input" value={r.direction} onChange={(e) => up({ direction: e.target.value })}>{(ch.direction || []).map((o) => <option key={o.value} value={o.value}>{o.value === 'in' ? 'rein (in)' : o.value === 'out' ? 'raus (out)' : 'beide'}</option>)}</select></label>
              <label className="grow">IP-Version<select className="input" value={r.ipprotocol} onChange={(e) => up({ ipprotocol: e.target.value })}>{(ch.ipprotocol || []).map((o) => <option key={o.value} value={o.value}>{o.value === 'inet' ? 'IPv4' : o.value === 'inet6' ? 'IPv6' : 'IPv4 + IPv6'}</option>)}</select></label>
              <label className="grow">Protokoll<select className="input" value={r.protocol} onChange={(e) => up({ protocol: e.target.value })}>{(ch.protocol || []).map((o) => <option key={o.value} value={o.value}>{o.value === 'any' ? 'alle' : o.label}</option>)}</select></label>
            </div>
          </div>
          <div className="form">
            <NetPicker label="Quelle" value={r.source_net} not={r.source_not} port={r.source_port} showPort={portProto} opts={opts} full={full}
              onChange={(v) => up({ ...(v.value !== undefined ? { source_net: v.value } : {}), ...(v.not !== undefined ? { source_not: v.not } : {}), ...(v.port !== undefined ? { source_port: v.port } : {}) })} />
            <NetPicker label="Ziel" value={r.destination_net} not={r.destination_not} port={r.destination_port} showPort={portProto} opts={opts} full={full}
              onChange={(v) => up({ ...(v.value !== undefined ? { destination_net: v.value } : {}), ...(v.not !== undefined ? { destination_not: v.not } : {}), ...(v.port !== undefined ? { destination_port: v.port } : {}) })} />
          </div>
          <div className="form">
            <label>Beschreibung<input className="input" value={r.description} onChange={(e) => up({ description: e.target.value })} placeholder="z. B. IoT darf nicht ins LAN" /></label>
            <div className="row wrap" style={{ gap: 18 }}>
              <label className="check" style={{ padding: 0 }}><input type="checkbox" checked={r.enabled} onChange={(e) => up({ enabled: e.target.checked })} />aktiv</label>
              <label className="check" style={{ padding: 0 }}><input type="checkbox" checked={r.log} onChange={(e) => up({ log: e.target.checked })} />protokollieren (Live-Ansicht)</label>
              <label className="check" style={{ padding: 0 }} title="Quick: erste passende Regel gewinnt"><input type="checkbox" checked={r.quick} onChange={(e) => up({ quick: e.target.checked })} />sofort anwenden (quick)</label>
            </div>
          </div>
          {err && <div className="err">{err}</div>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Speichere …' : 'Speichern'}</button>
            <span className="grow" />
            {rule && !confirmDel && <button className="btn" style={{ color: 'var(--bad)' }} onClick={() => setConfirmDel(true)}><Trash2 size={14} />Löschen</button>}
            {rule && confirmDel && <button className="btn" style={{ background: 'var(--bad)', color: '#fff', borderColor: 'var(--bad)' }} disabled={busy} onClick={() => onDelete(rule.uuid).catch((e) => setErr(e.message))}>Wirklich löschen</button>}
          </div>
          <div className="dim" style={{ fontSize: 12 }}>Weitere Optionen (Gateway, Limits, Zeitpläne) bleiben beim Bearbeiten erhalten und sind weiter im OPNsense-Webinterface einstellbar.</div>
        </div>
      </aside>
    </>
  )
}

function Live({ full, names, onStats }: { full: Full; names: ReturnType<typeof useNames>; onStats: (s: any) => void }) {
  const [entries, setEntries] = useState<LogE[]>([])
  const [paused, setPaused] = useState(false)
  const [action, setAction] = useState<'all' | 'pass' | 'block'>('all')
  const [iface, setIface] = useState('')
  const [q, setQ] = useState('')
  const seq = useRef(0)
  const pausedRef = useRef(false)
  pausedRef.current = paused
  const ifName = useMemo(() => new Map(full.interfaces.map((i) => [i.netif, i.descr.replace(/^Port /, '')])), [full.interfaces])
  useEffect(() => {
    let alive = true
    const tick = async () => {
      if (pausedRef.current) return
      try {
        const r = await api<{ entries: LogE[]; seq: number; stats: any }>('/api/firewall/log?since=' + seq.current)
        if (!alive) return
        seq.current = r.seq
        onStats(r.stats)
        if (r.entries.length) setEntries((old) => [...r.entries.reverse(), ...old].slice(0, 1500))
      } catch { /* ignore */ }
    }
    tick(); const t = setInterval(tick, 1500)
    return () => { alive = false; clearInterval(t) }
  }, [])
  const ql = q.trim().toLowerCase()
  const shown = entries.filter((e) => {
    if (action !== 'all' && e.action !== action) return false
    if (iface && e.if !== iface) return false
    if (ql) {
      const hay = [e.src, e.dst, e.sport, e.dport, e.proto, e.rule, names.host(e.src), names.host(e.dst), ifName.get(e.if)].join(' ').toLowerCase()
      if (!hay.includes(ql)) return false
    }
    return true
  }).slice(0, 400)
  const ifs = [...new Set(entries.map((e) => e.if))].sort()
  const ep = (ip: string, port?: string) => {
    const n = names.host(ip)
    return <span title={ip + (port ? ':' + port : '')}>{n !== ip ? <b style={{ fontWeight: 550 }}>{n}</b> : <span className="mono">{ip}</span>}{port && <span className="dim mono">:{port}</span>}</span>
  }
  return (
    <Card flush title="Live-Ansicht" act={<span className="row gap6"><Dot t={paused ? 'off' : 'ok'} />{paused ? 'pausiert' : 'live'}</span>}>
      <div className="filters" style={{ padding: '4px 16px 10px' }}>
        <Seg value={action} onChange={setAction} options={[['all', 'Alle'], ['pass', 'Erlaubt'], ['block', 'Blockiert']]} />
        <select className="input" value={iface} onChange={(e) => setIface(e.target.value)}>
          <option value="">Alle Schnittstellen</option>
          {ifs.map((i) => <option key={i} value={i}>{ifName.get(i) || i}</option>)}
        </select>
        <input className="input" style={{ width: 260 }} placeholder="IP, Gerät, Port oder Regel" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn sm" onClick={() => setPaused(!paused)}>{paused ? <Play size={13} /> : <Pause size={13} />}{paused ? 'Weiter' : 'Pause'}</button>
        <span className="dim" style={{ marginLeft: 'auto', fontSize: 12.5 }}>nur Regeln mit Protokollierung erscheinen hier</span>
      </div>
      <div className="tbl-wrap" style={{ maxHeight: '68vh' }}>
        <table className="tbl">
          <thead><tr><th>Zeit</th><th>Aktion</th><th>Schnittstelle</th><th>Proto</th><th>Quelle</th><th></th><th>Ziel</th><th>Regel</th></tr></thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.seq} style={{ cursor: 'default', background: e.action === 'block' ? 'var(--bad-soft)' : undefined }}>
                <td className="num dim">{new Date(e.t * 1000).toLocaleTimeString('de-DE')}</td>
                <td><Badge t={e.action === 'pass' ? 'ok' : 'bad'}>{e.action === 'pass' ? 'erlaubt' : 'blockiert'}</Badge></td>
                <td>{ifName.get(e.if) || e.if} <span className="dim">{e.dir === 'in' ? '↘' : '↗'}</span></td>
                <td className="dim">{e.proto}</td>
                <td>{ep(e.src, e.sport)}</td>
                <td className="dim">→</td>
                <td>{ep(e.dst, e.dport)}</td>
                <td className="dim ell" style={{ maxWidth: 280 }}>{e.rule}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <div className="empty">{entries.length ? 'Nichts passt zum Filter' : 'Warte auf Einträge …'}</div>}
      </div>
    </Card>
  )
}
