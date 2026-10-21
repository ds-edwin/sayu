import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const workerSource = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const base = "https://example.test/sayu/";
const prefix = "sayu-offline-/sayu/-";

type WorkerRequest = { url: string; method: string; mode: string };
type WorkerEvent = {
  data?: unknown;
  request?: WorkerRequest;
  waitUntil: (value: unknown) => void;
  respondWith: (value: unknown) => void;
};

function workerHarness() {
  const listeners = new Map<string, ((event: WorkerEvent) => void)[]>();
  const cacheEntries = new Map<string, Map<string, Response>>();
  const fetches: string[] = [];
  const storageAccesses: string[] = [];
  const applicationData = new Map([
    ["workspace", { revision: 7, document: { title: "Saved thoughts", nodes: ["a", "b"] } }],
  ]);
  let skipWaitingCalls = 0;
  let claimCalls = 0;
  let online = true;

  function rejectStorageAccess(name: string): never {
    storageAccesses.push(name);
    throw new Error(`Service worker accessed application storage: ${name}`);
  }
  const worker = {
    location: { href: `${base}sw.js` },
    addEventListener(type: string, listener: (event: WorkerEvent) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    skipWaiting: async () => { skipWaitingCalls += 1; },
    clients: { claim: async () => { claimCalls += 1; } },
    get indexedDB(): never { return rejectStorageAccess("self.indexedDB"); },
  };
  const globals = {
    self: worker,
    URL,
    fetch: async (input: string | WorkerRequest) => {
      const url = typeof input === "string" ? input : input.url;
      fetches.push(url);
      if (!online) throw new Error("Offline");
      assert.equal(url, `${base}pwa-precache.json`);
      return new Response(JSON.stringify(["index.html", "pwa-assets/app.js"]));
    },
    caches: {
      keys: async () => [...cacheEntries.keys()],
      delete: async (name: string) => cacheEntries.delete(name),
      open: async (name: string) => {
        let entries = cacheEntries.get(name);
        if (!entries) {
          entries = new Map();
          cacheEntries.set(name, entries);
        }
        const cache = entries;
        return {
          addAll: async (urls: string[]) => {
            for (const url of urls) cache.set(url, new Response(`Cached ${url}`));
          },
          match: async (input: string | WorkerRequest) =>
            cache.get(typeof input === "string" ? input : input.url),
        };
      },
    },
    get indexedDB(): never { return rejectStorageAccess("indexedDB"); },
    get localStorage(): never { return rejectStorageAccess("localStorage"); },
  };
  runInNewContext(workerSource, globals, { filename: "public/sw.js" });

  async function dispatch(
    type: string,
    detail: Partial<Pick<WorkerEvent, "data" | "request">> = {},
  ): Promise<unknown> {
    const waits: Promise<unknown>[] = [];
    let response: Promise<unknown> | undefined;
    const event: WorkerEvent = {
      ...detail,
      waitUntil: value => { waits.push(Promise.resolve(value)); },
      respondWith: value => {
        assert.equal(response, undefined, "Each fetch has only one response");
        response = Promise.resolve(value);
      },
    };
    for (const listener of listeners.get(type) ?? []) listener(event);
    await Promise.all(waits);
    return response === undefined ? undefined : await response;
  }

  return {
    dispatch,
    cacheEntries,
    fetches,
    storageAccesses,
    applicationData,
    goOffline: () => { online = false; },
    get skipWaitingCalls() { return skipWaitingCalls; },
    get claimCalls() { return claimCalls; },
  };
}

function navigation(url: string, overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  return { url, method: "GET", mode: "navigate", ...overrides };
}

test("install precaches the app without activating the waiting worker", async () => {
  const worker = workerHarness();
  await worker.dispatch("install");
  assert.equal(worker.skipWaitingCalls, 0);
  assert.equal(worker.claimCalls, 0);
  assert.deepEqual(worker.fetches, [`${base}pwa-precache.json`]);
  assert.equal(worker.cacheEntries.size, 1);
  const cache = [...worker.cacheEntries.values()][0];
  assert.deepEqual([...cache.keys()], [`${base}index.html`, `${base}pwa-assets/app.js`]);
});

test("only an explicit SKIP_WAITING message requests worker activation", async () => {
  const worker = workerHarness();
  for (const data of [undefined, null, "SKIP_WAITING", {}, { type: "UNRELATED" }]) {
    await worker.dispatch("message", { data });
  }
  assert.equal(worker.skipWaitingCalls, 0);
  await worker.dispatch("message", { data: { type: "SKIP_WAITING" } });
  assert.equal(worker.skipWaitingCalls, 1);
  assert.equal(worker.claimCalls, 0);
});

test("activation removes only older caches for this application path", async () => {
  const worker = workerHarness();
  await worker.dispatch("install");
  const current = [...worker.cacheEntries.keys()][0];
  const currentContents = worker.cacheEntries.get(current);
  assert.ok(current.startsWith(prefix));
  const old = `${prefix}older-fixture`;
  const unrelated = ["unrelated-app-v1", "sayu-offline-/other/-v1", "sayu-offline-/-v1"];
  worker.cacheEntries.set(old, new Map());
  for (const name of unrelated) worker.cacheEntries.set(name, new Map());

  await worker.dispatch("activate");
  assert.equal(worker.cacheEntries.has(old), false);
  assert.equal(worker.cacheEntries.get(current), currentContents);
  assert.equal(currentContents?.size, 2);
  for (const name of unrelated) assert.equal(worker.cacheEntries.has(name), true);
  assert.equal(worker.claimCalls, 1);
});

test("cached app entry navigation still works offline after an update", async () => {
  const worker = workerHarness();
  await worker.dispatch("install");
  await worker.dispatch("message", { data: { type: "SKIP_WAITING" } });
  await worker.dispatch("activate");
  worker.goOffline();
  for (const url of [base, `${base}?source=bookmark`, `${base}index.html`]) {
    const response = await worker.dispatch("fetch", { request: navigation(url) });
    assert.ok(response instanceof Response);
    assert.equal(await response.clone().text(), `Cached ${base}index.html`);
  }
  assert.deepEqual(worker.fetches, [`${base}pwa-precache.json`]);
});

test("worker leaves other navigation, origins, and write requests to the browser", async () => {
  const worker = workerHarness();
  for (const request of [
    navigation(`${base}another-page`),
    navigation("https://other.test/sayu/"),
    navigation(base, { method: "POST" }),
  ]) {
    assert.equal(await worker.dispatch("fetch", { request }), undefined);
  }
  assert.deepEqual(worker.fetches, []);
});

test("install, requested activation, and offline reads leave application storage untouched", async () => {
  const worker = workerHarness();
  const savedApplicationData = structuredClone(worker.applicationData);
  await worker.dispatch("install");
  await worker.dispatch("message", { data: { type: "SKIP_WAITING" } });
  await worker.dispatch("activate");
  worker.goOffline();
  await worker.dispatch("fetch", { request: navigation(base) });

  assert.deepEqual(worker.storageAccesses, []);
  assert.deepEqual(worker.applicationData, savedApplicationData);
});
