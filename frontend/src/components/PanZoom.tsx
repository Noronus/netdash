import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'

export function useMedia(query: string) {
  const [m, setM] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const l = matchMedia(query)
    const f = () => setM(l.matches)
    l.addEventListener('change', f)
    return () => l.removeEventListener('change', f)
  }, [query])
  return m
}

type Pt = { x: number; y: number }
const MAX = 2.5
const DRAG = 6 // px before a touch counts as dragging instead of a tap

/**
 * Shows its content at a fixed desktop width, like a picture: drag to move, pinch (or ctrl + wheel) to zoom, taps still
 * reach the content. Fills the window height below its top edge. Starts fitted to the width and keeps fitting on resize
 * until the user moves it.
 */
export default function PanZoom({ width, children }: { width: number; children: React.ReactNode }) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const v = useRef({ x: 0, y: 0, s: 1 })
  const fitted = useRef(true)
  const pts = useRef(new Map<number, Pt>())
  const g = useRef({ moved: false, start: { x: 0, y: 0 }, dist: 0, mid: { x: 0, y: 0 } })
  const swallowClick = useRef(false)

  const fitScale = () => Math.min(1, (outer.current?.clientWidth || width) / width)
  const minScale = () => fitScale() * 0.75

  const apply = () => {
    const o = outer.current, i = inner.current
    if (!o || !i) return
    const c = v.current
    const cw = o.clientWidth, ch = o.clientHeight, w = width * c.s, h = i.offsetHeight * c.s, m = 48
    c.x = w <= cw ? (cw - w) / 2 : Math.min(m, Math.max(cw - w - m, c.x))
    c.y = h <= ch ? Math.min(m, Math.max(0, c.y)) : Math.min(m, Math.max(ch - h - m, c.y))
    i.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.s})`
  }
  const fit = () => {
    v.current = { x: 0, y: 0, s: fitScale() }
    fitted.current = true
    apply()
  }
  /** zoom to scale s keeping the point p (relative to the viewport box) where it is */
  const zoomAt = (p: Pt, s: number) => {
    const c = v.current
    const ns = Math.min(MAX, Math.max(minScale(), s))
    c.x = p.x - (p.x - c.x) * (ns / c.s)
    c.y = p.y - (p.y - c.y) * (ns / c.s)
    c.s = ns
    fitted.current = false
    apply()
  }
  const local = (x: number, y: number): Pt => {
    const r = outer.current!.getBoundingClientRect()
    return { x: x - r.left, y: y - r.top }
  }
  const center = (): Pt => ({ x: (outer.current?.clientWidth || 0) / 2, y: (outer.current?.clientHeight || 0) / 2 })

  // height: from the top of the box to the bottom of the window (minus the page's bottom padding / phone bar)
  useLayoutEffect(() => {
    const size = () => {
      const o = outer.current
      if (!o) return
      const top = o.getBoundingClientRect().top + window.scrollY
      const content = o.closest('.content')
      const pad = content ? parseFloat(getComputedStyle(content).paddingBottom) || 0 : 16
      o.style.height = Math.max(280, window.innerHeight - top - pad) + 'px'
      if (fitted.current) fit()
      else apply()
    }
    size()
    window.addEventListener('resize', size)
    const ro = new ResizeObserver(() => (fitted.current ? fit() : apply()))
    if (inner.current) ro.observe(inner.current)
    return () => { window.removeEventListener('resize', size); ro.disconnect() }
  }, [width])

  useEffect(() => {
    const o = outer.current
    if (!o) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey) zoomAt(local(e.clientX, e.clientY), v.current.s * Math.exp(-e.deltaY * 0.01))
      else { v.current.x -= e.deltaX; v.current.y -= e.deltaY; fitted.current = false; apply() }
    }
    // a drag must not end as a click on whatever is under the finger
    const click = (e: MouseEvent) => {
      if (!swallowClick.current) return
      swallowClick.current = false
      e.stopPropagation()
      e.preventDefault()
    }
    o.addEventListener('wheel', wheel, { passive: false })
    o.addEventListener('click', click, true)
    return () => { o.removeEventListener('wheel', wheel); o.removeEventListener('click', click, true) }
  }, [])

  const two = () => {
    const [a, b] = [...pts.current.values()]
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
  }
  const down = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if ((e.target as Element).closest('.pz-ctl')) return
    pts.current.set(e.pointerId, local(e.clientX, e.clientY))
    if (pts.current.size === 1) {
      g.current = { moved: false, start: local(e.clientX, e.clientY), dist: 0, mid: { x: 0, y: 0 } }
      swallowClick.current = false
    } else if (pts.current.size === 2) {
      const t = two()
      g.current.dist = t.dist
      g.current.mid = t.mid
    }
  }
  const move = (e: React.PointerEvent) => {
    const prev = pts.current.get(e.pointerId)
    if (!prev) return
    const cur = local(e.clientX, e.clientY)
    pts.current.set(e.pointerId, cur)
    const st = g.current
    if (!st.moved && Math.hypot(cur.x - st.start.x, cur.y - st.start.y) > DRAG) {
      st.moved = true
      for (const id of pts.current.keys()) try { outer.current?.setPointerCapture(id) } catch { /* pointer gone */ }
    }
    if (!st.moved) return
    if (pts.current.size === 1) {
      v.current.x += cur.x - prev.x
      v.current.y += cur.y - prev.y
      fitted.current = false
      apply()
    } else if (pts.current.size === 2) {
      const t = two()
      if (st.dist > 0) {
        v.current.x += t.mid.x - st.mid.x
        v.current.y += t.mid.y - st.mid.y
        zoomAt(t.mid, v.current.s * (t.dist / st.dist))
      }
      st.dist = t.dist
      st.mid = t.mid
    }
  }
  const up = (e: React.PointerEvent) => {
    if (!pts.current.delete(e.pointerId)) return
    if (g.current.moved) swallowClick.current = true
    if (pts.current.size === 2) { const t = two(); g.current.dist = t.dist; g.current.mid = t.mid }
    else g.current.dist = 0
  }

  return (
    <div ref={outer} className="pz" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div ref={inner} className="pz-in" style={{ width }}>{children}</div>
      <div className="pz-ctl">
        <button title="Vergrößern" onClick={() => zoomAt(center(), v.current.s * 1.4)}><Plus size={17} /></button>
        <button title="Verkleinern" onClick={() => zoomAt(center(), v.current.s / 1.4)}><Minus size={17} /></button>
        <button title="Einpassen" onClick={fit}><Maximize size={16} /></button>
      </div>
    </div>
  )
}
