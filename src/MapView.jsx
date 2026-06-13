import { useEffect, useRef, useState } from 'react'
import exifr from 'exifr'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import JSZip from 'jszip'
import { parseKML } from './kmlParser.js'

export default function MapView({ allImages, towers, onAssign, onClose }) {
  const mapElRef  = useRef(null)
  const mapRef    = useRef(null)
  const markerMap = useRef({})   // imgId → L.Marker

  const [coords,      setCoords]      = useState({})
  const [loading,     setLoading]     = useState(true)
  const [selectedIds, setSelectedIds] = useState(new Set())

  // KML state
  const [kmlFeatures, setKmlFeatures] = useState([])   // parsed features
  const [kmlName,     setKmlName]     = useState('')
  const kmlLayerRef = useRef([])                        // Leaflet layers added for KML

  // rubber-band (Ctrl+drag only)
  const rbRef    = useRef(null)
  const [rbRect, setRbRect] = useState(null)

  // only pool images have GPS dots (images still in Folder 1)
  const poolImages = allImages.filter(i => !i.towerId)

  // ── load EXIF GPS ──────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    setLoading(true)
    ;(async () => {
      const result = {}
      await Promise.allSettled(poolImages.map(async img => {
        try {
          const gps = await exifr.gps(img.file)
          if (gps?.latitude != null)
            result[img.id] = { lat: gps.latitude, lon: gps.longitude }
        } catch {}
      }))
      if (alive) { setCoords(result); setLoading(false) }
    })()
    return () => { alive = false }
  }, [allImages])

  // ── init Leaflet ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapElRef.current || mapRef.current) return
    const map = L.map(mapElRef.current, {
      zoomControl:      true,
      scrollWheelZoom:  true,   // mouse wheel zoom
      doubleClickZoom:  true,   // double-click to zoom in
      dragging:         true,   // pan by dragging
      touchZoom:        true,   // pinch zoom on touch screens
      keyboard:         true,   // arrow keys pan, +/- zoom
      boxZoom:          true,   // shift+drag to zoom to a box
      zoomSnap:         0.5,    // finer zoom steps
      wheelPxPerZoomLevel: 80,  // smoother wheel zoom
      worldCopyJump:    true,
    })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 19,
    }).addTo(map)
    L.control.scale({ imperial: false }).addTo(map)   // metric scale bar
    map.setView([20.5937, 78.9629], 5)                // sensible default until data loads
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [])

  // ── Ctrl+drag rubber-band on the map container ────────────────────────────
  useEffect(() => {
    const el = mapElRef.current
    const map = mapRef.current
    if (!el || !map) return

    const onDown = (e) => {
      if (!e.ctrlKey && !e.metaKey) return   // only with Ctrl held
      e.preventDefault()
      map.dragging.disable()
      rbRef.current = { startX: e.clientX, startY: e.clientY }
      setSelectedIds(new Set())
    }
    el.addEventListener('mousedown', onDown)
    return () => el.removeEventListener('mousedown', onDown)
  }, [loading])

  // ── global mousemove / mouseup ────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e) => {
      if (!rbRef.current) return
      const { startX, startY } = rbRef.current
      const rect = {
        left:   Math.min(startX, e.clientX),
        top:    Math.min(startY, e.clientY),
        width:  Math.abs(e.clientX - startX),
        height: Math.abs(e.clientY - startY),
      }
      setRbRect(rect)
      if (rect.width < 5 && rect.height < 5) return

      const map = mapRef.current
      if (!map) return
      const mapBounds = mapElRef.current.getBoundingClientRect()
      const inRect = new Set()
      Object.entries(markerMap.current).forEach(([imgId, marker]) => {
        const pt = map.latLngToContainerPoint(marker.getLatLng())
        const ax = pt.x + mapBounds.left
        const ay = pt.y + mapBounds.top
        if (ax >= rect.left && ax <= rect.left + rect.width &&
            ay >= rect.top  && ay <= rect.top  + rect.height) {
          inRect.add(imgId)
        }
      })
      setSelectedIds(inRect)
    }

    const onUp = () => {
      if (rbRef.current) {
        rbRef.current = null
        setRbRect(null)
        mapRef.current?.dragging.enable()
      }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [])

  // ── KML / KMZ upload (KMZ = zipped KML) ───────────────────────────────────
  const onKmlUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      let kmlText
      if (file.name.toLowerCase().endsWith('.kmz')) {
        // KMZ is a ZIP archive — unzip and read the .kml entry inside
        const zip = await JSZip.loadAsync(file)
        const kmlEntry =
          zip.file(/\.kml$/i)[0] ||        // any .kml (usually doc.kml)
          zip.file('doc.kml')
        if (!kmlEntry) { alert('No .kml found inside this KMZ file.'); return }
        kmlText = await kmlEntry.async('string')
      } else {
        kmlText = await file.text()
      }
      const features = parseKML(kmlText)
      setKmlFeatures(features)
      setKmlName(file.name)
    } catch (err) {
      console.error(err)
      alert('Could not read that file. Make sure it is a valid KML or KMZ.')
    }
  }

  // ── render KML on map ─────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    // remove old KML layers
    kmlLayerRef.current.forEach(l => l.remove())
    kmlLayerRef.current = []

    if (!kmlFeatures.length) return

    const bounds = []
    kmlFeatures.forEach(f => {
      let layer = null

      if (f.type === 'point') {
        const icon = L.divIcon({
          className: '',
          html: `<div class="kml-marker" title="${f.name}">
                   <span class="kml-marker-inner">📍</span>
                   ${f.name ? `<span class="kml-marker-label">${f.name}</span>` : ''}
                 </div>`,
          iconSize:    [28, 36],
          iconAnchor:  [14, 36],
          popupAnchor: [0, -36],
        })
        layer = L.marker([f.lat, f.lon], { icon })
        layer.bindPopup(`<b>${f.name || 'Point'}</b>${f.desc ? '<br>' + f.desc : ''}<br>${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}`)
        bounds.push([f.lat, f.lon])
      }

      if (f.type === 'line' && f.coords.length > 1) {
        const lls = f.coords.map(c => [c.lat, c.lon])
        layer = L.polyline(lls, { color: '#ff9500', weight: 3, opacity: 0.85 })
        layer.bindPopup(`<b>${f.name || 'Line'}</b>${f.desc ? '<br>' + f.desc : ''}`)
        lls.forEach(ll => bounds.push(ll))
      }

      if (f.type === 'polygon' && f.coords.length > 2) {
        const lls = f.coords.map(c => [c.lat, c.lon])
        layer = L.polygon(lls, { color: '#ff9500', fillColor: '#ff9500', fillOpacity: 0.1, weight: 2 })
        layer.bindPopup(`<b>${f.name || 'Polygon'}</b>${f.desc ? '<br>' + f.desc : ''}`)
        lls.forEach(ll => bounds.push(ll))
      }

      if (layer) {
        layer.addTo(map)
        kmlLayerRef.current.push(layer)
      }
    })

    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] })
  }, [kmlFeatures])

  // ── add / refresh markers ─────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || loading) return

    Object.values(markerMap.current).forEach(m => m.remove())
    markerMap.current = {}

    const bounds = []
    // iterate in poolImages order so the number on each marker is stable
    poolImages.forEach((img, i) => {
      const c = coords[img.id]
      if (!c) return
      const { lat, lon } = c
      const id  = img.id
      const num = i + 1   // 1-based sequence number shown on the dot

      const isSel  = selectedIds.has(id)
      const color  = isSel ? '#ffd24a' : '#4f8cff'
      const border = isSel ? '3px solid #fff' : '2px solid rgba(255,255,255,0.6)'

      const icon = L.divIcon({
        className: '',
        html: `<div class="map-marker" data-imgid="${id}"
                    style="background:${color};border:${border};z-index:${isSel ? 1000 : 1}">
                 <span class="map-marker-label" style="color:${isSel?'#111':'#fff'}">${num}</span>
               </div>`,
        iconSize:    [28, 28],
        iconAnchor:  [14, 14],
      })

      const marker = L.marker([lat, lon], { icon, riseOnHover: true })
      // hover tooltip (does not block click) instead of a click-popup
      marker.bindTooltip(`#${num} · ${img.name}`, { direction: 'top', offset: [0, -14] })

      // click = select / ctrl+click = multi-select (no popup → clean selection)
      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e)
        const ctrl = e.originalEvent.ctrlKey || e.originalEvent.metaKey
        setSelectedIds(prev => {
          const next = new Set(prev)
          if (ctrl) { next.has(id) ? next.delete(id) : next.add(id) }
          else { next.clear(); next.add(id) }
          return next
        })
      })

      marker.addTo(map)
      markerMap.current[id] = marker
      bounds.push([lat, lon])
    })

    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] })
  }, [coords, loading])

  // ── update marker appearance when selection changes ───────────────────────
  useEffect(() => {
    Object.entries(markerMap.current).forEach(([id, marker]) => {
      const el = marker.getElement()
      if (!el) return
      const dot = el.querySelector('.map-marker')
      const lbl = el.querySelector('.map-marker-label')
      if (!dot) return
      const isSel = selectedIds.has(id)
      dot.style.background  = isSel ? '#ffd24a' : '#4f8cff'
      dot.style.border      = isSel ? '3px solid #fff' : '2px solid rgba(255,255,255,0.6)'
      dot.style.transform   = isSel ? 'scale(1.35)' : 'scale(1)'
      dot.style.zIndex      = isSel ? '1000' : '1'
      if (lbl) lbl.style.color = isSel ? '#111' : '#fff'
    })
  }, [selectedIds])

  // ── recenter map to fit everything (markers + KML) ────────────────────────
  const fitAll = () => {
    const map = mapRef.current
    if (!map) return
    const bounds = []
    Object.values(coords).forEach(({ lat, lon }) => bounds.push([lat, lon]))
    kmlLayerRef.current.forEach(l => {
      if (l.getLatLng) bounds.push(l.getLatLng())
      else if (l.getBounds) { const b = l.getBounds(); bounds.push(b.getNorthEast(), b.getSouthWest()) }
    })
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] })
  }

  const selArr = [...selectedIds]
  const noGps  = poolImages.filter(i => !coords[i.id])

  const kmlPoints   = kmlFeatures.filter(f => f.type === 'point').length
  const kmlLines    = kmlFeatures.filter(f => f.type === 'line').length
  const kmlPolygons = kmlFeatures.filter(f => f.type === 'polygon').length

  return (
    <div className="mapview">

      {/* KML TOOLBAR */}
      <div className="kml-toolbar">
        <label className="kml-upload-btn">
          📂 Upload KML / KMZ
          <input type="file" accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz" hidden onChange={onKmlUpload} />
        </label>
        <button className="kml-fit-btn" onClick={fitAll} title="Recenter map to fit all markers and KML">
          🎯 Fit all
        </button>
        {kmlName && (
          <>
            <span className="kml-file-name">📄 {kmlName}</span>
            <span className="kml-stats">
              {kmlPoints > 0 && <span>📍 {kmlPoints} points</span>}
              {kmlLines > 0  && <span>〰 {kmlLines} lines</span>}
              {kmlPolygons > 0 && <span>⬡ {kmlPolygons} polygons</span>}
            </span>
            <button className="kml-clear-btn"
              onClick={() => { setKmlFeatures([]); setKmlName('') }}>
              ✕ Remove KML
            </button>
          </>
        )}
      </div>

      {/* MAP + PANEL in same flex row */}
      <div className="mapview-map-wrap">

        <div className="mapview-map" ref={mapElRef}>
          {loading && (
            <div className="mapview-loading">
              <div className="mapview-spinner" />
              Reading GPS from {poolImages.length} images…
            </div>
          )}
          {rbRect && rbRect.width > 4 && (
            <div className="rubber-band" style={{
              position: 'fixed',
              left: rbRect.left, top: rbRect.top,
              width: rbRect.width, height: rbRect.height,
            }} />
          )}
        </div>

        {/* SIDE PANEL — inside the row so the map gets remaining height */}
      <div className="mapview-panel">
        <div className="mapview-panel-head">
          🗺 Map Sort
          <button className="mapview-close" onClick={onClose}>✕</button>
        </div>

        <div className="mapview-sel-info">
          {selArr.length > 0
            ? <span className="mapview-sel-count">{selArr.length} selected</span>
            : <span className="mapview-hint-text">
                Click dot to select · Ctrl+click multi · <b>Ctrl+drag</b> to select area
              </span>
          }
        </div>

        {/* bulk move when something is selected */}
        {selArr.length > 0 && (
          <div className="mapview-bulk">
            <div className="mapview-bulk-label">Move {selArr.length} image(s) to tower:</div>
            <div className="mapview-bulk-row">
              {towers.map(t => (
                <button key={t.id} className="mapview-bulk-btn"
                  onClick={() => {
                    selArr.forEach(id => onAssign(id, t.id))
                    setSelectedIds(new Set())
                  }}>
                  {t.id}
                </button>
              ))}
            </div>
            <button className="mapview-clear-btn" onClick={() => setSelectedIds(new Set())}>
              Clear selection
            </button>
          </div>
        )}

        {/* tower list with live counts */}
        <div className="mapview-tower-section-label">Towers</div>
        <div className="mapview-towers">
          {towers.map(t => (
            <div key={t.id} className="mapview-tower">
              <span className="mapview-tower-label">{t.label}</span>
              <span className="mapview-tower-count">
                {allImages.filter(i => i.towerId === t.id).length}
              </span>
            </div>
          ))}
          {towers.length === 0 && <p className="mapview-empty">Create towers first.</p>}
        </div>

        <div className="mapview-legend">
          <div className="mapview-legend-row">
            <span className="mapview-dot" style={{ background: '#4f8cff' }} /> Unsorted
          </div>
          <div className="mapview-legend-row">
            <span className="mapview-dot" style={{ background: '#ffd24a', border: '2px solid #fff' }} /> Selected
          </div>
          {noGps.length > 0 && (
            <div className="mapview-no-gps">{noGps.length} image(s) have no GPS — not shown</div>
          )}
        </div>
      </div>{/* end mapview-panel */}
      </div>{/* end mapview-map-wrap */}
    </div>
  )
}
