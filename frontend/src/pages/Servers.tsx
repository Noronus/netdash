import React, { useState } from 'react'
import { Box, Cpu, Database, HardDrive } from 'lucide-react'
import ZfsDialog from '../components/Zfs'
import { Full } from '../api'
import { AreaChart } from '../components/charts'
import { Badge, Card, Dot, Meter, SrcError } from '../components/ui'
import { bytes, dur, pct, tone } from '../format'

export default function Servers({ full, cpuHist }: { full: Full; cpuHist: [number, number][] }) {
  const sys = full.system
  const un = full.unraid
  const [zfs, setZfs] = useState(false)
  return (
    <>
      <div className="grid">
        <Card className="c6" title="OPNsense" icon={<Cpu size={16} />} act={sys && <span>läuft seit {dur(sys.uptime)}</span>}>
          {sys && (
            <div className="col" style={{ gap: 12 }}>
              <div className="dim" style={{ fontSize: 12.5 }}>{sys.model} · {sys.cores} Kerne · FreeBSD {sys.os}</div>
              <AreaChart h={120} fmt={(v) => pct(v)} series={[{ label: 'CPU', color: 'var(--accent)', data: cpuHist.length ? cpuHist : sys.cpu_hist }]} />
              <Row label="CPU" v={sys.cpu || 0} txt={pct(sys.cpu)} />
              <Row label="RAM" v={(100 * sys.mem_used) / sys.mem_total} txt={`${bytes(sys.mem_used)} / ${bytes(sys.mem_total)}`} />
              <Row label="ZFS-Cache" v={(100 * sys.arc) / sys.mem_total} txt={bytes(sys.arc)} neutral />
              <Row label="Disk" v={(100 * sys.disk_used) / sys.disk_total} txt={`${bytes(sys.disk_used)} / ${bytes(sys.disk_total)}`} />
              <div className="row wrap dim" style={{ gap: 18, fontSize: 12.5 }}>
                <span>Last {sys.load.map((l) => l.toFixed(2)).join(' · ')}</span>
                {sys.temps.map((t) => <span key={t.sensor}>{t.c.toFixed(1)} °C</span>)}
                <span>{sys.pf_states} Firewall-States</span>
              </div>
            </div>
          )}
        </Card>
        <Card className="c6" title={un ? `Unraid · ${un.hostname}` : 'Unraid'} icon={<HardDrive size={16} />}
          act={un && <><Badge t={un.array_state === 'STARTED' ? 'ok' : 'warn'}>{un.array_state}</Badge><span>seit {dur(Date.now() / 1000 - Date.parse(un.boot) / 1000)}</span></>}>
          <SrcError src={full.sources.unraid} label="Unraid" />
          {un && (
            <div className="col" style={{ gap: 12 }}>
              <div className="dim" style={{ fontSize: 12.5 }}>{un.cpu_model} · {un.threads} Threads</div>
              <Row label="CPU" v={un.cpu} txt={pct(un.cpu)} />
              <Row label="RAM" v={(100 * (un.mem.total - un.mem.available)) / un.mem.total} txt={`${bytes(un.mem.total - un.mem.available)} / ${bytes(un.mem.total)}`} />
              {un.mem.swapTotal > 0 && <Row label="Swap" v={(100 * un.mem.swapUsed) / un.mem.swapTotal} txt={`${bytes(un.mem.swapUsed)} / ${bytes(un.mem.swapTotal)}`} />}
              <div className="row" style={{ marginTop: 4 }}><span className="dim grow" style={{ fontSize: 12, fontWeight: 600 }}>SPEICHER</span>{un.zfs && <button className="btn sm" onClick={() => setZfs(true)}><Database size={13} />ZFS-Datasets</button>}</div>
              {un.pools.map((p) => (
                <div key={p.name} className="row">
                  <span style={{ width: 90 }} className="ell">{p.name}</span>
                  {p.fs_size ? (
                    <>
                      <div className="grow"><Meter value={p.fs_used || 0} max={p.fs_size} t={tone((100 * (p.fs_used || 0)) / p.fs_size, 80, 92)} /></div>
                      <span className="num dim" style={{ width: 150, textAlign: 'right', fontSize: 12.5 }}>{bytes((p.fs_used || 0) * 1024)} / {bytes(p.fs_size * 1024)}</span>
                    </>
                  ) : <span className="dim grow" style={{ fontSize: 12.5 }}>Mitglied · {bytes(p.size * 1024)}</span>}
                  <span className="num" style={{ width: 52, textAlign: 'right', fontSize: 12.5, color: (p.temp || 0) > 50 ? 'var(--warn)' : 'var(--text-2)' }}>{p.temp != null ? p.temp + ' °C' : 'Standby'}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      {un && (
        <Card title={`Docker · ${un.containers.filter((c) => c.state === 'RUNNING').length}/${un.containers.length} laufen`} icon={<Box size={16} />}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
            {[...un.containers].sort((a, b) => Number(b.state === 'RUNNING') - Number(a.state === 'RUNNING') || a.name.localeCompare(b.name)).map((c) => (
              <div key={c.name} className="row" style={{ padding: '8px 11px', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border-soft)' }}>
                <Dot t={c.state === 'RUNNING' ? (c.status.includes('unhealthy') ? 'warn' : 'ok') : 'off'} />
                <div className="col grow" style={{ gap: 0 }}>
                  <b className="ell">{c.name.length > 30 ? c.image.split('/').pop() : c.name}</b>
                  <span className="dim ell" style={{ fontSize: 11.5 }}>{c.status}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
      {zfs && <ZfsDialog title={un?.hostname} onClose={() => setZfs(false)} />}
    </>
  )
}

function Row({ label, v, txt, neutral }: { label: string; v: number; txt: string; neutral?: boolean }) {
  return (
    <div className="row">
      <span className="dim" style={{ width: 90 }}>{label}</span>
      <div className="grow"><Meter value={v} t={neutral ? undefined : tone(v, 75, 90)} /></div>
      <span className="num" style={{ width: 150, textAlign: 'right', fontSize: 12.5 }}>{txt}</span>
    </div>
  )
}
