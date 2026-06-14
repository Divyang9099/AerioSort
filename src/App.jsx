import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import { TEMPLATES, TEMPLATE_NAMES } from './templates.js'
import Lightbox from './Lightbox.jsx'
import MapView from './MapView.jsx'
import AdminPanel, { loadCustomTemplates } from './AdminPanel.jsx'
import { saveFiles, loadAllFiles, clearFiles } from './db.js'

let uid = 0
const nextId = () => `img_${uid++}`
// keep the counter ahead of any restored ids so new uploads never collide
const bumpUid = (id) => {
  const n = Number(String(id).replace('img_', ''))
  if (Number.isFinite(n) && n >= uid) uid = n + 1
}

// Scroll container context — lets ImageTile use the column as IntersectionObserver root
const ScrollRootCtx = createContext(null)

export default function App() {
  const [rangeFrom, setRangeFrom] = useState(1)
  const [rangeTo, setRangeTo] = useState(20)
  const [towers, setTowers] = useState([])

  const SESSION_KEY = 'vinyasah_session'
  const [sessionLoaded, setSessionLoaded] = useState(false)

  const [images, setImages] = useState([])
  const [selectedTowerId, setSelectedTowerId] = useState(null)
  const [expandedTowerId, setExpandedTowerId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)
  const [uploadProgress, setUploadProgress] = useState(null)
  const poolColRef = useRef(null)

  // --- resizable columns: fractions for [Folder1, Towers, Sub folders] ---
  const COLS_KEY = 'vinyasah_col_widths'
  const [colFr, setColFr] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY) || 'null')
      if (Array.isArray(saved) && saved.length === 3 && saved.every(n => n > 0)) return saved
    } catch {}
    return [1, 1, 1]
  })
  const columnsRef = useRef(null)
  const resizeRef = useRef(null) // { handle, startX, startFr }

  const startColResize = (handle) => (e) => {
    e.preventDefault()
    resizeRef.current = { handle, startX: e.clientX, startFr: [...colFr] }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  useEffect(() => {
    const onMove = (e) => {
      const r = resizeRef.current
      if (!r || !columnsRef.current) return
      const totalFr = r.startFr.reduce((a, b) => a + b, 0)
      const contentW = columnsRef.current.clientWidth - 12 // minus the two 6px handles
      const pxPerFr = contentW / totalFr
      const dFr = (e.clientX - r.startX) / pxPerFr
      const i = r.handle // 0 = between col1/col2, 1 = between col2/col3
      const next = [...r.startFr]
      const MIN = 0.25
      next[i] = Math.max(MIN, r.startFr[i] + dFr)
      next[i + 1] = Math.max(MIN, r.startFr[i + 1] - dFr)
      setColFr(next)
    }
    const onUp = () => {
      if (!resizeRef.current) return
      resizeRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setColFr(curr => { localStorage.setItem(COLS_KEY, JSON.stringify(curr)); return curr })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])
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

  // ── restore session from IndexedDB + localStorage on first load ───────────
  useEffect(() => {
    async function restore() {
      try {
        const meta = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')
        if (!meta) { setSessionLoaded(true); return }

        if (meta.rangeFrom != null) setRangeFrom(meta.rangeFrom)
        if (meta.rangeTo   != null) setRangeTo(meta.rangeTo)
        if (meta.towers?.length)    setTowers(meta.towers)

        if (meta.imageMeta?.length) {
          const fileEntries = await loadAllFiles()
          const fileMap = Object.fromEntries(fileEntries.map(e => [e.id, e.file]))
          const restored = meta.imageMeta
            .filter(m => fileMap[m.id])
            .map(m => {
              bumpUid(m.id) // keep nextId() ahead of restored ids
              return {
                ...m,
                file: fileMap[m.id],
                url:  URL.createObjectURL(fileMap[m.id]),
              }
            })
          if (restored.length) setImages(restored)
        }
      } catch (err) {
        console.error('Session restore failed:', err)
      }
      setSessionLoaded(true)
    }
    restore()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── auto-save session whenever anything meaningful changes ────────────────
  useEffect(() => {
    if (!sessionLoaded) return          // don't overwrite with empty state during restore
    const meta = {
      imageMeta: images.map(({ id, name, towerId, subfolder }) => ({ id, name, towerId, subfolder })),
      towers,
      rangeFrom,
      rangeTo,
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(meta))
  }, [images, towers, rangeFrom, rangeTo, sessionLoaded])

  // ── clear entire session (files + metadata) ───────────────────────────────
  const clearSession = async () => {
    if (!window.confirm('Clear all images and tower assignments? This cannot be undone.')) return
    try { await clearFiles() } catch {}
    localStorage.removeItem(SESSION_KEY)
    images.forEach(img => { try { URL.revokeObjectURL(img.url) } catch {} })
    setImages([])
    setTowers([])
    setRangeFrom(1)
    setRangeTo(20)
    setSelectedTowerId(null)
    setExpandedTowerId(null)
    setSelectedImgIds(new Set())
    lastClickedId.current = null
  }

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
  const lastClickedId   = useRef(null)
  const gridRef         = useRef(null)
  const rbStart         = useRef(null)
  const [rbRect, setRbRect] = useState(null)
  // Ref so toggleImgSelect useCallback needs no deps on poolImages
  const poolImagesRef = useRef([])

  // --- Key folder (tower expanded, col 2) multi-selection ---
  const [keySelIds, setKeySelIds] = useState(new Set())
  const keyLastClickedId = useRef(null)
  // Ref updated each render with the currently-expanded tower's image list
  const keyImgListRef = useRef([])

  // --- Subfolder column (col 3) multi-selection ---
  const [sfSelIds, setSfSelIds] = useState(new Set())
  const sfLastClickedId = useRef(null)
  // Ref updated each render with the last-clicked sf section's list
  const sfImgListRef = useRef([])

  // ── stable selection handlers (useCallback + refs → no re-creates on each render) ──

  const toggleImgSelect = useCallback((img, e) => {
    e.preventDefault()
    e.stopPropagation()
    setSelectedImgIds(prev => {
      const next = new Set(prev)
      if (e.shiftKey && lastClickedId.current !== null) {
        const list  = poolImagesRef.current
        const ids   = list.map(i => i.id)
        const lastI = ids.indexOf(lastClickedId.current)
        const currI = ids.indexOf(img.id)
        if (lastI !== -1 && currI !== -1) {
          const from = Math.min(lastI, currI)
          const to   = Math.max(lastI, currI)
          for (let k = from; k <= to; k++) next.add(list[k].id)
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
  }, [])

  const toggleKeyImgSelect = useCallback((img, e) => {
    e.preventDefault()
    e.stopPropagation()
    setKeySelIds(prev => {
      const next = new Set(prev)
      if (e.shiftKey && keyLastClickedId.current !== null) {
        const list  = keyImgListRef.current
        const ids   = list.map(i => i.id)
        const lastI = ids.indexOf(keyLastClickedId.current)
        const currI = ids.indexOf(img.id)
        if (lastI !== -1 && currI !== -1) {
          const from = Math.min(lastI, currI)
          const to   = Math.max(lastI, currI)
          for (let k = from; k <= to; k++) next.add(list[k].id)
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
    keyLastClickedId.current = img.id
  }, [])

  const toggleSfImgSelect = useCallback((img, e) => {
    e.preventDefault()
    e.stopPropagation()
    setSfSelIds(prev => {
      const next = new Set(prev)
      if (e.shiftKey && sfLastClickedId.current !== null) {
        const list  = sfImgListRef.current
        const ids   = list.map(i => i.id)
        const lastI = ids.indexOf(sfLastClickedId.current)
        const currI = ids.indexOf(img.id)
        if (lastI !== -1 && currI !== -1) {
          const from = Math.min(lastI, currI)
          const to   = Math.max(lastI, currI)
          for (let k = from; k <= to; k++) next.add(list[k].id)
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
    sfLastClickedId.current = img.id
  }, [])

  const clearKeySelection = useCallback(() => { setKeySelIds(new Set()); keyLastClickedId.current = null }, [])
  const clearSfSelection  = useCallback(() => { setSfSelIds(new Set());  sfLastClickedId.current  = null }, [])

  // Clear selections when context changes
  useEffect(() => { clearKeySelection() }, [expandedTowerId, clearKeySelection])
  useEffect(() => { clearSfSelection()  }, [selectedTowerId, clearSfSelection])

  // Move sf-selected images to a subfolder (or tower root)
  const moveSfSelectedToSubfolder = (sf) => {
    setImages(prev => prev.map(img =>
      sfSelIds.has(img.id)
        ? { ...img, towerId: selectedTower.id, subfolder: sf }
        : img
    ))
    clearSfSelection()
  }

  // ---------- tile click selection ----------
  // (toggleImgSelect is defined above as useCallback)

  const selectAll     = () => setSelectedImgIds(new Set(poolImagesRef.current.map(i => i.id)))
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

  // Stable (no-dep) open handler for pool tiles — reads the live list from a ref
  // so the reference never changes and ImageTile's memo holds across selection clicks.
  const openPoolPreview = useCallback((im) => {
    const list = poolImagesRef.current
    const idx = list.findIndex((i) => i.id === im.id)
    setPreview({ items: list, index: idx < 0 ? 0 : idx, context: 'pool', contextTowerId: null })
  }, [])

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
    if (files.length === 0) { e.target.value = ''; return }

    setUploadProgress({ total: files.length, done: 0 })
    const CHUNK = 30
    let idx = 0
    const allChunks = []

    function step() {
      const slice = files.slice(idx, idx + CHUNK)
      const chunk = slice.map((file) => ({
        id: nextId(),
        name: file.name,
        url: URL.createObjectURL(file),
        file,
        towerId: null,
        subfolder: null,
      }))
      allChunks.push(...chunk)
      idx += slice.length
      setImages((prev) => [...prev, ...chunk])
      setUploadProgress({ total: files.length, done: idx })
      if (idx < files.length) {
        requestAnimationFrame(step)
      } else {
        setTimeout(() => setUploadProgress(null), 600)
        // persist files to IndexedDB so session survives page reload
        saveFiles(allChunks.map(({ id, file }) => ({ id, file }))).catch(console.error)
      }
    }

    requestAnimationFrame(step)
    e.target.value = ''
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
    const canStream = typeof window.showSaveFilePicker === 'function'
    // On Chromium the native Save dialog asks for the name, so skip the prompt.
    let zipName = pid + '.zip'
    if (!canStream) {
      const name = window.prompt('Enter ZIP file name:', pid)
      if (name === null) return // user cancelled
      zipName = (name.trim() || pid) + (name.endsWith('.zip') ? '' : '.zip')
    }
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
        // "Keep original filenames" → use the real file name, unchanged
        if (!doRename) return img.name
        return pattern
          .replaceAll('{project}',   pid)
          .replaceAll('{tower}',     towerName)
          .replaceAll('{subfolder}', sf ? slug(sf) : 'unsorted')
          .replaceAll('{original}',  base(img.name))
          .replaceAll('{n}',         String(idx + 1).padStart(3, '0'))
          + ext(img.name)
      }

      // ensure no two files in the same folder collide (e.g. duplicate originals)
      const uniqueName = (usedSet, name) => {
        if (!usedSet.has(name)) { usedSet.add(name); return name }
        const b = base(name), e = ext(name)
        let n = 2
        while (usedSet.has(`${b}_${n}${e}`)) n++
        const finalName = `${b}_${n}${e}`
        usedSet.add(finalName)
        return finalName
      }

      // a File/Blob is required to add an image to the zip
      const hasFile = (img) => img.file instanceof Blob && img.file.size > 0
      let added = 0
      let missing = 0

      for (const t of towers) {
        // skip towers with no images at all — no empty folder in the zip
        if (imagesByTower(t.id).length === 0) continue
        const towerName = towerFolderName(t)
        const folder = root.folder(towerName)
        // unsorted images directly in the tower folder
        const unsorted = imagesByTower(t.id).filter(i => !i.subfolder)
        const folderUsed = new Set()
        unsorted.forEach((img, idx) => {
          if (!hasFile(img)) { missing++; return }
          folder.file(uniqueName(folderUsed, imgName(img, towerName, null, idx)), img.file); added++
        })
        // subfolders use the template's subfolder key names — only create non-empty ones
        for (const sf of subfolders) {
          const inSf = imagesInSubfolder(t.id, sf)
          if (inSf.length === 0) continue
          const subName = `${towerName}_${slug(sf)}`
          const sub  = folder.folder(subName)
          const subUsed = new Set()
          inSf.forEach((img, idx) => {
            if (!hasFile(img)) { missing++; return }
            sub.file(uniqueName(subUsed, imgName(img, towerName, sf, idx)), img.file); added++
          })
        }
      }

      if (added === 0) {
        alert(
          missing > 0
            ? `Export failed: none of the ${missing} assigned image(s) have a usable file.\n\nThis usually happens after reloading the page if the images were not re-saved. Re-upload the folder and try again.`
            : 'Nothing to export. Assign some images to towers first.'
        )
        return
      }

      // STORE = no compression. Drone JPEGs are already compressed, so deflating
      // them wastes CPU/memory and is what blows up the array-buffer allocation.
      const genOpts = { compression: 'STORE', streamFiles: true }

      if (canStream) {
        // ── stream the zip straight to disk → constant memory, no size ceiling ──
        let handle
        try {
          handle = await window.showSaveFilePicker({
            suggestedName: zipName,
            types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
          })
        } catch (e) {
          if (e?.name === 'AbortError') return // user cancelled the save dialog
          throw e
        }
        const writable = await handle.createWritable()
        try {
          await new Promise((resolve, reject) => {
            const stream = zip.generateInternalStream({ type: 'uint8array', ...genOpts })
            stream.on('data', (chunk) => {
              // backpressure: pause JSZip while the disk write is in flight
              stream.pause()
              writable.write(chunk).then(() => stream.resume(), reject)
            })
            stream.on('error', reject)
            stream.on('end', resolve)
            stream.resume()
          })
        } finally {
          await writable.close()
        }
      } else {
        // ── fallback (Firefox/Safari): build one blob in memory ──
        const blob = await zip.generateAsync({ type: 'blob', ...genOpts })
        saveAs(blob, zipName)
      }

      if (missing > 0) {
        alert(`Exported ${added} image(s). ${missing} image(s) were skipped because their file could not be read (try re-uploading those).`)
      }
    } catch (err) {
      console.error('Export failed:', err)
      const msg = String(err?.message || err)
      if (/allocation failed|out of memory|maximum call stack/i.test(msg)) {
        alert('Export failed: ran out of memory building the ZIP.\n\nTry exporting fewer towers at a time, or use a Chromium browser (Chrome/Edge) which streams the ZIP to disk.')
      } else {
        alert('Export failed: ' + msg)
      }
    } finally {
      setBusy(false)
    }
  }

  // ---------- drag & drop helpers ----------
  const dragStart = useCallback((e, id) => e.dataTransfer.setData('text/plain', id), [])
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

        <button className="clear-session-btn" onClick={clearSession}
          title="Delete all images and assignments from this session"
          disabled={images.length === 0 && towers.length === 0}>
          🗑 Clear
        </button>
        <button className="admin-open-btn" onClick={() => setShowAdmin(true)} title="Template Manager">
          ⚙ Templates
        </button>
        <button className="export" disabled={busy} onClick={exportZip}>
          {busy ? 'Zipping…' : '⬇ Export ZIP'}
        </button>
      </header>

      {/* ============ THREE COLUMNS ============ */}
      <main
        className="columns"
        ref={columnsRef}
        onDragEnd={endDrag}
        style={{ gridTemplateColumns: `${colFr[0]}fr 6px ${colFr[1]}fr 6px ${colFr[2]}fr` }}
      >
        {/* ---------- COLUMN 1 : FOLDER 1 ---------- */}
        <section
          ref={poolColRef}
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

          {/* upload progress bar */}
          {uploadProgress && (
            <div className="upload-progress">
              <div className="upload-progress-text">
                Loading images… {uploadProgress.done} / {uploadProgress.total}
              </div>
              <div className="upload-progress-track">
                <div
                  className="upload-progress-fill"
                  style={{ width: `${(uploadProgress.done / uploadProgress.total) * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* selection toolbar */}
          {poolImages.length > 0 && !uploadProgress && (
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
            <ScrollRootCtx.Provider value={poolColRef}>
              {/* update ref before rendering so shift-select always has fresh list */}
              {(poolImagesRef.current = poolImages, null)}
              {poolImages.map((img) => (
                <ImageTile
                  key={img.id}
                  img={img}
                  selected={selectedImgIds.has(img.id)}
                  onSelect={toggleImgSelect}
                  onDragStart={dragStart}
                  onOpen={openPoolPreview}
                />
              ))}
            </ScrollRootCtx.Provider>
            {poolImages.length === 0 && !uploadProgress && (
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

        {/* resize handle between Folder 1 and Towers */}
        <div className="col-resizer" onMouseDown={startColResize(0)} title="Drag to resize" />

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
                      {/* key-folder selection toolbar */}
                      {imgs.length > 0 && (
                        <div className="sel-toolbar" style={{ marginTop: 6 }}>
                          <span className="sel-count">
                            {keySelIds.size > 0
                              ? `${keySelIds.size} selected`
                              : `${imgs.length} image(s) · Ctrl+click`}
                          </span>
                          <button className="sel-btn" onClick={() => setKeySelIds(new Set(imgs.map(i => i.id)))}>
                            Select All
                          </button>
                          {keySelIds.size > 0 && (
                            <button className="sel-btn danger" onClick={clearKeySelection}>Clear</button>
                          )}
                        </div>
                      )}
                      <div className="tiles small key-grid">
                        {/* update ref before rendering for shift-select */}
                        {(keyImgListRef.current = imgs, null)}
                        {imgs.map((img) => (
                          <ImageTile
                            key={img.id}
                            img={img}
                            selected={keySelIds.has(img.id)}
                            onSelect={toggleKeyImgSelect}
                            onDragStart={dragStart}
                            onOpen={(im) => openPreview(im, imgs, 'tower', t.id)}
                            tag={img.subfolder || 'unsorted'}
                          />
                        ))}
                      </div>
                      {/* sticky move bar for key-folder selection */}
                      {keySelIds.size > 0 && (
                        <div className="move-bar" style={{ marginTop: 4 }}>
                          <span className="move-bar-label">Move {keySelIds.size} image(s) to subfolder:</span>
                          <div className="move-bar-towers">
                            <button
                              className="move-bar-btn"
                              onClick={() => {
                                setImages(prev => prev.map(img =>
                                  keySelIds.has(img.id) ? { ...img, towerId: t.id, subfolder: null } : img
                                ))
                                clearKeySelection()
                              }}
                            >
                              Unsorted
                            </button>
                            {subfolders.map(sf => (
                              <button
                                key={sf}
                                className="move-bar-btn"
                                onClick={() => {
                                  setImages(prev => prev.map(img =>
                                    keySelIds.has(img.id) ? { ...img, towerId: t.id, subfolder: sf } : img
                                  ))
                                  clearKeySelection()
                                }}
                              >
                                {sf}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
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

        {/* resize handle between Towers and Sub folders */}
        <div className="col-resizer" onMouseDown={startColResize(1)} title="Drag to resize" />

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
              {(() => {
                const unsorted = unsortedOfTower(selectedTower.id)
                const allSfImgs = [...unsorted, ...subfolders.flatMap(sf => imagesInSubfolder(selectedTower.id, sf))]
                return (
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
                      <span className="badge">{unsorted.length}</span>
                      {unsorted.length > 0 && (
                        <>
                          <button className="sel-btn" style={{ marginLeft: 'auto', fontSize: 11 }}
                            onClick={() => setSfSelIds(new Set(unsorted.map(i => i.id)))}>
                            Select All
                          </button>
                        </>
                      )}
                    </div>
                    {unsorted.length > 0 && sfSelIds.size > 0 && unsorted.some(i => sfSelIds.has(i.id)) && (
                      <div className="sel-toolbar" style={{ marginBottom: 4 }}>
                        <span className="sel-count">
                          {unsorted.filter(i => sfSelIds.has(i.id)).length} selected
                        </span>
                        <button className="sel-btn danger" onClick={clearSfSelection}>Clear</button>
                      </div>
                    )}
                    <div className="tiles small">
                      {/* update ref so shift-select works within this section */}
                      {(sfImgListRef.current = unsorted, null)}
                      {unsorted.map((img) => (
                        <ImageTile
                          key={img.id}
                          img={img}
                          selected={sfSelIds.has(img.id)}
                          onSelect={toggleSfImgSelect}
                          onDragStart={dragStart}
                          onOpen={(im) => openPreview(im, unsorted, 'tower', selectedTower.id)}
                        />
                      ))}
                      {unsorted.length === 0 && (
                        <div className="empty tiny">All images sorted 🎉</div>
                      )}
                    </div>
                  </div>
                )
              })()}

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
                      {inSf.length > 0 && (
                        <button className="sel-btn" style={{ marginLeft: 'auto', fontSize: 11 }}
                          onClick={() => setSfSelIds(new Set(inSf.map(i => i.id)))}>
                          Select All
                        </button>
                      )}
                    </div>
                    {inSf.length > 0 && sfSelIds.size > 0 && inSf.some(i => sfSelIds.has(i.id)) && (
                      <div className="sel-toolbar" style={{ marginBottom: 4 }}>
                        <span className="sel-count">
                          {inSf.filter(i => sfSelIds.has(i.id)).length} selected
                        </span>
                        <button className="sel-btn danger" onClick={clearSfSelection}>Clear</button>
                      </div>
                    )}
                    <div className="tiles small">
                      {/* update ref so shift-select works within this section */}
                      {(sfImgListRef.current = inSf, null)}
                      {inSf.map((img) => (
                        <ImageTile
                          key={img.id}
                          img={img}
                          selected={sfSelIds.has(img.id)}
                          onSelect={toggleSfImgSelect}
                          onDragStart={dragStart}
                          onOpen={(im) => openPreview(im, inSf, 'subfolder', selectedTower.id)}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}

              {/* sticky move bar for subfolder-column selection */}
              {sfSelIds.size > 0 && (
                <div className="move-bar">
                  <span className="move-bar-label">Move {sfSelIds.size} image(s) to:</span>
                  <div className="move-bar-towers">
                    <button className="move-bar-btn" onClick={() => moveSfSelectedToSubfolder(null)}>
                      Unsorted
                    </button>
                    {subfolders.map(sf => (
                      <button key={sf} className="move-bar-btn" onClick={() => moveSfSelectedToSubfolder(sf)}>
                        {sf}
                      </button>
                    ))}
                  </div>
                </div>
              )}
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

// memo prevents re-render when sibling tiles are selected — only the changed tile re-renders
const ImageTile = memo(function ImageTile({ img, onDragStart, onOpen, onSelect, selected, tag }) {
  const [loaded, setLoaded] = useState(false)
  const [src, setSrc] = useState(null)
  const tileRef = useRef(null)
  const scrollRoot = useContext(ScrollRootCtx)

  useEffect(() => {
    const el = tileRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setSrc(img.url)
          obs.disconnect()
        }
      },
      { root: scrollRoot?.current ?? null, rootMargin: '400px' }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [img.url, scrollRoot])

  return (
    <div
      ref={tileRef}
      className={'tile' + (selected ? ' tile-selected' : '')}
      data-imgid={img.id}
      draggable
      onDragStart={(e) => onDragStart(e, img.id)}
      onClick={(e) => {
        // pass img back to the handler — handler signature: (img, e)
        if (onSelect) onSelect(img, e)
        else if (onOpen) onOpen(img)
      }}
      onDoubleClick={() => onOpen && onOpen(img)}
      title={img.name}
    >
      {selected && <div className="tile-check">✓</div>}
      {!loaded && <div className="tile-skel" />}
      {src && (
        <img
          src={src}
          alt={img.name}
          decoding="async"
          loading="lazy"
          draggable={false}
          className={loaded ? 'in' : ''}
          onLoad={() => setLoaded(true)}
        />
      )}
      {tag && <span className="tile-tag">{tag}</span>}
      <span className="tile-name">{img.name}</span>
    </div>
  )
})
