import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { CircleCheck, CirclePlay, Hourglass, Keyboard, Mic, MousePointerClick, type LucideIcon } from 'lucide-react'
import { placeCard } from '@cuelight/schema'
import type { CardKind, OverlayApi, OverlayView } from '../../../shared/types.ts'
import './overlay.css'

declare global {
  interface Window {
    overlay: OverlayApi
  }
}

const KIND_ICON: Record<CardKind, LucideIcon> = {
  'say-then-click': MousePointerClick,
  click: MousePointerClick,
  read: Mic,
  'read-free': Mic,
  wait: Hourglass,
  manual: Keyboard,
  preroll: CirclePlay,
  done: CircleCheck,
}

function Overlay() {
  const [v, setV] = useState<OverlayView | null>(null)
  const line = useRef<SVGLineElement>(null)
  const hole = useRef<OverlayView['hole']>(null)

  useEffect(() => {
    window.overlay.onView(setV)
    window.overlay.onCursor((p) => {
      const l = line.current
      const h = hole.current
      if (!l) return
      if (!p || !h) {
        l.style.display = 'none'
        return
      }
      l.style.display = ''
      l.setAttribute('x1', String(p.x))
      l.setAttribute('y1', String(p.y))
      l.setAttribute('x2', String(h[0] + h[2] / 2))
      l.setAttribute('y2', String(h[1] + h[3] / 2))
    })
    window.overlay.ready()
  }, [])

  hole.current = v?.hole ?? null
  if (!v) return null

  return (
    <div className="stage" style={{ opacity: v.visible ? 1 : 0 }}>
      {v.dim === 'full' && <div className="dim-full" />}
      {v.hole && <Spotlight hole={v.hole} dim={v.dim === 'around'} inside={v.inside} stepKey={v.card?.key ?? 0} />}
      <svg className="guide" width="100%" height="100%">
        <line ref={line} style={{ display: 'none' }} />
      </svg>
      {v.card && <Card view={v} />}
      {v.pattern && <Pattern rect={v.pattern} />}
      {v.capturable && <div className="debug-badge">{v.capturableLabel}</div>}
    </div>
  )
}

/** The hole and its ring. Step changes glide; scroll updates follow almost instantly. */
function Spotlight({ hole, dim, inside, stepKey }: { hole: [number, number, number, number]; dim: boolean; inside: boolean; stepKey: number }) {
  const prevKey = useRef(stepKey)
  const stepChanged = prevKey.current !== stepKey
  prevKey.current = stepKey
  const [x, y, w, h] = hole
  const style: CSSProperties = {
    transform: `translate(${x}px, ${y}px)`,
    width: w,
    height: h,
    transition: stepChanged ? 'transform .38s ease-in-out, width .38s ease-in-out, height .38s ease-in-out' : 'transform .06s linear, width .06s linear, height .06s linear',
  }
  return (
    <>
      <div className={'hole' + (dim ? ' dim' : '')} style={style} />
      <div className={'ring' + (inside ? ' inside' : '')} style={style} />
    </>
  )
}

function Card({ view }: { view: OverlayView }) {
  const c = view.card!
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const prevKey = useRef(c.key)
  const animate = prevKey.current !== c.key
  prevKey.current = c.key

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const size = { w: el.offsetWidth, h: el.offsetHeight }
    setPos(placeCard(view.hole, size, { w: innerWidth, h: innerHeight, top: view.topInset }, c.placement))
  }, [view.hole, view.topInset, c, view.progress !== null])

  const Icon = KIND_ICON[c.kind]
  const counter = c.kind === 'preroll' || c.kind === 'done' ? '' : `${c.n}/${c.total}  ·  `
  return (
    <div
      ref={ref}
      className="card"
      style={{
        transform: pos ? `translate(${pos.x}px, ${pos.y}px)` : undefined,
        visibility: pos ? 'visible' : 'hidden',
        transition: animate ? 'transform .38s ease-in-out' : 'none',
      }}
    >
      {c.hint ? <div className="tag hint">{c.hint}</div> : <div className="tag">{counter + c.tag}</div>}
      {c.how && (
        <div className="how">
          <Icon size={18} strokeWidth={2.4} aria-hidden />
          <span>{c.how}</span>
        </div>
      )}
      {c.say && <div className="say">{c.say}</div>}
      {c.next && <div className="next">{c.next.length > 90 ? c.next.slice(0, 88) + '…' : c.next}</div>}
      {view.progress !== null && (
        <div className="bar">
          <div className="fill" style={{ transform: `scaleX(${Math.max(0, Math.min(1, view.progress))})` }} />
        </div>
      )}
    </div>
  )
}

function Pattern({ rect: [x, y, w, h] }: { rect: [number, number, number, number] }) {
  return (
    <div className="pattern" style={{ left: x, top: y, width: w, height: h }}>
      <i style={{ background: '#ff00ff' }} />
      <i style={{ background: '#00ffff' }} />
      <i style={{ background: '#ffff00' }} />
      <i style={{ background: '#0000ff' }} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Overlay />)
