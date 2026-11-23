import test from "node:test";
import assert from "node:assert/strict";
import { blankWorkspace, exampleWorkspace, type Workspace } from "../lib/model.ts";
import {
  createFirebaseWorkspaceEngine, decodeFirebaseVersion, decideFirebaseSync, encodeFirebaseVersion,
  firebaseChunkId, firebaseSha256, firebaseWorkspaceSignature, FirebaseHeadConflict, FirebaseSessionChanged,
  FIREBASE_MAX_CHUNK_BYTES, FIREBASE_MAX_SNAPSHOT_BYTES, parseFirebaseHead, parseFirebaseManifest,
  type FirebaseChunk, type FirebaseHead, type FirebaseManifest, type FirebaseVersion, type FirebaseWorkspaceStore,
} from "../lib/firebase-protocol.ts";

const idA = "10000000-0000-4000-8000-000000000001";
const idB = "10000000-0000-4000-8000-000000000002";
const date = "2026-11-23T00:00:00.000Z";
function remote(document: Workspace, id = idA): FirebaseVersion {
  return { id, parentId: null, createdAt: date, sha256: "a".repeat(64), document };
}
function memoryStore() {
  let head: FirebaseHead | null = null;
  const manifests = new Map<string, FirebaseManifest>();
  const chunks = new Map<string, FirebaseChunk[]>();
  const events: string[] = [];
  const subscribers = new Set<(head: FirebaseHead | null) => void>();
  const store: FirebaseWorkspaceStore = {
    async getHead() { return structuredClone(head); },
    async readManifest(id) { return structuredClone(manifests.get(id)); },
    async readChunks(id) { return structuredClone(chunks.get(id) ?? []); },
    async stage(manifest, parts) {
      assert.ok(!manifests.has(manifest.id), "version manifests are immutable");
      assert.ok(!chunks.has(manifest.id), "version chunks are immutable");
      chunks.set(manifest.id, structuredClone(parts));
      manifests.set(manifest.id, structuredClone(manifest));
      events.push("stage:" + manifest.id);
    },
    async compareAndSwap(next, expected) {
      assert.ok(manifests.has(next.headId), "the complete version must exist before publication");
      if ((head?.headId ?? null) !== expected) throw new FirebaseHeadConflict(expected, head?.headId ?? null, next.headId);
      head = structuredClone(next);
      events.push("head:" + next.headId);
      subscribers.forEach(callback => callback(structuredClone(head)));
    },
    watchHead(callback) { subscribers.add(callback); return () => { subscribers.delete(callback); }; },
  };
  return { store, manifests, chunks, events };
}

test("Firebase encoding preserves blank titles, rich text and unicode across document-size chunks", async () => {
  const workspace = exampleWorkspace();
  workspace.nodes[0].title = "";
  workspace.nodes[0].body = "가😀한글𐐷".repeat(20000);
  workspace.nodes[1].body = "🧭".repeat(99000);
  const original = structuredClone(workspace);
  const { manifest, chunks } = await encodeFirebaseVersion(workspace, null, idA, date);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(new TextEncoder().encode(chunk.text).byteLength <= FIREBASE_MAX_CHUNK_BYTES);
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(chunk.text)), chunk.text);
  }
  const decoded = await decodeFirebaseVersion(manifest, chunks, idA);
  assert.deepEqual(decoded.document, original);
  assert.deepEqual(workspace, original, "saving cannot mutate the editable workspace");
  assert.equal(decoded.sha256, await firebaseSha256(firebaseWorkspaceSignature(workspace)));
  assert.equal(firebaseChunkId(0), "0000");
});

test("Firebase incomplete, reordered, changed or foreign-version payloads cannot replace a local workspace", async () => {
  const workspace = exampleWorkspace();
  workspace.nodes[0].body = "한".repeat(90000);
  const { manifest, chunks } = await encodeFirebaseVersion(workspace, null, idA, date);
  await assert.rejects(decodeFirebaseVersion(manifest, chunks.slice(1), idA), /일부가 없습니다/);
  await assert.rejects(decodeFirebaseVersion(manifest, [...chunks].reverse(), idA), /일부가 올바르지/);
  const changed = structuredClone(chunks);
  changed[0].text = changed[0].text.replace("한", "글");
  await assert.rejects(decodeFirebaseVersion(manifest, changed, idA), /검증에 실패/);
  await assert.rejects(decodeFirebaseVersion(manifest, chunks, idB), /버전 정보/);
  assert.throws(() => parseFirebaseManifest({ ...manifest, chunkCount: 165 }, idA));
  assert.throws(() => parseFirebaseManifest({ ...manifest, byteLength: FIREBASE_MAX_SNAPSHOT_BYTES + 1 }, idA));
  assert.throws(() => parseFirebaseHead({ version: 1, headId: "../another-user", updatedAt: date, sha256: manifest.sha256 }));
});

test("Firebase upload limits reject oversized snapshots without mutating or staging any data", async () => {
  const workspace = exampleWorkspace();
  const template = workspace.nodes[0];
  workspace.nodes = Array.from({ length: 60 }, (_, index) => ({ ...template, id: "large-" + index, body: "a".repeat(190000) }));
  workspace.edges = [];
  const memory = memoryStore();
  const engine = createFirebaseWorkspaceEngine(memory.store);
  await assert.rejects(engine.commit(workspace, null), /10MB/);
  assert.equal(memory.manifests.size, 0);
  assert.equal(workspace.nodes.length, 60);
  assert.equal(await engine.getHead(), null);
});

