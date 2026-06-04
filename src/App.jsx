import { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import { TEMPLATES, TEMPLATE_NAMES } from './templates.js'
import Lightbox from './Lightbox.jsx'
import MapView from './MapView.jsx'
import AdminPanel, { loadCustomTemplates } from './AdminPanel.jsx'

let uid = 0
const nextId = () => `img_${uid++}`

export default function App() {
  const [rangeFrom, setRangeFrom] = useState(1)
  const [rangeTo, setRangeTo] = useState(20)
  const [towers, setTowers] = useState([])

  const [images, setImages] = useState([])
  const [selectedTowerId, setSelectedTowerId] = useState(null)
  const [expandedTowerId, setExpandedTowerId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)
  const [showMap,    setShowMap]    = useState(false)
  const [showAdmin,  setShowAdmin]  = useState(false)
  const [customTpls, setCustomTpls] = useState(() => loadCustomTemplates())

  // merge built-in + custom templates (must come before Project which references allTemplateNames)
  const allTemplateNames = [...TEMPLATE_NAMES, ...customTpls.map(t => t.name)]
  const allTemplates = {
    ...TEMPLATES,
    ...Object.fromEntries(customTpls.map(t => [t.name, t.subfolders]))
  }

  // --- Project owns: name, id, template, tower prefix, image naming ---
  // Everything flows from here → the template dropdown in the topbar reflects the project's template
  const slug = (s) => (s || '').trim().replace(/\s+/g, '_').replace(/[^\w-]/g, '')

  const [project, setProject] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('vinyasah_project') || 'null')
      if (saved?.name) return saved
    } catch {}
    return {
      name: 'Untitled Project',
      id: 'PRJ-' + String(Date.now()).slice(-6),
      template: allTemplateNames[0],
    }
  })
  useEffect(() => {
    localStorage.setItem('vinyasah_project', JSON.stringify(project))
  }, [project])

  // template is driven by the project — changing the project template updates everything
  const template = project.template || allTemplateNames[0]
  const setTemplate = (t) => setProject(p => ({ ...p, template: t }))

  const [showProject, setShowProject] = useState(false)
  const projectTag = `${slug(project.name)}_${slug(project.id)}`

  const subfolders = allTemplates[template] || []
  // current template config (for custom templates with extra fields like prefix, rename)
  const currentTplConfig = customTpls.find(t => t.name === template) || null

  const [hoverZone, setHoverZone] = useState(null)

  // ---------- derived (must come before selection which references poolImages) ----------
  const poolImages = useMemo(
    () => images.filter((i) => i.towerId === null),
    [images]
  )

  // --- Folder 1 multi-selection ---
  const [selectedImgIds, setSelectedImgIds] = useState(new Set())
  const lastClickedId = useRef(null)   // store ID (stable), not index
  const gridRef       = useRef(null)   // ref to the tiles grid div
  const rbStart       = useRef(null)   // rubber-band start { x, y } in page coords
  const [rbRect, setRbRect] = useState(null) // visual rect { left,top,width,height }

  // ---------- tile click selection ----------
  const toggleImgSelect = (img, e) => {
    e.preventDefault()
    e.stopPropagation()
    setSelectedImgIds(prev => {
      const next = new Set(prev)
      if (e.shiftKey && lastClickedId.current !== null) {
        // range: find both indices at call time so they're always fresh
        const ids    = poolImages.map(i => i.id)
        const lastI  = ids.indexOf(lastClickedId.current)
        const currI  = ids.indexOf(img.id)
        if (lastI !== -1 && currI !== -1) {
          const from = Math.min(lastI, currI)
          const to   = Math.max(lastI, currI)
          for (let i = from; i <= to; i++) next.add(poolImages[i].id)
          return next
        }
      }
      if (e.ctrlKey || e.metaKey) {
        next.has(img.id) ? next.delete(img.id) : next.add(img.id)
      } else {
        if (next.size === 1 && next.has(img.id)) next.clear()
        else { next.clear(); next.add(img.id) }
      }
      return next
    })
    lastClickedId.current = img.id
  }

  const selectAll     = () => setSelectedImgIds(new Set(poolImages.map(i => i.id)))
  const clearSelection = () => { setSelectedImgIds(new Set()); lastClickedId.current = null }

  // ---------- rubber-band drag selection ----------
  const onGridMouseDown = (e) => {
    if (e.button !== 0) return
    // Ctrl+drag = rubber-band from anywhere (even on top of images)
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      rbStart.current = { x: e.clientX, y: e.clientY }
      return
    }
    // plain drag on empty space (no tile under cursor)
    if (e.target.closest('.tile')) return
    e.preventDefault()
    rbStart.current = { x: e.clientX, y: e.clientY }
    clearSelection()
  }

  // attach move/up to window so rubber-band survives mouse leaving the grid
  useEffect(() => {
    const onMove = (e) => {
      if (!rbStart.current) return
      const { x, y } = rbStart.current
      const rect = {
        left:   Math.min(x, e.clientX),
        top:    Math.min(y, e.clientY),
        width:  Math.abs(e.clientX - x),
        height: Math.abs(e.clientY - y),
      }
      if (rect.width < 4 && rect.height < 4) return   // ignore micro drags
      setRbRect(rect)
      if (!gridRef.current) return
      const newSel = new Set()
      gridRef.current.querySelectorAll('[data-imgid]').forEach(tile => {
        const tr = tile.getBoundingClientRect()
        if (rect.left < tr.right && rect.left + rect.width  > tr.left &&
            rect.top  < tr.bottom && rect.top  + rect.height > tr.top) {
          newSel.add(tile.dataset.imgid)
        }
      })
      setSelectedImgIds(newSel)
    }
    const onUp = () => { rbStart.current = null; setRbRect(null) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [poolImages])

  const moveSelectedToTower = (towerId) => {
    setImages(prev => prev.map(img =>
      selectedImgIds.has(img.id) ? { ...img, towerId, subfolder: null } : img
    ))
    clearSelection()
  }

  // ---------- more derived ----------
  const imagesByTower = (tid) => images.filter((i) => i.towerId === tid)
  const unsortedOfTower = (tid) =>
    images.filter((i) => i.towerId === tid && i.subfolder === null)
  const imagesInSubfolder = (tid, sf) =>
    images.filter((i) => i.towerId === tid && i.subfolder === sf)

  const selectedTower = towers.find((t) => t.id === selectedTowerId) || null

  // open the full-screen viewer; context tells the viewer what sort options to show
  // context: 'pool' | 'tower' | 'subfolder'
  const openPreview = (img, list, context = 'pool', contextTowerId = null) => {
    const idx = list.findIndex((i) => i.id === img.id)
    setPreview({ items: list, index: idx < 0 ? 0 : idx, context, contextTowerId })
  }

  // ---------- actions ----------
  function createTowers() {
    const from = Math.max(1, Math.min(rangeFrom, rangeTo))
    const to = Math.max(rangeFrom, rangeTo)
    const prefix  = (currentTplConfig?.towerPrefix || 'T').trim()
    const zeroPad = currentTplConfig?.zeroPad || false
    const pad = (n) => zeroPad ? String(n).padStart(2, '0') : String(n)
    const list = []
    for (let n = from; n <= to; n++) {
      list.push({ id: `${prefix}${pad(n)}`, num: n, label: `${prefix}${pad(n)}` })
    }
    setTowers(list)
    const validIds = new Set(list.map((t) => t.id))
    // any image assigned to a tower no longer in range goes back to the pool
    setImages((prev) =>
      prev.map((img) =>
        img.towerId && !validIds.has(img.towerId)
          ? { ...img, towerId: null, subfolder: null }
          : img
      )
    )
    if (selectedTowerId && !validIds.has(selectedTowerId)) setSelectedTowerId(null)
  }

  function onFolderUpload(e) {
    const files = Array.from(e.target.files || []).filter((f) =>
      f.type.startsWith('image/')
    )
    const added = files.map((file) => ({
      id: nextId(),
      name: file.name,
      url: URL.createObjectURL(file),
      file,
      towerId: null,
      subfolder: null,
    }))
    setImages((prev) => [...prev, ...added])
    e.target.value = '' // allow re-uploading same folder
  }

  const patch = (id, changes) =>
    setImages((prev) => prev.map((i) => (i.id === id ? { ...i, ...changes } : i)))

  const moveToTower = (id, towerId) => patch(id, { towerId, subfolder: null })
  const moveToPool = (id) => patch(id, { towerId: null, subfolder: null })
  const moveToSubfolder = (id, towerId, subfolder) =>
    patch(id, { towerId, subfolder })
  const moveToTowerRoot = (id, towerId) => patch(id, { towerId, subfolder: null })

  async function exportZip() {
    if (towers.length === 0) {
      alert('Create some towers first.')
      return
    }
    // ── PROJECT ID is the root of everything (no project name) ──
    const pid = slug(project.id)
    const name = window.prompt('Enter ZIP file name:', pid)
    if (name === null) return // user cancelled
    const zipName = (name.trim() || pid) + (name.endsWith('.zip') ? '' : '.zip')
    setBusy(true)
    try {
      const zip = new JSZip()
      const cfg = currentTplConfig  // null for built-in templates
      // tower folder KEY comes from the selected template (e.g. "poll", "T", "Pole")
      const towerKey = cfg?.towerPrefix?.trim() || 'T'
      const zeroPad  = cfg?.zeroPad || false
      const doRename = cfg?.renameImages || false
      const pattern  = (doRename && cfg?.imagePattern)
        ? cfg.imagePattern
        : '{tower}_{subfolder}_{n}'

      // root folder = project ID
      const root = zip.folder(pid)

      // tower folder = projectID_<templateKey><num>   e.g. PRJ-0126_poll1
      const towerFolderName = (t) => {
        const n = zeroPad ? String(t.num).padStart(2, '0') : String(t.num)
        return `${pid}_${towerKey}${n}`
      }
      const ext  = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i) : '' }
      const base = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(0, i) : n }

      const imgName = (img, towerName, sf, idx) => {
        if (!doRename) {
          const part = sf ? slug(sf) : 'unsorted'
          return `${towerName}_${part}_${String(idx + 1).padStart(3, '0')}${ext(img.name)}`
        }
        return pattern
          .replaceAll('{project}',   pid)
          .replaceAll('{tower}',     towerName)
          .replaceAll('{subfolder}', sf ? slug(sf) : 'unsorted')
          .replaceAll('{original}',  base(img.name))
          .replaceAll('{n}',         String(idx + 1).padStart(3, '0'))
          + ext(img.name)
      }

      for (const t of towers) {
        const towerName = towerFolderName(t)
        const folder = root.folder(towerName)
        // unsorted images directly in the tower folder
        const unsorted = imagesByTower(t.id).filter(i => !i.subfolder)
        unsorted.forEach((img, idx) => folder.file(imgName(img, towerName, null, idx), img.file))
        // subfolders use the template's subfolder key names
        for (const sf of subfolders) {
          const inSf = imagesInSubfolder(t.id, sf)
          const subName = `${towerName}_${slug(sf)}`
          const sub  = folder.folder(subName)
          if (inSf.length === 0) sub.file('.keep', '')
          else inSf.forEach((img, idx) => sub.file(imgName(img, towerName, sf, idx), img.file))
        }
        if (imagesByTower(t.id).length === 0) folder.file('.keep', '')
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      saveAs(blob, zipName)
    } finally {
      setBusy(false)
    }
  }

  // ---------- drag & drop helpers ----------
  const dragStart = (e, id) => e.dataTransfer.setData('text/plain', id)
  const getDragId = (e) => e.dataTransfer.getData('text/plain')
  // props that make an element a highlightable drop zone
  const zone = (key) => ({
    onDragOver: (e) => {
      e.preventDefault()
      if (hoverZone !== key) setHoverZone(key)
    },
    onDragLeave: () => setHoverZone((z) => (z === key ? null : z)),
  })
  const over = (key) => (hoverZone === key ? ' dragover' : '')
  const endDrag = () => setHoverZone(null)

  return (
    <div className="app">
      {/* ============ TOP BAR ============ */}
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.png" alt="" className="brand-favicon" />
          <span className="brand-name">
            <span className="brand-aero">विन्या</span><span className="brand-sort">स:</span>
          </span>
        </div>

        <button className="project-btn" onClick={() => setShowProject(true)} title="Project settings">
          <span className="project-btn-icon">📁</span>
          <span className="project-btn-text">
            <span className="project-btn-name">{project.name}</span>
            <span className="project-btn-id">{project.id}</span>
          </span>
        </button>

        <div className="tpl-pill" title="Template set in Project settings — click 📁 to change">
          <span className="tpl-pill-label">Template</span>
          <span className="tpl-pill-name">{template}</span>
        </div>

        <div className="field">
          <label>Towers</label>
          <input
            type="number"
            min={1}
            value={rangeFrom}
            onChange={(e) => setRangeFrom(Number(e.target.value))}
          />
          <span>to</span>
          <input
            type="number"
            min={1}
            value={rangeTo}
            onChange={(e) => setRangeTo(Number(e.target.value))}
          />
          <button
            className={'primary' + (towers.length === 0 ? ' pulse-border' : '')}
            onClick={createTowers}
          >
            Create
          </button>
        </div>

        <div className="spacer" />

        <button className="admin-open-btn" onClick={() => setShowAdmin(true)} title="Template Manager">
          ⚙ Templates
        </button>
        <button className="export" disabled={busy} onClick={exportZip}>
          {busy ? 'Zipping…' : '⬇ Export ZIP'}
        </button>
      </header>

      {/* ============ THREE COLUMNS ============ */}
      <main className="columns" onDragEnd={endDrag}>
        {/* ---------- COLUMN 1 : FOLDER 1 ---------- */}
        <section
          className={'col' + over('pool')}
          {...zone('pool')}
          onDrop={(e) => {
            e.preventDefault()
            endDrag()
            moveToPool(getDragId(e))
          }}
        >
          <div className="col-head">
            <h2>Folder 1</h2>
            <div style={{ display: 'flex', gap: 8 }}>
              {poolImages.length > 0 && (
                <button className="map-btn" onClick={() => setShowMap(true)} title="View images on map">
                  🗺 Map
                </button>
              )}
              <label className="upload-btn">
                + Upload folder
                <input type="file" webkitdirectory="" directory="" multiple hidden onChange={onFolderUpload} />
              </label>
            </div>
          </div>

          {/* selection toolbar */}
          {poolImages.length > 0 && (
            <div className="sel-toolbar">
              <span className="sel-count">
                {selectedImgIds.size > 0
                  ? `${selectedImgIds.size} selected`
                  : `${poolImages.length} image(s) · Ctrl+drag to select`}
              </span>
              <button className="sel-btn" onClick={selectAll}>Select All</button>
              {selectedImgIds.size > 0 && (
                <button className="sel-btn danger" onClick={clearSelection}>Clear</button>
              )}
            </div>
          )}

          <div
            className="tiles pool-grid"
            ref={gridRef}
            onMouseDown={onGridMouseDown}
          >
            {poolImages.map((img) => (
              <ImageTile
                key={img.id}
                img={img}
                selected={selectedImgIds.has(img.id)}
                onSelect={(e) => toggleImgSelect(img, e)}
                onDragStart={dragStart}
                onOpen={(im) => openPreview(im, poolImages, 'pool')}
              />
            ))}
            {poolImages.length === 0 && (
              <div className="empty">Upload a folder of images to begin.</div>
            )}
          </div>

          {/* rubber-band selection rectangle (fixed, over whole page) */}
          {rbRect && (
            <div className="rubber-band" style={{
              left: rbRect.left, top: rbRect.top,
              width: rbRect.width, height: rbRect.height,
            }} />
          )}

          {/* sticky move bar */}
          {selectedImgIds.size > 0 && (
            <div className="move-bar">
              <span className="move-bar-label">Move {selectedImgIds.size} image(s) to:</span>
              <div className="move-bar-towers">
                {towers.map(t => (
                  <button key={t.id} className="move-bar-btn" onClick={() => moveSelectedToTower(t.id)}>
                    {t.id}
                  </button>
                ))}
                {towers.length === 0 && <span className="move-bar-none">Create towers first</span>}
              </div>
            </div>
          )}
        </section>

        {/* ---------- COLUMN 2 : TOWERS ---------- */}
        <section className="col">
          <div className="col-head">
            <h2>Towers</h2>
            <span className="count">{towers.length}</span>
          </div>
          <p className="hint">Drag images here from Folder 1</p>
          <div className="tower-list">
            {towers.map((t) => {
              const imgs = imagesByTower(t.id)
              const isSel = t.id === selectedTowerId
              const isOpen = t.id === expandedTowerId
              return (
                <div
                  key={t.id}
                  className={`tower ${isSel ? 'sel' : ''}` + over(t.id)}
                  {...zone(t.id)}
                  onDrop={(e) => {
                    e.preventDefault()
                    endDrag()
                    moveToTower(getDragId(e), t.id)
                  }}
                >
                  <div className="tower-row">
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => {
                        const next = isSel ? null : t.id
                        setSelectedTowerId(next)
                        if (next) setExpandedTowerId(next)
                      }}
                    />
                    <button
                      className="tower-name"
                      onClick={() => {
                        setSelectedTowerId(t.id)
                        setExpandedTowerId(isOpen ? null : t.id)
                      }}
                    >
                      {t.label}
                    </button>
                    <span className="badge">{imgs.length}</span>
                    {imgs.length > 0 && (
                      <button
                        className="chev"
                        onClick={() => {
                          const next = isOpen ? null : t.id
                          setExpandedTowerId(next)
                          if (next) setSelectedTowerId(next)
                        }}
                      >
                        {isOpen ? '▾' : '▸'}
                      </button>
                    )}
                  </div>
                  {isOpen && (
                    <>
                      <div className="tiles small">
                        {imgs.map((img) => (
                          <ImageTile
                            key={img.id}
                            img={img}
                            onDragStart={dragStart}
                            onOpen={(im) => openPreview(im, imgs, 'tower', t.id)}
                            tag={img.subfolder || 'unsorted'}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
            {towers.length === 0 && (
              <div className="empty">Set a range and click “Create”.</div>
            )}
          </div>
        </section>

        {/* ---------- COLUMN 3 : SUB FOLDERS ---------- */}
        <section className="col">
          <div className="col-head">
            <h2>Sub folders</h2>
            {selectedTower && <span className="count">{selectedTower.id}</span>}
          </div>

          {!selectedTower ? (
            <div className="empty">Select a tower to sort its images.</div>
          ) : (
            <>
              {/* remaining (unsorted) images of the selected tower */}
              <div
                className={'remaining' + over('remaining')}
                {...zone('remaining')}
                onDrop={(e) => {
                  e.preventDefault()
                  endDrag()
                  moveToTowerRoot(getDragId(e), selectedTower.id)
                }}
              >
                <div className="sub-title">
                  Remaining in {selectedTower.label}
                  <span className="badge">
                    {unsortedOfTower(selectedTower.id).length}
                  </span>
                </div>
                <div className="tiles small">
                  {unsortedOfTower(selectedTower.id).map((img, _, arr) => (
                    <ImageTile
                      key={img.id}
                      img={img}
                      onDragStart={dragStart}
                      onOpen={(im) => openPreview(im, arr, 'tower', selectedTower.id)}
                    />
                  ))}
                  {unsortedOfTower(selectedTower.id).length === 0 && (
                    <div className="empty tiny">All images sorted 🎉</div>
                  )}
                </div>
              </div>

              {/* the template's subfolders */}
              {subfolders.map((sf) => {
                const inSf = imagesInSubfolder(selectedTower.id, sf)
                return (
                  <div
                    key={sf}
                    className={'subfolder' + over('sf:' + sf)}
                    {...zone('sf:' + sf)}
                    onDrop={(e) => {
                      e.preventDefault()
                      endDrag()
                      moveToSubfolder(getDragId(e), selectedTower.id, sf)
                    }}
                  >
                    <div className="sub-title">
                      <input type="checkbox" checked={inSf.length > 0} readOnly />
                      {sf}
                      <span className="badge">{inSf.length}</span>
                    </div>
                    <div className="tiles small">
                      {inSf.map((img) => (
                        <ImageTile
                          key={img.id}
                          img={img}
                          onDragStart={dragStart}
                          onOpen={(im) => openPreview(im, inSf, 'subfolder', selectedTower.id)}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </section>
      </main>

      {/* ============ PROJECT MODAL ============ */}
      {showProject && (
        <ProjectModal
          project={project}
          allTemplateNames={allTemplateNames}
          allTemplates={allTemplates}
          customTpls={customTpls}
          onSave={(p) => { setProject(p); setShowProject(false) }}
          onClose={() => setShowProject(false)}
        />
      )}

      {/* ============ ADMIN PANEL ============ */}
      {showAdmin && (
        <AdminPanel
          onClose={() => setShowAdmin(false)}
          customTemplates={customTpls}
          setCustomTemplates={(next) => {
            setCustomTpls(next)
            // if current template was deleted, fall back to the first remaining one
            if (!next.find(t => t.name === template) && !TEMPLATE_NAMES.includes(template))
              setTemplate(next[0]?.name || TEMPLATE_NAMES[0])
          }}
        />
      )}

      {/* ============ MAP VIEW ============ */}
      {showMap && (
        <MapView
          allImages={images}
          towers={towers}
          onAssign={(imgId, towerId) => moveToTower(imgId, towerId)}
          onClose={() => setShowMap(false)}
        />
      )}

      {/* ============ FULL-SCREEN PREVIEW ============ */}
      {preview && (
        <Lightbox
          items={preview.items}
          index={preview.index}
          onIndex={(i) => setPreview((p) => ({ ...p, index: i }))}
          onClose={() => setPreview(null)}
          towers={towers}
          subfolders={subfolders}
          context={preview.context}
          contextTowerId={preview.contextTowerId}
          onAssign={(imageId, towerId, sf) =>
            sf ? moveToSubfolder(imageId, towerId, sf) : moveToTower(imageId, towerId)
          }
          onMoveToPool={(imageId) => moveToPool(imageId)}
        />
      )}
    </div>
  )
}

function ProjectModal({ project, allTemplateNames, allTemplates, customTpls, onSave, onClose }) {
  const [name,     setName]     = useState(project.name)
  const [id,       setId]       = useState(project.id)
  const [tplName,  setTplName]  = useState(project.template || allTemplateNames[0])
  const slug = (s) => (s || '').trim().replace(/\s+/g, '_').replace(/[^\w-]/g, '')
  const pid = slug(id) || 'PRJ-ID'
  const tplSubs = allTemplates[tplName] || []
  const tplCfg  = customTpls.find(t => t.name === tplName)
  const towerKey = tplCfg?.towerPrefix?.trim() || 'T'   // template's tower key
  const towerEx = `${pid}_${towerKey}1`

  // build a live preview: project ID → tower (template key) → subfolders
  const previewLines = [
    `${pid}.zip`,
    `└─ ${pid}/`,
    `   └─ ${towerEx}/`,
    `      ├─ ${towerEx}_unsorted_001.jpg`,
    ...tplSubs.flatMap((sf, i) => [
      `      ${i < tplSubs.length - 1 ? '├' : '└'}─ ${towerEx}_${slug(sf)}/`,
      `         └─ ${towerEx}_${slug(sf)}_001.jpg`,
    ]),
  ].join('\n')

  return (
    <div className="admin-overlay" onClick={onClose}>
      <div className="admin-modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="admin-header">
          <span>📁 Project Settings</span>
          <button className="admin-close" onClick={onClose}>✕</button>
        </div>
        <div className="admin-body">
          <div className="admin-row">
            <div className="admin-field half">
              <label>Project Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Hubli 220kV Line" autoFocus />
            </div>
            <div className="admin-field half">
              <label>Project ID</label>
              <input value={id} onChange={(e) => setId(e.target.value)}
                placeholder="e.g. PRJ-001" />
            </div>
          </div>

          <div className="admin-field">
            <label>Template (subfolders structure)</label>
            <select className="admin-select" value={tplName}
              onChange={(e) => setTplName(e.target.value)}>
              {allTemplateNames.map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Tower key: <b style={{ color: '#7ab3ff' }}>{towerKey}</b>
              {towerKey === 'T' && !tplCfg && ' (built-in default — create a custom template to change it)'}
              {' · '}Subfolders: {tplSubs.join(' → ') || '(none)'}
            </div>
          </div>

          <div className="admin-group">
            <div className="admin-group-title">Live export structure — everything connected through Project</div>
            <pre className="project-preview">{previewLines}</pre>
          </div>

          <div className="admin-actions">
            <button className="admin-btn cancel" onClick={onClose}>Cancel</button>
            <button className="admin-btn save" onClick={() => onSave({
              name: name.trim() || 'Untitled Project',
              id:   id.trim()   || project.id,
              template: tplName,
            })}>
              💾 Save Project
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ImageTile({ img, onDragStart, onOpen, onSelect, selected, tag }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <div
      className={'tile' + (selected ? ' tile-selected' : '')}
      data-imgid={img.id}
      draggable
      onDragStart={(e) => onDragStart(e, img.id)}
      onClick={(e) => {
        if (onSelect) onSelect(e)
        else if (onOpen) onOpen(img)
      }}
      onDoubleClick={() => onOpen && onOpen(img)}
      title={img.name}
    >
      {selected && <div className="tile-check">✓</div>}
      {!loaded && <div className="tile-skel" />}
      <img
        src={img.url}
        alt={img.name}
        loading="lazy"
        decoding="async"
        className={loaded ? 'in' : ''}
        onLoad={() => setLoaded(true)}
      />
      {tag && <span className="tile-tag">{tag}</span>}
      <span className="tile-name">{img.name}</span>
    </div>
  )
}
