import { useEffect, useRef, useState } from 'react'
import exifr from 'exifr'

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

  // non-passive wheel so we stop browser zoom and zoom the image instead
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const h = (e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15) }
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
    ? `${img.towerId}${img.subfolder ? ' / ' + img.subfolder : ''}`
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

      {/* ---------- CONTEXT-AWARE SORT PANEL (right column) ---------- */}
      {towers.length > 0 && (
        <div className="lb-sort" onClick={stop}>
          {/* POOL context: pick a tower to move this image into */}
          {context === 'pool' && (
            <>
              <div className="lb-sort-head">Move to Tower</div>
              <div className="lb-sort-list">
                {towers.map((t) => (
                  <div key={t.id} className="lb-tower">
                    <div className="lb-tower-row"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => dropAssign(e, t.id, null)}>
                      <span className="lb-tower-label">{t.label}</span>
                      <button className="lb-move-btn" onClick={() => assign(t.id, null)}>
                        Move →
                      </button>
                      {subfolders.length > 0 && (
                        <button className="lb-exp"
                          onClick={() => setOpenTower(openTower === t.id ? null : t.id)}>
                          {openTower === t.id ? '▾' : '▸'}
                        </button>
                      )}
                    </div>
                    {openTower === t.id && subfolders.map((sf) => (
                      <button key={sf} className="lb-sf"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => dropAssign(e, t.id, sf)}
                        onClick={() => assign(t.id, sf)}>
                        📂 {sf} →
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* TOWER context: pick a subfolder within the current tower */}
          {(context === 'tower' || context === 'subfolder') && ctxTower && (
            <>
              <div className="lb-sort-head">
                <span>📁 {ctxTower.label}</span>
              </div>
              <div className="lb-sort-list">
                {/* move back to pool */}
                <button className="lb-back" onClick={assignPool}>
                  ← Back to Folder 1
                </button>
                {/* move to a different tower */}
                <div className="lb-section-label">Move to tower</div>
                {towers.filter(t => t.id !== ctxTower.id).map((t) => (
                  <div key={t.id} className="lb-tower">
                    <div className="lb-tower-row"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => dropAssign(e, t.id, null)}>
                      <span className="lb-tower-label">{t.label}</span>
                      <button className="lb-move-btn" onClick={() => assign(t.id, null)}>
                        Move →
                      </button>
                    </div>
                  </div>
                ))}
                {/* subfolders of the current tower */}
                {subfolders.length > 0 && (
                  <>
                    <div className="lb-section-label">Move to subfolder</div>
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
                      📄 Keep in {ctxTower.id} (unsorted)
                    </button>
                  </>
                )}
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
