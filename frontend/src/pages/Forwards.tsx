import React, { useMemo, useState } from 'react'
import { Pencil, Plus, Share2, Trash2, X, Zap } from 'lucide-react'
import { api, Full } from '../api'
import { Badge, Card, SrcError } from '../components/ui'
import { ago, bytes, num } from '../format'

type Fwd = { proto: 'tcp' | 'udp'; port: number; to_ip: string; to_port: number; comment: string; enabled: boolean; packets?: number | null; bytes?: number | null }

export default function Forwards({ full }: { full: Full }) {
  const v = full.vps as any
  const [edit, setEdit] = useState<{ f: Fwd | null; idx: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [toast, setToast] = useState('')
  const [tests, setTests] = useState<Record<number, any>>({})
  const byIp = useMemo(() => new Map(full.devices.flatMap((d) => d.ipv4.map((ip) => [ip, d.name] as [string, string]))), [full.devices])
  const fwds: Fwd[] = v?.forwards || []

  async function push(list: Fwd[], msg: string) {
    setBusy(true); setErr('')
    try {
      await api('/api/vps/forwards', { method: 'POST', body: JSON.stringify({ forwards: list.map(({ packets, bytes, ...f }) => f) }) })
      setToast(msg); setEdit(null)
      setTimeout(() => setToast(''), 6000)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  async function test(i: number, f: Fwd) {
    setTests((t) => ({ ...t, [i]: { busy: true } }))
    try { const r = await api('/api/vps/test', { method: 'POST', body: JSON.stringify({ ip: f.to_ip, port: f.to_port }) }); setTests((t) => ({ ...t, [i]: r })) }
    catch (e: any) { setTests((t) => ({ ...t, [i]: { ok: false, error: e.message } })) }
  }

  return (
    <>
      <Card title={`${v?.name || 'VPS'} · öffentlich ${v?.wan_ip || ''}`} icon={<Share2 size={16} />} flush
        act={<button className="btn sm primary" disabled={!v} onClick={() => setEdit({ f: null, idx: -1 })}><Plus size={14} />Neue Weiterleitung</button>}>
        <div style={{ padding: '0 16px' }}><SrcError src={full.sources.vps} label="VPS" /></div>
        {err && <div className="err" style={{ padding: '4px 16px' }}>{err}</div>}
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th style={{ width: 50 }}></th><th>Port öffentlich</th><th>Ziel im Heimnetz</th><th>Beschreibung</th><th className="r">Pakete</th><th className="r">Daten</th><th>Erreichbar</th><th></th></tr></thead>
            <tbody>
              {fwds.map((f, i) => {
                const t = tests[i]
                return (
                  <tr key={f.proto + f.port + i} className={f.enabled ? '' : 'off'} onClick={() => setEdit({ f, idx: i })}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button className={'switch' + (f.enabled ? ' on' : '')} disabled={busy} title={f.enabled ? 'abschalten' : 'einschalten'}
                        onClick={() => push(fwds.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)), `${f.proto}/${f.port} ${f.enabled ? 'abgeschaltet' : 'eingeschaltet'}.`)}><i /></button>
                    </td>
                    <td><span className="mono">{f.proto.toUpperCase()} {f.port}</span></td>
                    <td><div className="col" style={{ gap: 0 }}><span className="mono">{f.to_ip}:{f.to_port}</span><span className="dim" style={{ fontSize: 12 }}>{byIp.get(f.to_ip) || ''}</span></div></td>
                    <td className="ell" style={{ maxWidth: 300 }}>{f.comment || <span className="dim">–</span>}</td>
                    <td className="r num dim">{f.packets != null ? num(f.packets) : '–'}</td>
                    <td className="r num dim">{f.bytes != null ? bytes(f.bytes) : '–'}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {t?.busy ? <span className="dim">prüfe …</span> : t ? <Badge t={t.ok ? 'ok' : 'bad'}>{t.ok ? `ok · ${t.ms} ms` : 'nicht erreichbar'}</Badge>
                        : <button className="btn sm ghost" onClick={() => test(i, f)}><Zap size={12} />Testen</button>}
                    </td>
                    <td className="r"><Pencil size={14} className="dim" /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {v && !fwds.length && <div className="empty">Noch keine Weiterleitungen</div>}
        </div>
      </Card>
      <div className="dim" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
        Der VPS leitet Verbindungen an seine öffentliche Adresse über den VPN-Tunnel ins Heimnetz weiter (iptables-Kette NETDASH-PF,
        Liste auf dem VPS in {v?.forwards_file || '/etc/netdash-vps/forwards.json'}). Neue Ports gegebenenfalls zusätzlich in der Firewall
        deines VPS-Anbieters freigeben. Ports, die der VPS selbst nutzt, sind gesperrt.
        {v?.history?.[0] && <> · Zuletzt: {v.history[0].what} {ago(v.history[0].t)}</>}
      </div>
      {edit && <FwdEditor f={edit.f} full={full} busy={busy} err={err} onClose={() => { setEdit(null); setErr('') }}
        onSave={(nf) => {
          const list = edit.idx >= 0 ? fwds.map((x, j) => (j === edit.idx ? nf : x)) : [...fwds, nf]
          push(list, `${nf.proto}/${nf.port} → ${nf.to_ip}:${nf.to_port} gespeichert.`)
        }}
        onDelete={edit.idx >= 0 ? () => push(fwds.filter((_, j) => j !== edit.idx), `${edit.f!.proto}/${edit.f!.port} gelöscht.`) : undefined} />}
      {toast && <div className="toast">{toast}</div>}
    </>
  )
}

function FwdEditor({ f, full, busy, err, onClose, onSave, onDelete }: {
  f: Fwd | null; full: Full; busy: boolean; err: string; onClose: () => void; onSave: (f: Fwd) => void; onDelete?: () => void
}) {
  const [x, setX] = useState<Fwd>(f ? { ...f } : { proto: 'tcp', port: 0 as any, to_ip: '', to_port: 0 as any, comment: '', enabled: true })
  const [same, setSame] = useState(!f || f.port === f.to_port)
  const [del, setDel] = useState(false)
  const devs = full.devices.filter((d) => d.ip && /^10\.|^192\.168\./.test(d.ip)).sort((a, b) => a.name.localeCompare(b.name))
  const up = (p: Partial<Fwd>) => setX((o) => ({ ...o, ...p }))
  const valid = x.port > 0 && x.port < 65536 && /^\d+\.\d+\.\d+\.\d+$/.test(x.to_ip) && (same || (x.to_port > 0 && x.to_port < 65536))
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-h">
          <div className="col grow"><b style={{ fontSize: 17 }}>{f ? `${f.proto.toUpperCase()} ${f.port}` : 'Neue Weiterleitung'}</b><span className="dim" style={{ fontSize: 12.5 }}>VPS → Heimnetz</span></div>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="drawer-b">
          <div className="form">
            <div className="row" style={{ gap: 10 }}>
              <label style={{ width: 120 }}>Protokoll<select className="input" value={x.proto} onChange={(e) => up({ proto: e.target.value as any })}><option value="tcp">TCP</option><option value="udp">UDP</option></select></label>
              <label className="grow">Öffentlicher Port<input className="input mono" value={x.port || ''} onChange={(e) => up({ port: Number(e.target.value.replace(/\D/g, '')) })} placeholder="25565" /></label>
            </div>
            <label>Ziel-Gerät<select className="input" value={devs.some((d) => d.ip === x.to_ip) ? x.to_ip : ''} onChange={(e) => e.target.value && up({ to_ip: e.target.value })}>
              <option value="">– aus der Geräteliste –</option>
              {devs.map((d) => <option key={d.mac} value={d.ip!}>{d.name} · {d.ip}</option>)}
            </select></label>
            <div className="row" style={{ gap: 10 }}>
              <label className="grow">Ziel-IP<input className="input mono" value={x.to_ip} onChange={(e) => up({ to_ip: e.target.value.trim() })} placeholder="192.168.1.20" /></label>
              <label style={{ width: 130 }}>Ziel-Port<input className="input mono" disabled={same} value={same ? (x.port || '') : (x.to_port || '')} onChange={(e) => up({ to_port: Number(e.target.value.replace(/\D/g, '')) })} /></label>
            </div>
            <label className="check" style={{ alignSelf: 'flex-start', padding: 0 }}><input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} />Ziel-Port = öffentlicher Port</label>
            <label>Beschreibung<input className="input" maxLength={60} value={x.comment} onChange={(e) => up({ comment: e.target.value })} placeholder="z. B. Minecraft Survival" /></label>
            <label className="check" style={{ alignSelf: 'flex-start', padding: 0 }}><input type="checkbox" checked={x.enabled} onChange={(e) => up({ enabled: e.target.checked })} />aktiv</label>
          </div>
          {err && <div className="err">{err}</div>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" disabled={busy || !valid} onClick={() => onSave({ ...x, to_port: same ? x.port : x.to_port })}>{busy ? 'Übertrage an VPS …' : 'Speichern'}</button>
            <span className="grow" />
            {onDelete && !del && <button className="btn" style={{ color: 'var(--bad)' }} onClick={() => setDel(true)}><Trash2 size={14} />Löschen</button>}
            {onDelete && del && <button className="btn" style={{ background: 'var(--bad)', color: '#fff', borderColor: 'var(--bad)' }} disabled={busy} onClick={onDelete}>Wirklich löschen</button>}
          </div>
          <div className="dim" style={{ fontSize: 12 }}>Gilt sofort. Antwortet der VPS danach nicht mehr, nimmt er die Änderung nach 60 s selbst zurück.</div>
        </div>
      </aside>
    </>
  )
}
