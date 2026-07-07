import { useEffect, useRef, useState } from 'react'
import { TEMPLATES, TEMPLATE_NAMES, DEFAULT_CUSTOM_TEMPLATES } from './templates.js'

const STORAGE_KEY = 'aeriosort_custom_templates'
const SEED_KEY    = 'aeriosort_templates_seeded'
const DRAFT_KEY   = 'aeriosort_template_draft'   // unsaved "New Template" form

export function loadCustomTemplates() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    // One-time seed of the default editable templates. Runs once ever, so once
    // the user deletes a seeded template it does not come back.
    if (!localStorage.getItem(SEED_KEY)) {
      localStorage.setItem(SEED_KEY, '1')
      const existing = new Set(list.map(t => t.name))
      const seeds = DEFAULT_CUSTOM_TEMPLATES.filter(t => !existing.has(t.name))
      if (seeds.length) {
        const merged = [...seeds, ...list]
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
        return merged
      }
    }
    return list
  } catch { return [] }
}

function saveAll(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
}

// ── subfolder TREE helpers (unlimited nesting) ──────────────────────────────
// A tree node is { name, children: node[] }. Legacy templates stored a flat
// string[] — toTree() upgrades either shape into the node form.
function toTree(nodes) {
  if (!Array.isArray(nodes)) return [{ name: '', children: [] }]
  const t = nodes.map(n =>
    typeof n === 'string' ? { name: n, children: [] } : { name: n.name || '', children: toTree(n.children) }
  )
  return t.length ? t : [{ name: '', children: [] }]
}
// drop nameless nodes; trim names (whole subtree of a nameless node is dropped)
function pruneTree(nodes) {
  return (nodes || [])
    .map(n => ({ name: (n.name || '').trim(), children: pruneTree(n.children) }))
    .filter(n => n.name)
}
function treeHasName(nodes) {
  return (nodes || []).some(n => (n.name || '').trim() || treeHasName(n.children))
}

const EMPTY_FORM = {
  name: '',
  rootFolder: '',              // export root folder name (blank → project ID)
  towerPrefix: 'T',           // tower folder prefix in ZIP → T1, T2
  zeroPad: false,              // T01, T02 padding
  noSubfolders: false,         // when true, towers have no subfolders at all
  subfolders: [{ name: '', children: [] }], // subfolder TREE
  renameImages: false,         // keep original filenames?
  imagePattern: '{tower}_{subfolder}_{original}', // rename pattern
}

// ── unsaved draft persistence (so closing the modal never loses your work) ──
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null')
    if (!d) return null
    return { ...EMPTY_FORM, ...d, subfolders: toTree(d.subfolders) }
  } catch { return null }
}

// has the user actually typed anything worth keeping?
function draftHasContent(f) {
  if (!f) return false
  return !!(
    f.name?.trim() ||
    f.rootFolder?.trim() ||
    treeHasName(f.subfolders) ||
    f.noSubfolders ||
    f.renameImages ||
    (f.towerPrefix && f.towerPrefix !== EMPTY_FORM.towerPrefix) ||
    (f.imagePattern && f.imagePattern !== EMPTY_FORM.imagePattern)
  )
}

