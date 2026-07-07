import { useEffect, useRef, useState } from 'react'
import exifr from 'exifr'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Small Leaflet map shown bottom-left of the viewer
function MiniMap({ lat, lon }) {
  const elRef  = useRef(null)
  const mapRef = useRef(null)
  const mrkRef = useRef(null)

  // init map once
  useEffect(() => {
    if (!elRef.current || mapRef.current) return
    const map = L.map(elRef.current, {
      zoomControl: false, attributionControl: false,
      dragging: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false,
    })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map)
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [])

  // update marker + view whenever coords change
  useEffect(() => {
    const map = mapRef.current
    if (!map || lat == null || lon == null) return
    if (mrkRef.current) mrkRef.current.remove()
    const icon = L.divIcon({
      className: '',
      html: '<div class="minimap-dot"></div>',
      iconSize: [14, 14], iconAnchor: [7, 7],
    })
    mrkRef.current = L.marker([lat, lon], { icon }).addTo(map)
    map.setView([lat, lon], 16)
  }, [lat, lon])

  return (
    <div className="minimap-wrap">
      <div ref={elRef} className="minimap-el" />
      {(lat == null) && <div className="minimap-nogps">No GPS</div>}
    </div>
  )
}

// Tower row with inline subfolder accordion + auto-scroll when opened
function TowerAccordion({ tower, subfolders, isOpen, onToggle, onMove, onDrop }) {
  const rowRef = useRef(null)
  useEffect(() => {
    if (isOpen && rowRef.current)
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [isOpen])
  return (
    <div className="lb-tower" ref={rowRef}>
      <div className="lb-tower-row"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => onDrop(e, null)}>
        <span className="lb-tower-label">{tower.label}</span>
        <button className="lb-move-btn" onClick={() => onMove(null)}>Move →</button>
        {subfolders.length > 0 && (
          <button className="lb-exp" onClick={onToggle}>
            {isOpen ? '▾' : '▸'}
          </button>
        )}
      </div>
      {isOpen && subfolders.map((sf) => (
        <button key={sf} className="lb-sf"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => onDrop(e, sf)}
          onClick={() => onMove(sf)}>
          📂 {sf} →
        </button>
      ))}
    </div>
  )
}

// derive a Visual / Thermal / Wide / Zoom tag from the DJI filename suffix
function classify(name = '') {
  const n = name.toUpperCase()
  if (/_T\.|_THERMAL/.test(n)) return { label: 'Thermal', cls: 'thermal' }
  if (/_W\./.test(n)) return { label: 'Wide', cls: 'wide' }
  if (/_Z\./.test(n)) return { label: 'Zoom', cls: 'zoom' }
  if (/_V\./.test(n)) return { label: 'Visual', cls: 'visual' }
  return { label: 'Image', cls: 'visual' }
}

