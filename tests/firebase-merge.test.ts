import test from "node:test";
import assert from "node:assert/strict";
import { blankWorkspace, documentSchema, MAX_SYNC_META_RECORDS, type Workspace, type KnowledgeNode } from "../lib/model.ts";
import { mergeFirebaseWorkspaces, stampWorkspace, workspaceContentSignature } from "../lib/firebase-merge.ts";

const clone = <T>(value: T): T => structuredClone(value);
function node(id: string, mapId: string | null = "first-map"): KnowledgeNode {
  return { id, mapId, title: id, body: `${id} 본문`, kind: "메모", source: "", tags: [], confidence: "탐색 중",
    position: { x: 0, y: 0 }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}
function workspace(...ids: string[]): Workspace {
  return { ...blankWorkspace(), nodes: ids.map(id => node(id)) };
}
function edit(base: Workspace, actor: string, time: number, change: (value: Workspace) => void): Workspace {
  const next = clone(base);
  change(next);
  return stampWorkspace(base, next, actor, time);
}
function converges(base: Workspace, a: Workspace, b: Workspace) {
  const result = mergeFirebaseWorkspaces(base, a, b);
  assert.deepEqual(result, mergeFirebaseWorkspaces(base, b, a), "swapping devices must produce the same workspace");
  assert.equal(JSON.stringify(result), JSON.stringify(mergeFirebaseWorkspaces(base, b, a)), "metadata dictionaries must also serialize identically");
  assert.deepEqual(result, mergeFirebaseWorkspaces(base, result, result), "repeating a merge must be idempotent");
  return result;
}

test("independent edits survive, same-entity timestamps and actors deterministically resolve ties", () => {
  const base = workspace("a", "b");
  base.maps[0].showRelationLabels = true;
  const local = edit(base, "pc", 100, value => { value.nodes[0].title = "PC"; });
  const remote = edit(base, "ipad", 200, value => { value.nodes[1].body = "iPad 본문"; });
  const frozen = JSON.stringify([base, local, remote]);
  const merged = converges(base, local, remote);
  assert.equal(merged.nodes.find(value => value.id === "a")!.title, "PC");
  assert.equal(merged.nodes.find(value => value.id === "b")!.body, "iPad 본문");
  assert.equal(merged.maps[0].showRelationLabels, true);
  assert.equal(JSON.stringify([base, local, remote]), frozen, "merge must not mutate inputs");
  const newer = edit(base, "ipad", 201, value => { value.nodes[0].title = "더 최근"; });
  assert.equal(converges(base, local, newer).nodes[0].title, "더 최근");
  const tied = edit(base, "zz-device", 100, value => { value.nodes[0].title = "동시 수정"; });
  assert.equal(converges(base, local, tied).nodes[0].title, "동시 수정");
});

test("local hybrid clocks keep advancing after clock rollback, and undo explicitly restamps content", () => {
  const original = workspace("a");
  const changed = edit(original, "pc", 500, value => { value.nodes[0].title = "수정"; });
  const undone = stampWorkspace(changed, original, "pc", 10);
  assert.deepEqual(undone.syncMeta!.clock, { time: 500, counter: 1 });
  assert.equal(undone.syncMeta!.entities.nodes.a.deleted, false);
  assert.equal(undone.nodes[0].title, "a");
  const unchanged = clone(undone);
  unchanged.syncMeta!.clock.time = 900;
  assert.equal(stampWorkspace(undone, unchanged, "pc", 20), undone, "metadata-only differences are not user edits");
  assert.equal(workspaceContentSignature(undone), workspaceContentSignature(unchanged));
  const draft = clone(undone);
  draft.nodes[0].title = "x".repeat(201);
  const stampedDraft = stampWorkspace(undone, draft, "pc", 20);
  assert.equal(stampedDraft.nodes[0].title.length, 201, "editing drafts must remain available for correction");
  assert.equal(documentSchema.safeParse(stampedDraft).success, false, "persistence still rejects an invalid draft");
});

test("deletion tombstones defeat older edits and remain after unrelated edits or imports", () => {
  const base = workspace("a", "b");
  const removed = edit(base, "pc", 200, value => { value.nodes = value.nodes.filter(item => item.id !== "a"); });
  const stale = edit(base, "ipad", 100, value => { value.nodes[0].body = "삭제 전 수정"; });
  const merged = converges(base, removed, stale);
  assert.deepEqual(merged.nodes.map(value => value.id), ["b"]);
  assert.equal(merged.syncMeta!.entities.nodes.a.deleted, true);
  assert.equal(converges(removed, removed, stale).nodes.some(value => value.id === "a"), false,
    "an older stamped snapshot must not resurrect a deletion already in the baseline");
  const imported = clone(merged);
  delete imported.syncMeta;
  imported.nodes[0].title = "다른 메모 수정";
  const stamped = stampWorkspace(merged, imported, "pc", 201);
  assert.equal(stamped.syncMeta!.entities.nodes.a.deleted, true);
  const restored = stampWorkspace(stamped, base, "pc", 202);
  assert.equal(restored.syncMeta!.entities.nodes.a.deleted, false, "an explicit undo/import can restore an entity with a newer stamp");
});

test("deleting a map keeps concurrent nodes in Inbox and tombstones their now-invalid edges", () => {
  const base = workspace();
  base.maps.push({ id: "other", name: "다른 맵", description: "", folderId: null });
  const local = edit(base, "pc", 100, value => { value.maps = value.maps.filter(map => map.id !== "first-map"); });
  const remote = edit(base, "ipad", 200, value => {
    value.nodes.push(node("a"), node("b"));
    value.edges.push({ id: "edge", source: "a", target: "b", relation: "지지" });
  });
  const merged = converges(base, local, remote);
  assert.deepEqual(merged.nodes.map(value => [value.id, value.mapId, value.body]), [["a", null, "a 본문"], ["b", null, "b 본문"]]);
  assert.equal(merged.edges.length, 0);
  assert.equal(merged.syncMeta!.entities.edges.edge.deleted, true);
});

test("missing folders and concurrent folder cycles are normalized deterministically", () => {
  const base = workspace();
  base.folders = [{ id: "a", name: "A", parentId: null }, { id: "b", name: "B", parentId: null }];
  const local = edit(base, "pc", 100, value => { value.folders[0].parentId = "b"; });
  const remote = edit(base, "ipad", 200, value => { value.folders[1].parentId = "a"; });
  assert.deepEqual(converges(base, local, remote).folders.map(folder => [folder.id, folder.parentId]), [["a", null], ["b", "a"]]);
  const deleted = edit(base, "pc", 100, value => { value.folders = value.folders.filter(folder => folder.id !== "a"); });
  const added = edit(base, "ipad", 200, value => {
    value.maps.push({ id: "new", name: "새 맵", description: "", folderId: "a", showRelationLabels: false });
    value.folders.push({ id: "c", name: "C", parentId: "a" });
  });
  const merged = converges(base, deleted, added);
  assert.equal(merged.maps.find(map => map.id === "new")!.folderId, null);
  assert.equal(merged.maps.find(map => map.id === "new")!.showRelationLabels, false);
  assert.equal(merged.folders.find(folder => folder.id === "c")!.parentId, null);
});

test("duplicate endpoint pairs retain the newest edge and record the losing edge tombstone", () => {
  const base = workspace("a", "b");
  const local = edit(base, "pc", 100, value => { value.edges.push({ id: "e1", source: "a", target: "b", relation: "지지" }); });
  const remote = edit(base, "ipad", 200, value => { value.edges.push({ id: "e2", source: "a", target: "b", relation: "반박" }); });
  const merged = converges(base, local, remote);
  assert.deepEqual(merged.edges.map(edge => edge.id), ["e2"]);
  assert.equal(merged.syncMeta!.entities.edges.e1.deleted, true);
});

test("concurrently deleting the two final maps creates one stable recovery map without losing nodes", () => {
  const base = workspace("a");
  base.nodes[0].mapId = null;
  base.maps.push({ id: "second", name: "두 번째 맵", description: "", folderId: null });
  const local = edit(base, "pc", 100, value => { value.maps = value.maps.filter(map => map.id !== "first-map"); });
  const remote = edit(base, "ipad", 200, value => { value.maps = value.maps.filter(map => map.id !== "second"); });
  const merged = converges(base, local, remote);
  assert.equal(merged.maps.length, 1);
  assert.equal(merged.maps[0].id, "sync-recovery-map");
  assert.deepEqual(merged.nodes, base.nodes);
  assert.equal(merged.syncMeta!.entities.maps["first-map"].deleted, true);
  assert.equal(merged.syncMeta!.entities.maps.second.deleted, true);
});

test("legacy edits derive deterministic versions from node dates or snapshot times without rewriting timestamps", () => {
  const base = workspace("a");
  const local = clone(base), remote = clone(base);
  local.nodes[0].title = "구버전 PC";
  local.nodes[0].updatedAt = "2026-02-01T00:00:00.000Z";
  remote.nodes[0].title = "구버전 iPad";
  remote.nodes[0].updatedAt = "2026-03-01T00:00:00.000Z";
  const merged = converges(base, local, remote);
  assert.equal(merged.nodes[0].title, "구버전 iPad");
  assert.equal(merged.nodes[0].updatedAt, remote.nodes[0].updatedAt);
  assert.equal(merged.nodes[0].createdAt, base.nodes[0].createdAt);
  const a = clone(base), b = clone(base);
  a.maps[0].name = "PC 맵"; b.maps[0].name = "iPad 맵";
  const selected = mergeFirebaseWorkspaces(base, a, b, { localTime: 100, remoteTime: 200 });
  assert.equal(selected.maps[0].name, "iPad 맵");
  assert.deepEqual(selected, mergeFirebaseWorkspaces(base, b, a, { localTime: 200, remoteTime: 100 }));
});

test("malformed metadata and union limits fail without truncating or mutating either device", () => {
  const base = workspace();
  const local = { ...clone(base), nodes: Array.from({ length: 1100 }, (_, index) => node(`local-${index}`)) };
  const remote = { ...clone(base), nodes: Array.from({ length: 1100 }, (_, index) => node(`remote-${index}`)) };
  const frozen = JSON.stringify([local, remote]);
  assert.throws(() => mergeFirebaseWorkspaces(base, local, remote));
  assert.equal(JSON.stringify([local, remote]), frozen);
  const malformed = edit(base, "pc", 10, value => { value.maps[0].name = "변경"; });
  malformed.syncMeta!.clock.time = Infinity;
  assert.throws(() => mergeFirebaseWorkspaces(base, malformed, base));
  const overloaded = clone(base);
  overloaded.syncMeta = { version: 1, clock: { time: 0, counter: 0 }, entities: { folders: {}, maps: {}, edges: {},
    nodes: Object.fromEntries(Array.from({ length: MAX_SYNC_META_RECORDS + 1 }, (_, index) => [`deleted-${index}`, { time: 0, counter: 0, actor: "pc", deleted: true }])) } };
  assert.equal(documentSchema.safeParse(overloaded).success, false);
  assert.throws(() => stampWorkspace(base, local, "", 1));
});

test("prototype-named legacy IDs remain valid and their deletion metadata is never discarded", () => {
  const base = workspace("constructor", "toString", "__proto__", "ordinary");
  const local = edit(base, "pc", 100, value => { value.nodes.find(item => item.id === "ordinary")!.title = "수정"; });
  const remote = edit(base, "ipad", 200, value => { value.nodes.push(node("added")); });
  const merged = converges(base, local, remote);
  assert.equal(merged.nodes.length, 5);
  for (const id of ["constructor", "toString", "__proto__"])
    assert.equal(Object.prototype.hasOwnProperty.call(merged.syncMeta!.entities.nodes, id), true);
  const deleted = edit(merged, "pc", 300, value => { value.nodes = value.nodes.filter(item => item.id !== "__proto__"); });
  const normalized = documentSchema.parse(deleted);
  assert.equal(normalized.syncMeta!.entities.nodes.__proto__.deleted, true);
  const roundTrip = documentSchema.parse(JSON.parse(JSON.stringify(normalized)));
  assert.equal(Object.prototype.hasOwnProperty.call(roundTrip.syncMeta!.entities.nodes, "__proto__"), true);
  assert.deepEqual(roundTrip.syncMeta!.entities.nodes.__proto__, normalized.syncMeta!.entities.nodes.__proto__);
  assert.deepEqual(mergeFirebaseWorkspaces(merged, roundTrip, merged), mergeFirebaseWorkspaces(merged, deleted, merged));
  assert.equal(converges(merged, deleted, merged).syncMeta!.entities.nodes.__proto__.deleted, true);
});
