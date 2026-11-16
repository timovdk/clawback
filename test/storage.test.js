import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal in-memory stand-ins for localStorage and the bits of IndexedDB that storage.js uses.
function fakeLocalStorage() {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
}

function fakeIndexedDB() {
  const stores = new Map();
  const later = (fn) => setTimeout(fn, 0);
  const db = {
    createObjectStore: (name) => stores.set(name, new Map()),
    transaction: (name) => {
      const tx = {};
      tx.objectStore = () => ({
        get: (k) => { const req = {}; later(() => { req.result = stores.get(name).get(k); req.onsuccess(); }); return req; },
        put: (v, k) => { later(() => { stores.get(name).set(k, structuredClone(v)); later(() => tx.oncomplete()); }); },
      });
      return tx;
    },
  };
  return {
    stores,
    open: () => {
      const req = { result: db };
      later(() => { if (!stores.size) req.onupgradeneeded(); req.onsuccess(); });
      return req;
    },
  };
}

let storage;
beforeEach(async () => {
  globalThis.localStorage = fakeLocalStorage();
  globalThis.indexedDB = fakeIndexedDB();
  // fresh module per test (it caches the open database)
  storage = await import(`../js/storage.js?t=${Math.random()}`);
});

test('save writes to IndexedDB and the localStorage mirror', async () => {
  const log = [{ id: '1', text: 'gordel' }];
  assert.equal(await storage.save('uov.log', log), true);
  assert.deepEqual(await storage.load('uov.log', []), log);
  assert.deepEqual(storage.loadSync('uov.log', []), log);
});

test('a delete is durable once save resolves', async () => {
  await storage.save('uov.log', [{ id: '1' }, { id: '2' }]);
  await storage.save('uov.log', [{ id: '2' }]);
  // simulate the app being killed: the localStorage mirror is lost, IndexedDB remains
  globalThis.localStorage = fakeLocalStorage();
  assert.deepEqual(await storage.load('uov.log', []), [{ id: '2' }]);
});

test('existing localStorage data is used and moved to IndexedDB', async () => {
  localStorage.setItem('uov.settings', JSON.stringify({ email: 'a@b.nl', theme: 'dark' }));
  assert.deepEqual(await storage.load('uov.settings', {}), { email: 'a@b.nl', theme: 'dark' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(indexedDB.stores.get('kv').get('uov.settings'), { email: 'a@b.nl', theme: 'dark' });
});

test('without IndexedDB it falls back to localStorage', async () => {
  delete globalThis.indexedDB;
  storage = await import(`../js/storage.js?t=${Math.random()}`);
  assert.equal(await storage.save('uov.log', [{ id: 'x' }]), false);
  assert.deepEqual(await storage.load('uov.log', []), [{ id: 'x' }]);
});

test('missing keys give the fallback', async () => {
  assert.deepEqual(await storage.load('nope', ['fallback']), ['fallback']);
  assert.equal(storage.loadSync('nope', 7), 7);
});