const fmtDate = (d) =>
  d instanceof Date && !isNaN(d)
    ? d.toLocaleString('en-GB', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    : '—'

// Full-screen drone image viewer: fit-to-screen, zoom/pan, EXIF metadata bar.
export default function Lightbox({
  items, index, onIndex, onClose,
  towers = [], subfolders = [], onAssign, onMoveToPool,
  context = 'pool',   // 'pool' | 'tower' | 'subfolder'
  contextTowerId = null,
}) {
  const img = items[index]
  const tag = classify(img.name)

  const [scale, setScale] = useState(1)
  const [rot, setRot] = useState(0)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  const [meta, setMeta] = useState(null) // { lat, lon, alt, captured }
  const [openTower, setOpenTower] = useState(null)
  const [flash, setFlash] = useState(null)
  const drag = useRef(null)
  const rootRef = useRef(null)
  const imgEl = useRef(null)

  const reset = () => { setScale(1); setRot(0); setPos({ x: 0, y: 0 }) }
  const clampScale = (s) => Math.min(8, Math.max(0.15, s))
  const zoomBy = (f) => setScale((s) => clampScale(s * f))

  const PANEL_W = towers.length > 0 ? 270 : 0
  const availW = window.innerWidth - PANEL_W

  // fit the image to the available image area (excluding the panel)
  const fit = natural.w
    ? Math.min(availW / natural.w, window.innerHeight / natural.h)
    : 1
  const dispW = natural.w ? natural.w * fit * scale : null

  // reset transforms + read natural size when the image changes
  useEffect(() => {
    reset()
    const el = imgEl.current
    if (el && el.complete && el.naturalWidth)
      setNatural({ w: el.naturalWidth, h: el.naturalHeight })
    else setNatural({ w: 0, h: 0 })
  }, [index, img.url])

  // read EXIF (GPS / altitude / capture time) from the original file
  useEffect(() => {
    let alive = true
    setMeta(null)
    exifr
      .parse(img.file, { gps: true, xmp: true, tiff: true, exif: true })
      .then((d) => {
        if (!alive || !d) return setMeta({})
        const alt =
          d.RelativeAltitude != null ? parseFloat(d.RelativeAltitude)
          : d.AbsoluteAltitude != null ? parseFloat(d.AbsoluteAltitude)
          : d.GPSAltitude
        setMeta({
          lat: d.latitude, lon: d.longitude, alt,
          captured: d.DateTimeOriginal || d.CreateDate || d.ModifyDate,
        })
      })
      .catch(() => alive && setMeta({}))
    return () => { alive = false }
  }, [img.file])

  // keyboard
  useEffect(() => {
    const onKey = (e) => {
      switch (e.key) {
        case 'Escape': onClose(); break
        case 'ArrowRight': if (index < items.length - 1) onIndex(index + 1); break
        case 'ArrowLeft': if (index > 0) onIndex(index - 1); break
        case '+': case '=': zoomBy(1.2); break
        case '-': case '_': zoomBy(1 / 1.2); break
        case '0': reset(); break
        case 'r': case 'R': setRot((r) => r + 90); break
        default: break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, items.length])

  // non-passive wheel so we stop browser zoom and zoom the image instead.
  // Skip if the pointer is over the sort panel so it can scroll normally.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const h = (e) => {
      if (e.target.closest('.lb-sort')) return
      e.preventDefault()
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15)
    }
    el.addEventListener('wheel', h, { passive: false })
    return () => el.removeEventListener('wheel', h)
  }, [])

  const onMouseDown = (e) => {
    e.preventDefault()
    drag.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
  }
  const onMouseMove = (e) => {
    if (!drag.current) return
    setPos({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y })
  }
  const endPan = () => (drag.current = null)
  const go = (d, e) => { e.stopPropagation(); const n = index + d; if (n >= 0 && n < items.length) onIndex(n) }
  const stop = (e) => e.stopPropagation()

  const assign = (towerId, sf) => {
    if (!onAssign) return
    onAssign(img.id, towerId, sf || null)
    setFlash(`→ ${towerId}${sf ? ' / ' + sf : ''}`)
    setTimeout(() => setFlash(null), 1100)
    if (index < items.length - 1) onIndex(index + 1)
  }
  const assignPool = () => {
    if (!onMoveToPool) return
    onMoveToPool(img.id)
    setFlash('→ Folder 1')
    setTimeout(() => setFlash(null), 1100)
    if (index < items.length - 1) onIndex(index + 1)
  }
  const dropAssign = (e, towerId, sf) => {
    e.preventDefault(); e.stopPropagation()
    const id = e.dataTransfer.getData('text/plain')
    if (id && onAssign) {
      onAssign(id, towerId, sf || null)
      setFlash(`→ ${towerId}${sf ? ' / ' + sf : ''}`)
      setTimeout(() => setFlash(null), 1100)
    }
  }

  // the context tower object (when opened from tower/subfolder)
  const ctxTower = towers.find((t) => t.id === contextTowerId) || null

  const loc = img.towerId
    ? `${img.towerId}${img.subPath?.length ? ' / ' + img.subPath.join(' / ') : ''}`
    : 'Unsorted'

  return (
    <div className="viewer" ref={rootRef}>

      {/* ======= IMAGE AREA (shrinks when panel is open) ======= */}
      <div
        className="vw-main"
        style={{ right: `${PANEL_W}px` }}
        onMouseMove={onMouseMove}
        onMouseUp={endPan}
        onMouseLeave={endPan}
      >
        <img
          className="vw-img"
          ref={imgEl}
          src={img.url}
          alt={img.name}
          draggable
          onLoad={(e) => setNatural({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
          onDragStart={(e) => e.dataTransfer.setData('text/plain', img.id)}
          onMouseDown={onMouseDown}
          onDoubleClick={() => setScale((s) => (s > 1 ? 1 : 2))}
          style={{
            width: dispW ? `${dispW}px` : 'auto',
            height: 'auto',
            maxWidth: dispW ? 'none' : '100%',
            maxHeight: dispW ? 'none' : '100%',
            transform: pos.x || pos.y || rot
              ? `translate(${pos.x}px, ${pos.y}px) rotate(${rot}deg)` : 'none',
            cursor: drag.current ? 'grabbing' : 'grab',
          }}
        />

        {/* ---------- TOP BAR ---------- */}
        <div className="vw-top">
          <div className="vw-id">
            <span className="dot" /> {loc}
          </div>
          <div className="vw-title">{img.name}</div>
          <span className={`vw-tag ${tag.cls}`}>{tag.label}</span>
          <div className="vw-spacer" />
          <span className="vw-count">{index + 1} / {items.length}</span>
          <button className="vw-close" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        {/* ---------- NAV ARROWS ---------- */}
        {index > 0 && <button className="vw-nav left" onClick={(e) => go(-1, e)}>‹</button>}
        {index < items.length - 1 && <button className="vw-nav right" onClick={(e) => go(1, e)}>›</button>}

        {flash && <div className="vw-flash">{flash}</div>}

        {/* ---------- BOTTOM INFO BAR ---------- */}
        <div className="vw-bottom">
        <Info label="📍 Coordinates" value={
          meta == null ? '…'
          : meta.lat != null ? `${meta.lat.toFixed(6)}, ${meta.lon.toFixed(6)}`
          : '—'} />
        <Info label="⛰ Altitude" value={
          meta == null ? '…' : meta.alt != null ? `${Number(meta.alt).toFixed(1)} m` : '—'} />
        <Info label="🕑 Captured" value={meta == null ? '…' : fmtDate(meta.captured)} />
        <Info label="⌨ Keys" value="← → navigate · +/− zoom · R rotate" />

        {/* zoom controls */}
        <div className="vw-zoom">
          <button onClick={() => zoomBy(1 / 1.2)} title="Zoom out (−)">−</button>
          <span className={fit * scale > 1.001 ? 'over' : ''}>
            {Math.round(fit * scale * 100)}%
          </span>
          <button onClick={() => zoomBy(1.2)} title="Zoom in (+)">+</button>
          <button onClick={reset} title="Fit (0)">Fit</button>
          <button onClick={() => setScale(clampScale(1 / fit))} title="Actual pixels">1:1</button>
          <button onClick={() => setRot((r) => r + 90)} title="Rotate (R)">⟳</button>
        </div>
      </div>

        {/* mini-map bottom-left */}
        <MiniMap lat={meta?.lat} lon={meta?.lon} />
      </div>{/* end vw-main */}

      {/* ---------- NO TOWERS POPUP ---------- */}
      {towers.length === 0 && (
        <div className="no-towers-overlay" onClick={stop}>
          <div className="no-towers-card">
            <div className="no-towers-icon">🗼</div>
            <h2>No Towers Created Yet</h2>
            <p>Close this viewer, set a tower range in the top bar, and click <strong>Create</strong> before sorting images.</p>
            <button className="no-towers-btn" onClick={onClose}>
              Go Create Towers →
            </button>
          </div>
        </div>
      )}

      {/* ---------- CONTEXT-AWARE SORT PANEL (right column, fully scrollable) ---------- */}
      {towers.length > 0 && (
        <div className="lb-sort" onClick={stop}>
          {/* POOL: move to tower → expand inline to pick subfolder */}
          {context === 'pool' && (
            <>
              <div className="lb-sort-head">Move to Tower</div>
              <div className="lb-sort-list">
                {towers.map((t) => (
                  <TowerAccordion
                    key={t.id}
                    tower={t}
                    subfolders={subfolders}
                    isOpen={openTower === t.id}
                    onToggle={() => setOpenTower(openTower === t.id ? null : t.id)}
                    onMove={(sf) => assign(t.id, sf)}
                    onDrop={(e, sf) => dropAssign(e, t.id, sf)}
                  />
                ))}
              </div>
            </>
          )}

          {/* TOWER/SUBFOLDER: show current tower's subfolders first, then switch tower */}
          {(context === 'tower' || context === 'subfolder') && ctxTower && (
            <>
              <div className="lb-sort-head">📁 {ctxTower.label}</div>
              <div className="lb-sort-list">
                <button className="lb-back" onClick={assignPool}>← Back to Folder 1</button>

                {/* subfolders of the current tower — prominent at the top */}
                {subfolders.length > 0 && (
                  <>
                    <div className="lb-section-label">Subfolders of {ctxTower.id}</div>
                    {subfolders.map((sf) => (
                      <button key={sf} className="lb-sf-big"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => dropAssign(e, ctxTower.id, sf)}
                        onClick={() => assign(ctxTower.id, sf)}>
                        📂 {sf}
                      </button>
                    ))}
                    <button className="lb-sf-big unsorted"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => dropAssign(e, ctxTower.id, null)}
                      onClick={() => assign(ctxTower.id, null)}>
                      📄 Keep unsorted in {ctxTower.id}
                    </button>
                  </>
                )}

                {/* other towers as accordion */}
                <div className="lb-section-label">Switch to another tower</div>
                {towers.filter(t => t.id !== ctxTower.id).map((t) => (
                  <TowerAccordion
                    key={t.id}
                    tower={t}
                    subfolders={subfolders}
                    isOpen={openTower === t.id}
                    onToggle={() => setOpenTower(openTower === t.id ? null : t.id)}
                    onMove={(sf) => assign(t.id, sf)}
                    onDrop={(e, sf) => dropAssign(e, t.id, sf)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Info({ label, value }) {
  return (
    <div className="vw-info">
      <div className="vw-info-label">{label}</div>
      <div className="vw-info-value">{value}</div>
    </div>
  )
}