export default function AdminPanel({ onClose, customTemplates, setCustomTemplates }) {
  const [form,    setForm]    = useState(() => loadDraft() || EMPTY_FORM)
  const [editIdx, setEditIdx] = useState(null)
  // if there's an unsaved draft, reopen straight into the editor so it's visible
  const [tab,     setTab]     = useState(() => draftHasContent(loadDraft()) ? 'edit' : 'list')
  const [error,   setError]   = useState('')
  const importRef = useRef(null)

  // persist the new-template form as a draft on every change (not while editing
  // an existing template — that has its own source of truth)
  useEffect(() => {
    if (tab !== 'edit' || editIdx !== null) return
    if (draftHasContent(form)) localStorage.setItem(DRAFT_KEY, JSON.stringify(form))
    else localStorage.removeItem(DRAFT_KEY)
  }, [form, tab, editIdx])

  // ── export all custom templates as a JSON file ────────────────────────────
  const exportTemplates = () => {
    const blob = new Blob([JSON.stringify(customTemplates, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'vinyasah_templates.json'; a.click()
    URL.revokeObjectURL(url)
  }

  // ── import templates from a JSON file ─────────────────────────────────────
  const importTemplates = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result)
        if (!Array.isArray(data)) { setError('Invalid file — expected a JSON array.'); return }
        // merge: skip any that clash with existing names
        const existing = new Set(customTemplates.map(t => t.name))
        const incoming = data.filter(t => t.name && t.subfolders && !existing.has(t.name))
        const next = [...customTemplates, ...incoming]
        saveAll(next)
        setCustomTemplates(next)
        setError(`Imported ${incoming.length} template(s). ${data.length - incoming.length} skipped (name conflict).`)
      } catch { setError('Could not parse file. Make sure it is a valid JSON file.') }
    }
    reader.readAsText(file)
  }

  // ── form helpers ──────────────────────────────────────────────────────────
  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // Recursive tree editing: `path` is an array of child-indices locating a
  // node, e.g. [1,0] = subfolders[1].children[0]. Unlimited depth.
  const editTreeAt = (tree, path, fn) => {
    if (path.length === 0) return fn(tree)
    const [i, ...rest] = path
    return tree.map((n, idx) => idx === i ? { ...n, children: editTreeAt(n.children, rest, fn) } : n)
  }
  const setSF = (path, name) =>
    setForm(f => ({
      ...f,
      subfolders: editTreeAt(f.subfolders, path.slice(0, -1), (siblings) =>
        siblings.map((n, i) => i === path[path.length - 1] ? { ...n, name } : n)
      ),
    }))
  // parentPath locates a node whose CHILDREN array gets a new blank node appended;
  // parentPath = [] appends to the top-level subfolder list.
  const addSF = (parentPath) =>
    setForm(f => ({
      ...f,
      subfolders: editTreeAt(f.subfolders, parentPath, (children) => [...children, { name: '', children: [] }]),
    }))
  const removeSF = (path) =>
    setForm(f => ({
      ...f,
      subfolders: editTreeAt(f.subfolders, path.slice(0, -1), (siblings) =>
        siblings.filter((_, i) => i !== path[path.length - 1])
      ),
    }))

  // ── open editor ───────────────────────────────────────────────────────────
  // open the new-template editor, restoring any unsaved draft
  const startNew = () => { setForm(loadDraft() || EMPTY_FORM); setEditIdx(null); setError(''); setTab('edit') }

  // discard the unsaved draft and start from a blank form
  const discardDraft = () => { localStorage.removeItem(DRAFT_KEY); setForm(EMPTY_FORM); setError('') }

  const startEdit = (idx) => {
    const t = customTemplates[idx]
    const hasNoSf = !t.subfolders || t.subfolders.length === 0
    setForm({
      name:         t.name,
      rootFolder:   t.rootFolder   || '',
      towerPrefix:  t.towerPrefix  || 'T',
      zeroPad:      t.zeroPad      || false,
      noSubfolders: hasNoSf,
      subfolders:   toTree(t.subfolders),
      renameImages: t.renameImages || false,
      imagePattern: t.imagePattern || '{tower}_{subfolder}_{original}',
    })
    setEditIdx(idx)
    setError('')
    setTab('edit')
  }

  // ── save ──────────────────────────────────────────────────────────────────
  const save = () => {
    const name = form.name.trim()
    if (!name) { setError('Template name is required.'); return }

    const allNames = [
      ...TEMPLATE_NAMES,
      ...customTemplates.map((t, i) => i === editIdx ? '' : t.name),
    ]
    if (allNames.includes(name)) { setError('A template with this name already exists.'); return }

    // when "no subfolders" is checked, save an empty list and skip the check
    const sfs = form.noSubfolders ? [] : pruneTree(form.subfolders)
    if (!form.noSubfolders && !sfs.length) { setError('Add at least one subfolder, or tick “No subfolders”.'); return }

    const entry = {
      name,
      rootFolder:   form.rootFolder.trim(),
      towerPrefix:  form.towerPrefix.trim() || 'T',
      zeroPad:      form.zeroPad,
      subfolders:   sfs,
      renameImages: form.renameImages,
      imagePattern: form.imagePattern.trim(),
    }

    const next = [...customTemplates]
    if (editIdx !== null) next[editIdx] = entry
    else next.push(entry)

    saveAll(next)
    setCustomTemplates(next)
    if (editIdx === null) localStorage.removeItem(DRAFT_KEY) // draft is now saved
    setForm(EMPTY_FORM)
    setEditIdx(null)
    setTab('list')
    setError('')
  }

  const del = (idx) => {
    if (!confirm(`Delete "${customTemplates[idx].name}"?`)) return
    const next = customTemplates.filter((_, i) => i !== idx)
    saveAll(next)
    setCustomTemplates(next)
  }

  // ── preview tower folder name ─────────────────────────────────────────────
  const previewTower = (n) => {
    const p = (form.towerPrefix || 'T').trim()
    if (form.zeroPad) return `${p}${String(n).padStart(2, '0')}`
    return `${p}${n}`
  }

  return (
    <div className="admin-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={e => e.stopPropagation()}>

        {/* ── HEADER ── */}
        <div className="admin-header">
          <span>⚙ Template Manager</span>
          <button className="admin-close" onClick={onClose}>✕</button>
        </div>

        {/* ── TABS ── */}
        <div className="admin-tabs">
          <button className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>
            Templates
          </button>
          <button className={tab === 'edit' ? 'on' : ''} onClick={() => { startNew(); setTab('edit') }}>
            + New Template
          </button>
        </div>

        {/* ══════════ LIST TAB ══════════ */}
        {tab === 'list' && (
          <div className="admin-body">

            {/* storage info + backup/restore */}
            <div className="admin-storage-bar">
              <span className="admin-storage-info">
                💾 Custom templates saved in <b>browser localStorage</b> — back up with Export.
              </span>
              <div className="admin-storage-btns">
                <button className="admin-btn edit" onClick={exportTemplates}
                  disabled={customTemplates.length === 0}>⬇ Export JSON</button>
                <label className="admin-btn edit" style={{ cursor: 'pointer' }}>
                  ⬆ Import JSON
                  <input ref={importRef} type="file" accept=".json" hidden onChange={importTemplates} />
                </label>
              </div>
            </div>
            {error && <div className="admin-error" style={{ marginBottom: 8 }}>{error}</div>}

            {TEMPLATE_NAMES.length > 0 && (
              <>
                <div className="admin-section-label">Built-in (read-only)</div>
                {TEMPLATE_NAMES.map(n => (
                  <div key={n} className="admin-tpl-row builtin">
                    <span className="admin-tpl-name">📋 {n}</span>
                    <span className="admin-tpl-subs">{TEMPLATES[n].join(' · ')}</span>
                  </div>
                ))}
              </>
            )}

            <div className="admin-section-label" style={{ marginTop: 14 }}>
              My Templates ({customTemplates.length})
            </div>
            {customTemplates.length === 0 && (
              <div className="admin-empty">No custom templates yet. Click "+ New Template".</div>
            )}
            {customTemplates.map((t, i) => (
              <div key={i} className="admin-tpl-row">
                <div className="admin-tpl-info">
                  <span className="admin-tpl-name">🗂 {t.name}</span>
                  <span className="admin-tpl-subs">{t.subfolders.join(' · ')}</span>
                  <span className="admin-tpl-meta">
                    Tower prefix: <b>{t.towerPrefix}{t.zeroPad ? '01' : '1'}</b>
                    {t.renameImages && ' · Images renamed'}
                  </span>
                </div>
                <div className="admin-tpl-actions">
                  <button className="admin-btn edit" onClick={() => startEdit(i)}>✏ Edit</button>
                  <button className="admin-btn del" onClick={() => del(i)}>🗑</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ══════════ EDIT TAB ══════════ */}
        {tab === 'edit' && (
          <div className="admin-body">
            {error && <div className="admin-error">{error}</div>}

            {/* Template name */}
            <div className="admin-field">
              <label>Template Name</label>
              <input
                placeholder="e.g. Transmission Tower"
                value={form.name}
                onChange={e => setField('name', e.target.value)}
              />
            </div>

            {/* Export root folder name */}
            <div className="admin-field">
              <label>Export Folder Name</label>
              <input
                placeholder="e.g. Bidar (blank = use Project ID)"
                value={form.rootFolder}
                onChange={e => setField('rootFolder', e.target.value)}
              />
              <div className="admin-hint" style={{ marginTop: 4 }}>
                Top-level folder that holds all towers when you export.
                Leave blank to use the project ID.
              </div>
            </div>

            {/* Tower folder naming */}
            <div className="admin-group">
              <div className="admin-group-title">Tower Folder Key (used in ZIP)</div>
              <div className="admin-row">
                <div className="admin-field half">
                  <label>Tower key / name</label>
                  <input
                    placeholder="e.g. poll, Pole, T"
                    value={form.towerPrefix}
                    onChange={e => setField('towerPrefix', e.target.value)}
                  />
                </div>
                <div className="admin-field half">
                  <label>Zero-pad numbers</label>
                  <label className="admin-toggle">
                    <input type="checkbox" checked={form.zeroPad}
                      onChange={e => setField('zeroPad', e.target.checked)} />
                    <span>{form.zeroPad ? 'On (01)' : 'Off (1)'}</span>
                  </label>
                </div>
              </div>
              <div className="admin-preview">
                Tower folders: <b>{previewTower(1)}</b>, <b>{previewTower(2)}</b>, <b>{previewTower(3)}</b>…
                <br/><span style={{ color: '#6b7690' }}>This is the "{form.towerPrefix || 'T'}1, {form.towerPrefix || 'T'}2" part of each tower folder.</span>
              </div>
            </div>

            {/* Subfolders */}
            <div className="admin-group">
              <div className="admin-group-title">Subfolder Names</div>

              <label className="admin-toggle" style={{ marginBottom: 10 }}>
                <input type="checkbox" checked={form.noSubfolders}
                  onChange={e => setField('noSubfolders', e.target.checked)} />
                <span>No subfolders — images go straight into each tower folder</span>
              </label>

              {form.noSubfolders ? (
                <div className="admin-preview">
                  Towers will have <b>no subfolders</b>. Images are sorted only into <b>{previewTower(1)}</b>, <b>{previewTower(2)}</b>…
                </div>
              ) : (
                <SubfolderTreeEditor
                  nodes={form.subfolders}
                  path={[]}
                  onRename={setSF}
                  onAdd={addSF}
                  onRemove={removeSF}
                />
              )}
              <div className="admin-hint" style={{ marginTop: 6 }}>
                Click <b>+ nested</b> under any subfolder to add sub-subfolders — unlimited depth.
              </div>
            </div>

            {/* Export image naming */}
            <div className="admin-group">
              <div className="admin-group-title">Export Image Names</div>
              <label className="admin-radio">
                <input type="radio" checked={!form.renameImages}
                  onChange={() => setField('renameImages', false)} />
                Keep original filenames
              </label>
              <label className="admin-radio">
                <input type="radio" checked={form.renameImages}
                  onChange={() => setField('renameImages', true)} />
                Rename images
              </label>
              {form.renameImages && (
                <>
                  <div className="admin-field" style={{ marginTop: 8 }}>
                    <label>Pattern</label>
                    <input
                      value={form.imagePattern}
                      onChange={e => setField('imagePattern', e.target.value)}
                    />
                  </div>
                  <div className="admin-hint">
                    Variables: <code>{'{tower}'}</code> <code>{'{subfolder}'}</code> <code>{'{original}'}</code> <code>{'{n}'}</code>
                    <br />
                    Example: <b>{form.imagePattern
                      .replace('{tower}',     previewTower(1))
                      .replace('{subfolder}', form.subfolders[0]?.name || 'SF')
                      .replace('{original}',  'DJI_001.JPG')
                      .replace('{n}',         '1')
                    }</b>
                  </div>
                </>
              )}
            </div>

            {editIdx === null && draftHasContent(form) && (
              <div className="admin-draft-note">
                ✓ Draft auto-saved — your details are kept even if you close this window.
              </div>
            )}

            {/* Actions */}
            <div className="admin-actions">
              <button className="admin-btn cancel" onClick={() => setTab('list')}>Cancel</button>
              {editIdx === null && draftHasContent(form) && (
                <button className="admin-btn del" onClick={discardDraft}>🗑 Start fresh</button>
              )}
              <button className="admin-btn save" onClick={save}>
                {editIdx !== null ? '💾 Update Template' : '💾 Save Template'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── recursive subfolder tree editor (unlimited depth) ───────────────────────
// path: array of indices locating each node from the root, e.g. [1,0].
function SubfolderTreeEditor({ nodes, path, onRename, onAdd, onRemove, depth = 0 }) {
  return (
    <div className="sf-tree" style={depth > 0 ? { marginLeft: 18 } : undefined}>
      {nodes.map((node, i) => {
        const nodePath = [...path, i]
        // nested levels can always be emptied out; the root list needs >=1 row
        const canDelete = depth > 0 || nodes.length > 1
        return (
          <div key={i} className="sf-tree-node">
            <div className="admin-sf-row">
              <span className="admin-sf-num">{i + 1}</span>
              <input
                placeholder={`Subfolder ${i + 1}`}
                value={node.name}
                onChange={e => onRename(nodePath, e.target.value)}
              />
              <button className="admin-sf-nest" onClick={() => onAdd(nodePath)} title="Add nested subfolder">
                + nested
              </button>
              <button className="admin-sf-del"
                onClick={() => onRemove(nodePath)}
                disabled={!canDelete}>✕</button>
            </div>
            {node.children.length > 0 && (
              <SubfolderTreeEditor
                nodes={node.children}
                path={nodePath}
                onRename={onRename}
                onAdd={onAdd}
                onRemove={onRemove}
                depth={depth + 1}
              />
            )}
          </div>
        )
      })}
      <button className="admin-add-sf" onClick={() => onAdd(path)}>
        + Add {depth > 0 ? 'Sibling' : 'Subfolder'}
      </button>
    </div>
  )
}