test("Firebase first sign-in pulls into the pristine starter only and asks before independent data is replaced", () => {
  const saved = exampleWorkspace();
  assert.equal(decideFirebaseSync(blankWorkspace(), undefined, remote(saved)), "pull");
  const renamed = blankWorkspace();
  renamed.maps[0].name = "아직 노드가 없어도 내 작업";
  assert.equal(decideFirebaseSync(renamed, undefined, remote(saved)), "conflict");
  assert.equal(decideFirebaseSync(saved, undefined, remote(saved)), "same");
  assert.equal(decideFirebaseSync(saved), "push");
  const other = structuredClone(saved);
  other.nodes[0].title = "다른 기기 내용";
  assert.equal(decideFirebaseSync(saved, undefined, remote(other)), "conflict");
});

test("Firebase baseline decisions preserve offline changes and never recreate vanished cloud history", () => {
  const initial = exampleWorkspace();
  const base = { id: idA, document: initial };
  const local = structuredClone(initial), newer = structuredClone(initial);
  local.nodes[0].title = "오프라인 변경";
  newer.nodes[0].title = "다른 기기 변경";
  assert.equal(decideFirebaseSync(local, base, remote(initial)), "push");
  assert.equal(decideFirebaseSync(initial, base, remote(newer, idB)), "pull");
  assert.equal(decideFirebaseSync(local, base, remote(newer, idB)), "conflict");
  assert.equal(decideFirebaseSync(newer, base, remote(newer, idB)), "same");
  assert.throws(() => decideFirebaseSync(local, base, null), /기록이 없어졌습니다/);
  assert.throws(() => decideFirebaseSync(local, base, remote(newer, idA)), /기존 버전 내용이 변경/);
});

test("two Firebase devices publish with compare-and-swap and preserve the losing staged version", async () => {
  const memory = memoryStore();
  const a = createFirebaseWorkspaceEngine(memory.store), b = createFirebaseWorkspaceEngine(memory.store);
  const initial = await a.commit(exampleWorkspace(), null);
  const docA = structuredClone(initial.document), docB = structuredClone(initial.document);
  docA.nodes[0].title = "PC에서 수정";
  docB.nodes[0].title = "iPad에서 수정";
  const results = await Promise.allSettled([a.commit(docA, initial.id), b.commit(docB, initial.id)]);
  const winner = results.find(result => result.status === "fulfilled");
  const loser = results.find(result => result.status === "rejected");
  assert.ok(winner?.status === "fulfilled" && loser?.status === "rejected");
  assert.ok(loser.reason instanceof FirebaseHeadConflict);
  assert.equal((await a.getHead())?.headId, winner.value.id);
  assert.equal(memory.manifests.size, 3, "both changes and the original remain available");
  const preserved = await b.readVersion(loser.reason.stagedVersionId);
  assert.notEqual(preserved.document.nodes[0].title, winner.value.document.nodes[0].title);
  assert.deepEqual((await a.readVersion(initial.id)).document, initial.document);
  assert.equal(memory.events[0], "stage:" + initial.id);
  assert.equal(memory.events[1], "head:" + initial.id);
});

test("failed uploads and an account switch never publish an incomplete or stale-account head", async () => {
  const memory = memoryStore();
  const original = await createFirebaseWorkspaceEngine(memory.store).commit(exampleWorkspace(), null);
  const before = await memory.store.getHead();
  const broken = createFirebaseWorkspaceEngine({ ...memory.store, async stage() { throw Error("network interrupted"); } });
  await assert.rejects(broken.commit(blankWorkspace(), original.id), /network interrupted/);
  assert.deepEqual(await memory.store.getHead(), before);

  let current = true;
  const switched = createFirebaseWorkspaceEngine({ ...memory.store, async stage(manifest, chunks) {
    await memory.store.stage(manifest, chunks);
    current = false;
  } }, () => current);
  await assert.rejects(switched.commit(blankWorkspace(), original.id), FirebaseSessionChanged);
  assert.deepEqual(await memory.store.getHead(), before);
  assert.equal(memory.manifests.size, 2, "staging remains recoverable without changing the live document");
});

test("Firebase head subscriptions stop delivering content after account changes or unsubscribe", async () => {
  const memory = memoryStore();
  let current = true;
  const engine = createFirebaseWorkspaceEngine(memory.store, () => current);
  const received: Array<string | null> = [];
  const unsubscribe = engine.watchHead(head => received.push(head?.headId ?? null), error => { throw error; });
  const first = await engine.commit(blankWorkspace(), null);
  assert.deepEqual(received, [first.id]);
  current = false;
  const second = await createFirebaseWorkspaceEngine(memory.store).commit(exampleWorkspace(), first.id);
  assert.deepEqual(received, [first.id]);
  unsubscribe();
  current = true;
  await engine.commit(blankWorkspace(), second.id);
  assert.deepEqual(received, [first.id]);
});
