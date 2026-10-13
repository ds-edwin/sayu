import { test } from "node:test";
import assert from "node:assert/strict";
import { DocumentHistory } from "../lib/history.ts";
import { documentSchema, exampleWorkspace } from "../lib/model.ts";
import { removeNodes, copyNodes, removeMap, moveMapToFolder, moveInboxNode } from "../lib/graph-operations.ts";
test("map deletion keeps thoughts in Inbox, leaves other maps intact, and undo restores connections", () => {
  const original = exampleWorkspace();
  original.maps.push({ id: "other", folderId: null, name: "Other", description: "" });
  const after = removeMap(original, "first-map");
  assert.equal(after.maps.length, 1);
  assert.equal(after.maps[0].id, "other");
  assert.deepEqual(after.nodes.map(n => ({ ...n, mapId: "first-map" })), original.nodes);
  assert.ok(after.nodes.every(n => n.mapId === null));
  assert.equal(after.edges.length, 0);
  assert.equal(documentSchema.safeParse(after).success, true);
  const history = new DocumentHistory<typeof original>();
  history.record(original, after);
  assert.deepEqual(history.undo(after), original);
  const only = exampleWorkspace();
  const last = removeMap(only, "first-map", () => "new-empty-map");
  assert.equal(last.maps[0].id, "new-empty-map");
  assert.equal(documentSchema.safeParse(last).success, true);
});
test("folder moves and Inbox drops preserve content and reject missing destinations", () => {
  const original = exampleWorkspace();
  original.folders = [{ id: "f", name: "Folder", parentId: null }];
  const movedMap = moveMapToFolder(original, "first-map", "f");
  assert.equal(movedMap.maps[0].folderId, "f");
  assert.deepEqual(movedMap.nodes, original.nodes);
  assert.deepEqual(movedMap.edges, original.edges);
  assert.equal(moveMapToFolder(original, "first-map", "missing"), original);
  const inbox = { ...original.nodes[0], id: "capture", mapId: null };
  original.nodes.push(inbox);
  const moved = moveInboxNode(original, "capture", "first-map");
  const node = moved.nodes.find(n => n.id === "capture")!;
  assert.equal(node.mapId, "first-map");
  assert.equal(node.title, inbox.title);
  assert.equal(node.body, inbox.body);
  assert.deepEqual(node.tags, inbox.tags);
  assert.deepEqual(moved.edges, original.edges);
  assert.equal(documentSchema.safeParse(moved).success, true);
  assert.equal(moveInboxNode(original, "capture", "missing"), original);
  assert.equal(moveInboxNode(original, "q", "first-map"), original);
});
test("legacy workspaces gain folders without losing existing maps or nodes", () => {
  const original = exampleWorkspace();
  const legacy = JSON.parse(JSON.stringify(original));
  delete legacy.folders;
  legacy.maps.forEach((m: any) => delete m.folderId);
  const parsed = documentSchema.parse(legacy);
  assert.deepEqual(parsed.nodes, original.nodes);
  assert.deepEqual(parsed.folders, []);
  assert.equal(parsed.maps[0].folderId, null);
});
test("folder hierarchy validates missing references and cycles", () => {
  const d = exampleWorkspace();
  d.folders = [
    { id: "f1", name: "Research", parentId: null },
    { id: "f2", name: "AI", parentId: "f1" },
  ];
  d.maps[0].folderId = "f2";
  assert.equal(documentSchema.safeParse(d).success, true);
  d.folders[0].parentId = "f2";
  assert.equal(documentSchema.safeParse(d).success, false);
  d.folders[0].parentId = null;
  d.maps[0].folderId = "missing";
  assert.equal(documentSchema.safeParse(d).success, false);
});
test("group deletion includes connected edges and undo restores exact graph", () => {
  const d = exampleWorkspace(),
    after = removeNodes(d, ["q", "a"]);
  assert.equal(after.nodes.length, 3);
  assert.equal(after.edges.length, 0);
  const h = new DocumentHistory<typeof d>();
  h.record(d, after);
  assert.deepEqual(h.undo(after), d);
  assert.deepEqual(h.redo(d), after);
});
test("group copy preserves internal edges but does not copy external links", () => {
  const d = exampleWorkspace();
  let seq = 0;
  const result = copyNodes(d, ["q", "a"], () => `copy-${++seq}`, "fixed");
  assert.equal(result.document.nodes.length, 7);
  assert.equal(result.document.edges.length, 5);
  const edge = result.document.edges.at(-1)!;
  assert.equal(edge.source, result.ids[0]);
  assert.equal(edge.target, result.ids[1]);
  assert.equal(documentSchema.safeParse(result.document).success, true);
  assert.equal(d.nodes.length, 5);
});
test("continuous drag is one undo even when longer than typing debounce", () => {
  const h = new DocumentHistory<number>();
  h.begin();
  h.record(0, 1, undefined, 1);
  h.record(1, 2, undefined, 10000);
  h.record(2, 3, undefined, 20000);
  h.end();
  assert.equal(h.past.length, 1);
  assert.equal(h.undo(3), 0);
  assert.equal(h.redo(0), 3);
});
test("typing coalesces; independent edits separate; editing after undo clears redo", () => {
  const h = new DocumentHistory<number>();
  h.record(0, 1, "title", 1);
  h.record(1, 2, "title", 100);
  h.record(2, 3, "body", 200);
  assert.equal(h.past.length, 2);
  assert.equal(h.undo(3), 2);
  h.record(2, 4, "title", 300);
  assert.equal(h.future.length, 0);
  assert.equal(h.record(4, 4), false);
});
