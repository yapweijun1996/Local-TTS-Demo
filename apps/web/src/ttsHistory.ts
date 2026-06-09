/**
 * WAV generation history -- persisted in IndexedDB.
 *
 * Stores generations up to MAX_DB_BYTES (50 MB) of WAV data total.
 * When a new entry would push the total over the limit the oldest entries
 * are pruned automatically (keeping at least the entry just added).
 * Each entry keeps the full WAV Blob and the full input text so the user
 * can re-play, re-download, or inspect the original prompt.
 */

const DB_NAME = "tts-history";
const DB_VERSION = 1;
const STORE = "entries";

/** Total WAV bytes allowed across all history entries. Oldest are pruned on save. */
export const MAX_DB_BYTES = 50 * 1024 * 1024; // 50 MB

export interface HistoryEntry {
  /** Auto-assigned by IndexedDB on insert. */
  id?: number;
  /** Full input text at the time of generation. */
  text: string;
  engine: string;
  voice: string;
  /** The generated audio as a WAV Blob. */
  wavBlob: Blob;
  /** Byte length of the WAV data (used for budget accounting). */
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
        // Index by createdAt so we can iterate oldest-first for pruning
        // and newest-first for display.
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// -- CRUD -------------------------------------------------------------------
/**
 * Save a new entry, then prune the oldest entries until the total WAV byte
 * usage is at or below MAX_DB_BYTES.  Returns the new entry's id.
 */
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

      // Scan all entries oldest-first to measure total and prune if over budget.
      const idx = store.index("createdAt");
      const snapshot: Array<{ id: number; byteLength: number }> = [];
      const cursorReq = idx.openCursor(); // ascending = oldest first

      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          const e = cursor.value as HistoryEntry;
          snapshot.push({ id: e.id!, byteLength: e.byteLength });
          cursor.continue();
        } else {
          // Cursor exhausted -- prune oldest until total <= MAX_DB_BYTES.
          // Always keep at least one entry (the one just added, which is last).
          let total = snapshot.reduce((s, e) => s + e.byteLength, 0);
          let i = 0;
          while (total > MAX_DB_BYTES && i < snapshot.length - 1) {
            store.delete(snapshot[i]!.id);
            total -= snapshot[i]!.byteLength;
            i++;
          }
          resolve(newId);
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    };
    addReq.onerror = () => reject(addReq.error);
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
    // Descending: "prev" direction gives newest first.
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

/** Wipe all history entries. */
export async function clearHistory(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Return the total WAV bytes currently stored.
 * Useful for displaying storage usage in the UI.
 */
export async function totalStorageBytes(): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    let total = 0;
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        total += (cursor.value as HistoryEntry).byteLength;
        cursor.continue();
      } else {
        resolve(total);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

// -- Helpers ----------------------------------------------------------------
/** Human-readable relative time (e.g. "2m ago", "just now"). */
export function relativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

/** Format bytes as B / KB / MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
