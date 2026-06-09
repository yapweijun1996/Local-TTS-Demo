/**
 * WAV generation history -- persisted in IndexedDB.
 *
 * Stores the last MAX_ENTRIES generations (oldest auto-pruned on save).
 * Each entry keeps the full WAV Blob so the user can re-play or re-download
 * without regenerating.
 */

const DB_NAME = "tts-history";
const DB_VERSION = 1;
const STORE = "entries";
/** Maximum number of history entries to retain. Oldest are pruned automatically. */
export const MAX_HISTORY_ENTRIES = 20;

export interface HistoryEntry {
  /** Auto-assigned by IndexedDB on insert. */
  id?: number;
  /** First 200 chars of the input text (for display). */
  text: string;
  engine: string;
  voice: string;
  wavBlob: Blob;
  byteLength: number;
  /** Unix timestamp (ms) when generation completed. */
  createdAt: number;
}

// -- DB open ----------------------------------------------------------------
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        // Index by createdAt so we can iterate newest-first.
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// -- CRUD -------------------------------------------------------------------
/** Save a new entry and prune the oldest if over the limit. Returns the new id. */
export async function saveHistoryEntry(
  entry: Omit<HistoryEntry, "id">,
): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const addReq = store.add(entry);
    addReq.onsuccess = () => {
      const newId = addReq.result as number;
      // Prune oldest entries over the limit.
      const countReq = store.count();
      countReq.onsuccess = () => {
        const count = countReq.result;
        if (count > MAX_HISTORY_ENTRIES) {
          // Open a cursor ordered by createdAt ascending (oldest first).
          const idx = store.index("createdAt");
          const cursorReq = idx.openCursor();
          let toDelete = count - MAX_HISTORY_ENTRIES;
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor && toDelete > 0) {
              store.delete(cursor.primaryKey);
              toDelete--;
              cursor.continue();
            }
          };
        }
      };
      resolve(newId);
    };
    tx.onerror = () => reject(tx.error);
  });
}

/** List all entries, newest first. */
export async function listHistory(): Promise<HistoryEntry[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const idx = store.index("createdAt");
    // Descending: use "prev" direction.
    const results: HistoryEntry[] = [];
    const cursorReq = idx.openCursor(null, "prev");
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        results.push(cursor.value as HistoryEntry);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

/** Delete a single entry by id. */
export async function deleteHistoryEntry(id: number): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Wipe all history. */
export async function clearHistory(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// -- Helpers ----------------------------------------------------------------
/** Human-readable relative time (e.g. "2 min ago", "just now"). */
export function relativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

/** Format bytes as KB / MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
