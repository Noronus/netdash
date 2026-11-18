import React, { useEffect, useMemo, useRef, useState } from 'react'

/** height of an element, follows resizes */
function useHeight(ref: React.RefObject<HTMLElement>, fallback: number, on: boolean) {
  const [h, setH] = useState(fallback)
  useEffect(() => {
    if (!on || !ref.current) return
    const ro = new ResizeObserver(([e]) => setH(Math.max(fallback, Math.floor(e.contentRect.height))))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [on])
  return on ? h : fallback
}
import { clock } from '../format'

export function Sparkline({ data, color = 'var(--accent)', h = 36, fill = true, grow }: { data: number[]; color?: string; h?: number; fill?: boolean; grow?: boolean }) {
  if (grow) return <div className="grow-box" style={{ minHeight: h }}><SparkSvg data={data} color={color} h={h} fill={fill} full /></div>
  return <SparkSvg data={data} color={color} h={h} fill={fill} />
}

function SparkSvg({ data, color, h, fill, full }: { data: number[]; color: string; h: number; fill: boolean; full?: boolean }) {
  const w = 120
  const id = useMemo(() => 'sp' + Math.random().toString(36).slice(2), [])
  if (!data.length) return <svg viewBox={`0 0 ${w} ${h}`} style={{ height: h }} />
  const max = Math.max(...data, 1)
  const pts = data.map((v, i) => [(i / Math.max(data.length - 1, 1)) * w, h - 2 - (v / max) * (h - 4)])
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ height: full ? '100%' : h, width: '100%', display: 'block' }}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={d + ` L ${w} ${h} L 0 ${h} Z`} fill={`url(#${id})`} />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}

export type Series = { label: string; color: string; data: [number, number][] }

