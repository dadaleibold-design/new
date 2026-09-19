const DB_NAME = "wa_clone_db";
const DB_VERSION = 1;
const STORES = {
  messages: "messages",
  conversations: "conversations",
  contacts: "contacts",
  outbox: "outbox",
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
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
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
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
