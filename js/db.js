const DB_NAME = "wa_clone_db";
const DB_VERSION = 1;
const STORES = {
  messages: "messages",
  conversations: "conversations",
  contacts: "contacts",
  outbox: "outbox",
};

let dbPromise = null;
let dbUnavailable = false;

/**
 * هل IndexedDB متاح فعلاً؟ (يُعطَّل في وضع التصفح الخاص ببعض المتصفحات،
 * أو داخل iframe بقيود، أو عند امتلاء حصة التخزين)
 */
function isIndexedDbAvailable() {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb() {
  if (dbUnavailable) return Promise.reject(new Error("IndexedDB غير متاح"));
  if (dbPromise) return dbPromise;

  if (!isIndexedDbAvailable()) {
    dbUnavailable = true;
    return Promise.reject(new Error("IndexedDB غير متاح في هذا المتصفح"));
  }

  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      dbUnavailable = true;
      reject(err);
      return;
    }

    // إن حُظرت الترقية بتبويب آخر مفتوح، لا تتجمّد للأبد
    req.onblocked = () => reject(new Error("قاعدة البيانات المحلية محجوزة في تبويب آخر"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.messages)) {
        const store = db.createObjectStore(STORES.messages, { keyPath: "id" });
        store.createIndex("by_conversation", "conversation_id");
      }
      if (!db.objectStoreNames.contains(STORES.conversations)) {
        db.createObjectStore(STORES.conversations, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.contacts)) {
        db.createObjectStore(STORES.contacts, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.outbox)) {
        db.createObjectStore(STORES.outbox, { keyPath: "local_id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbUnavailable = true;
      reject(req.error);
    };
  });

  // لا تُبقِ وعداً مرفوضاً مخزّناً — اسمح بإعادة المحاولة لاحقاً
  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

async function tx(storeName, mode, fn) {
  if (!isIndexedDbAvailable()) return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function cacheMessages(conversationId, messages) {
  return tx(STORES.messages, "readwrite", (store) => {
    messages.forEach((m) => store.put(m));
  });
}

export async function getCachedMessages(conversationId) {
  if (!isIndexedDbAvailable()) return [];
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORES.messages, "readonly");
    const idx = t.objectStore(STORES.messages).index("by_conversation");
    const req = idx.getAll(IDBKeyRange.only(conversationId));
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.created_at.localeCompare(b.created_at)));
    req.onerror = () => reject(req.error);
  });
}

export async function cacheConversationMeta(meta) {
  return tx(STORES.conversations, "readwrite", (store) => store.put(meta));
}

export async function cacheContacts(contacts) {
  return tx(STORES.contacts, "readwrite", (store) => {
    contacts.forEach((c) => store.put(c));
  });
}

export async function getCachedContacts() {
  if (!isIndexedDbAvailable()) return [];
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORES.contacts, "readonly");
    const req = t.objectStore(STORES.contacts).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function queueOutboxMessage(msg) {
  return tx(STORES.outbox, "readwrite", (store) => store.add({ ...msg, queued_at: new Date().toISOString() }));
}

export async function getOutbox() {
  if (!isIndexedDbAvailable()) return [];
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORES.outbox, "readonly");
    const req = t.objectStore(STORES.outbox).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function removeFromOutbox(localId) {
  return tx(STORES.outbox, "readwrite", (store) => store.delete(localId));
}

export async function clearAllCache() {
  const db = await openDb();
  return Promise.all(
    Object.values(STORES).map(
      (name) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(name, "readwrite");
          t.objectStore(name).clear();
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
        })
    )
  );
}

/** هل التخزين المحلي متاح؟ (تستخدمه الواجهة لتعطيل الوضع دون اتصال) */
export function isOfflineCacheAvailable() {
  return isIndexedDbAvailable() && !dbUnavailable;
}