/** time series area chart; x = unix seconds */
export function AreaChart({ series, h: h0 = 220, fmt, xfmt = clock, grow }: { series: Series[]; h?: number; fmt: (v: number) => string; xfmt?: (t: number) => string; grow?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const h = useHeight(box, h0, !!grow)
  const [hover, setHover] = useState<number | null>(null)
  const id = useMemo(() => 'ac' + Math.random().toString(36).slice(2), [])
  const W = 1000
  const pad = { l: 0, r: 0, t: 10, b: 22 }
  const all = series.flatMap((s) => s.data)
  if (all.length < 2) return <div ref={box} className={'empty' + (grow ? ' grow-box' : '')} style={{ minHeight: h0 }}>Sammle Daten …</div>
  const x0 = Math.min(...all.map((p) => p[0]))
  const x1 = Math.max(...all.map((p) => p[0]))
  const ymax = niceMax(Math.max(...all.map((p) => p[1]), 1))
  const X = (t: number) => pad.l + ((t - x0) / Math.max(x1 - x0, 1)) * (W - pad.l - pad.r)
  const Y = (v: number) => pad.t + (1 - v / ymax) * (h - pad.t - pad.b)
  const ticks = [0, 0.5, 1].map((f) => ymax * f)
  const xt = [0, 0.25, 0.5, 0.75, 1].map((f) => x0 + (x1 - x0) * f)
  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const fx = (e.clientX - r.left) / r.width
    setHover(x0 + fx * (x1 - x0))
  }
  let tip: React.ReactNode = null
  if (hover != null) {
    const vals = series.map((s) => {
      let best = s.data[0]
      for (const p of s.data) if (Math.abs(p[0] - hover) < Math.abs(best[0] - hover)) best = p
      return { s, p: best }
    })
    const t = vals[0].p[0]
    tip = (
      <>
        <div className="tip" style={{ left: (X(t) / W) * 100 + '%', top: Math.min(...vals.map((v) => Y(v.p[1]))) }}>
          <div className="dim" style={{ marginBottom: 3 }}>{xfmt(t)}</div>
          {vals.map((v) => (
            <div key={v.s.label} className="row gap6"><i style={{ width: 8, height: 8, borderRadius: 2, background: v.s.color, display: 'inline-block' }} />{v.s.label}: <b>{fmt(v.p[1])}</b></div>
          ))}
        </div>
      </>
    )
  }
  return (
    <div ref={box} className={grow ? 'grow-box' : undefined} style={grow ? { minHeight: h0 } : undefined}>
    <div className="chart" ref={ref} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={grow ? { position: 'absolute', inset: 0 } : undefined}>
      <svg viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" style={{ height: h }}>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={i} id={id + i} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={s.color} stopOpacity=".28" />
              <stop offset="1" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((v, i) => <line key={i} className="gridline" x1={0} x2={W} y1={Y(v)} y2={Y(v)} vectorEffect="non-scaling-stroke" />)}
        {series.map((s, i) => {
          if (s.data.length < 2) return null
          const d = s.data.map((p, j) => (j ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join(' ')
          return (
            <g key={i}>
              <path d={d + ` L ${X(s.data[s.data.length - 1][0])} ${Y(0)} L ${X(s.data[0][0])} ${Y(0)} Z`} fill={`url(#${id + i})`} />
              <path d={d} fill="none" stroke={s.color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </g>
          )
        })}
        {hover != null && <line x1={X(hover)} x2={X(hover)} y1={pad.t} y2={h - pad.b} stroke="var(--text-3)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {ticks.slice(1).map((v, i) => (
          <span key={i} className="axis" style={{ position: 'absolute', left: 4, top: Y(v) - 15, fontSize: 10.5, color: 'var(--text-3)' }}>{fmt(v)}</span>
        ))}
        {xt.map((t, i) => (
          <span key={i} style={{ position: 'absolute', bottom: 2, left: (X(t) / W) * 100 + '%', transform: i === 0 ? 'none' : i === xt.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)', fontSize: 10.5, color: 'var(--text-3)' }}>{xfmt(t)}</span>
        ))}
      </div>
      {tip}
    </div>
    </div>
  )
}

/** grouped bars, two values per slot */
export function Bars({ data, h = 160, fmt, a, b }: {
  data: { label: string; a: number; b?: number; title?: string }[]; h?: number; fmt: (v: number) => string
  a: { color: string; label: string }; b?: { color: string; label: string }
}) {
  const [hover, setHover] = useState<number | null>(null)
  if (!data.length) return <div className="empty">Noch keine Daten</div>
  const max = niceMax(Math.max(...data.map((d) => Math.max(d.a, d.b || 0)), 1))
  const n = data.length
  const showEvery = Math.ceil(n / 8)
  return (
    <div className="chart" style={{ height: h }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: h - 20, position: 'relative' }}>
        <span style={{ position: 'absolute', top: -2, left: 0, fontSize: 10.5, color: 'var(--text-3)' }}>{fmt(max)}</span>
        {data.map((d, i) => (
          <div key={i} style={{ flex: 1, display: 'flex', gap: 1, alignItems: 'flex-end', height: '100%', position: 'relative' }}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <div style={{ flex: 1, height: (100 * d.a) / max + '%', minHeight: d.a ? 2 : 0, background: a.color, borderRadius: '3px 3px 0 0', opacity: hover == null || hover === i ? 1 : 0.5 }} />
            {b && <div style={{ flex: 1, height: (100 * (d.b || 0)) / max + '%', minHeight: d.b ? 2 : 0, background: b.color, borderRadius: '3px 3px 0 0', opacity: hover == null || hover === i ? 1 : 0.5 }} />}
            {hover === i && (
              <div className="tip" style={{ left: '50%', top: 0 }}>
                <div className="dim">{d.title || d.label}</div>
                <div>{a.label}: <b>{fmt(d.a)}</b></div>
                {b && <div>{b.label}: <b>{fmt(d.b || 0)}</b></div>}
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 3, marginTop: 4 }}>
        {data.map((d, i) => <span key={i} style={{ flex: 1, fontSize: 10.5, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'visible', width: 0 }}>{i % showEvery === 0 ? d.label : ''}</span>)}
      </div>
    </div>
  )
}

export function Donut({ parts, size = 92, stroke = 12, center }: { parts: { v: number; color: string }[]; size?: number; stroke?: number; center?: React.ReactNode }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const tot = parts.reduce((a, p) => a + p.v, 0) || 1
  let off = 0
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        {parts.map((p, i) => {
          const len = (p.v / tot) * c
          const el = <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={p.color} strokeWidth={stroke} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-off} strokeLinecap="butt" />
          off += len
          return el
        })}
      </svg>
      {center && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>{center}</div>}
    </div>
  )
}

function niceMax(v: number) {
  const e = Math.pow(10, Math.floor(Math.log10(v)))
  const m = v / e
  const n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10
  return n * e
}
