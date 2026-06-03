import { useMemo, useState } from 'react'
import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import { TEMPLATES, TEMPLATE_NAMES } from './templates.js'
import Lightbox from './Lightbox.jsx'

let uid = 0
const nextId = () => `img_${uid++}`

export default function App() {
  // --- Top bar state ---
  const [template, setTemplate] = useState(TEMPLATE_NAMES[0])
  const subfolders = TEMPLATES[template]

  const [rangeFrom, setRangeFrom] = useState(1)
  const [rangeTo, setRangeTo] = useState(20)
  const [towers, setTowers] = useState([])

  // --- Image store: single source of truth ---
  // each image: { id, name, url, file, towerId|null, subfolder|null }
  //   towerId === null            -> still in "Folder 1" (unassigned pool)
  //   towerId set, subfolder null -> inside a tower but not yet in a subfolder
  //   towerId set, subfolder set  -> inside a tower's subfolder
  const [images, setImages] = useState([])

  const [selectedTowerId, setSelectedTowerId] = useState(null)
  const [expandedTowerId, setExpandedTowerId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null) // { items, index } shown full-screen
  const [hoverZone, setHoverZone] = useState(null) // drop target currently dragged over

  // ---------- derived ----------
  const poolImages = useMemo(
    () => images.filter((i) => i.towerId === null),
    [images]
  )
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
    const list = []
    for (let n = from; n <= to; n++) {
      list.push({ id: `T${n}`, num: n, label: `Tower ${n}` })
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
    setBusy(true)
    try {
      const zip = new JSZip()
      for (const t of towers) {
        const folder = zip.folder(t.id) // every tower, always
        // remaining images not in any subfolder
        for (const img of imagesByTower(t.id).filter((i) => !i.subfolder)) {
          folder.file(img.name, img.file)
        }
        // always create every subfolder, with a .keep if empty
        for (const sf of subfolders) {
          const inSf = imagesInSubfolder(t.id, sf)
          const sub = folder.folder(sf)
          if (inSf.length === 0) {
            sub.file('.keep', '') // keeps empty subfolder visible after extract
          } else {
            for (const img of inSf) sub.file(img.name, img.file)
          }
        }
        // if the tower itself has no images at all, add a root .keep too
        if (imagesByTower(t.id).length === 0) folder.file('.keep', '')
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      saveAs(blob, `${template.replace(/\s+/g, '_')}_towers.zip`)
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
          <span className="brand-name">
            <span className="brand-aero">Aerio</span><span className="brand-sort">Sort</span>
          </span>
        </div>
        <div className="field">
          <label>Select Template</label>
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            {TEMPLATE_NAMES.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
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
            <label className="upload-btn">
              + Upload folder
              <input
                type="file"
                webkitdirectory=""
                directory=""
                multiple
                hidden
                onChange={onFolderUpload}
              />
            </label>
          </div>
          <p className="hint">{poolImages.length} unsorted image(s)</p>
          <div className="tiles">
            {poolImages.map((img) => (
              <ImageTile
                key={img.id}
                img={img}
                onDragStart={dragStart}
                onOpen={(im) => openPreview(im, poolImages, 'pool')}
              />
            ))}
            {poolImages.length === 0 && (
              <div className="empty">Upload a folder of images to begin.</div>
            )}
          </div>
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

function ImageTile({ img, onDragStart, onOpen, tag }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <div
      className="tile"
      draggable
      onDragStart={(e) => onDragStart(e, img.id)}
      onClick={() => onOpen && onOpen(img)}
      title={img.name}
    >
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
