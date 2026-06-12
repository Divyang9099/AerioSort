// IndexedDB helper — stores raw File objects (can't go in localStorage)
const DB_NAME  = 'vinyasah_files'
const STORE    = 'files'
const DB_VER   = 1

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER)
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess  = (e) => resolve(e.target.result)
    req.onerror    = (e) => reject(e.target.error)
  })
}

export async function saveFiles(entries) {
  // entries: [{ id: string, file: File }]
  const db = await openDB()
  const tx = db.transaction(STORE, 'readwrite')
  const st = tx.objectStore(STORE)
  entries.forEach(({ id, file }) => st.put({ id, file }))
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve
    tx.onerror    = (e) => reject(e.target.error)
  })
}

export async function loadAllFiles() {
  // returns [{ id, file }]
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror   = (e) => reject(e.target.error)
  })
}

export async function clearFiles() {
  const db = await openDB()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).clear()
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve
    tx.onerror    = (e) => reject(e.target.error)
  })
}
