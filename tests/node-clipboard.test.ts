import { test } from "node:test";
import assert from "node:assert/strict";
import { documentSchema, type KnowledgeNode, type Workspace } from "../lib/model.ts";
import { DocumentHistory } from "../lib/history.ts";
import { captureNodeClipboard, parseNodeClipboard, pasteNodeClipboard } from "../lib/node-clipboard.ts";

const created = "2026-10-01T00:00:00.000Z";
const pastedAt = "2026-10-20T00:00:00.000Z";

function node(id: string, mapId: string, x: number, y: number): KnowledgeNode {
  return {
    id, mapId, title: id === "a1" ? "원래 제목" : id,
    body: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `${id} 본문` }] }] }),
    kind: id === "a2" ? "주장" : "메모", tags: [id, "보존"],
    source: "https://example.com/reference", confidence: "탐색 중",
    position: { x, y }, createdAt: created, updatedAt: created,
  };
}

function fixture(): Workspace {
  return {
    folders: [],
    maps: [
      { id: "a", name: "원본", description: "", folderId: null },
      { id: "b", name: "목적지", description: "", folderId: null },
    ],
    nodes: [node("a1", "a", 10, 20), node("a2", "a", 210, 120), node("a3", "a", 410, 20), node("b1", "b", 0, 0), node("b2", "b", 300, 0)],
    edges: [
      { id: "inside", source: "a1", target: "a2", relation: "지지" },
      { id: "outgoing", source: "a2", target: "a3", relation: "관련" },
      { id: "incoming", source: "a3", target: "a1", relation: "원인" },
      { id: "unrelated", source: "b1", target: "b2", relation: "구체화" },
    ],
  };
}

function clipboard(document: Workspace) {
  const value = captureNodeClipboard(document, ["a1", "a2"], "test-clipboard");
  assert.ok(value);
  return value;
}

function ids(prefix: string) {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function content(n: KnowledgeNode) {
  return { title: n.title, body: n.body, kind: n.kind, tags: n.tags, source: n.source, confidence: n.confidence };
}

test("node clipboard is a deep snapshot containing only internal connections", () => {
  const document = fixture();
  const captured = clipboard(document);
  const snapshot = structuredClone(captured);
  assert.equal(captured.format, "sayu-nodes");
  assert.equal(captured.version, 1);
  assert.equal(captured.token, "test-clipboard");
  assert.deepEqual(captured.nodes.map(n => n.id), ["a1", "a2"]);
  assert.deepEqual(captured.edges.map(e => e.id), ["inside"]);
  document.nodes[0].tags.push("나중 태그");
  document.nodes[0].position.x = 999;
  document.nodes[0].body = "나중 본문";
  document.edges[0].relation = "반박";
  assert.deepEqual(captured, snapshot);
  assert.equal(captureNodeClipboard(document, []), null);
  assert.equal(captureNodeClipboard(document, ["missing"]), null);
});

test("clipboard parsing accepts its serialized snapshot and rejects malformed graphs", () => {
  const captured = clipboard(fixture());
  assert.deepEqual(parseNodeClipboard(JSON.stringify(captured)), captured);
  for (const value of [
    null,
    {},
    { ...captured, format: "other" },
    { ...captured, version: 2 },
    { ...captured, nodes: [{ ...captured.nodes[0], title: "" }] },
    { ...captured, nodes: [captured.nodes[0], captured.nodes[0]] },
    { ...captured, edges: [{ ...captured.edges[0], target: "missing" }] },
    { ...captured, edges: [{ ...captured.edges[0], relation: "unsupported" }] },
  ]) {
    assert.equal(parseNodeClipboard(JSON.stringify(value)), null);
  }
  assert.equal(parseNodeClipboard("not JSON"), null);
});

test("copying across maps preserves exact content, relative placement, and fresh IDs on every paste", () => {
  const original = fixture();
  const before = structuredClone(original);
  const captured = clipboard(original);
  const makeId = ids("copy");
  const first = pasteNodeClipboard(original, captured, "b", { anchor: { x: 1000, y: 2000 }, makeId, now: pastedAt });
  assert.deepEqual(original, before);
  assert.equal(first.removedEdges, 0);
  assert.equal(first.ids.length, 2);
  const copies = first.ids.map(id => first.document.nodes.find(n => n.id === id)!);
  for (const source of captured.nodes) {
    const copy = copies.find(n => n.title === source.title)!;
    assert.ok(copy);
    assert.deepEqual(content(copy), content(source));
    assert.equal(copy.mapId, "b");
    assert.notEqual(copy.id, source.id);
    assert.equal(copy.createdAt, pastedAt);
    assert.equal(copy.updatedAt, pastedAt);
    assert.deepEqual(copy.position, { x: 1000 + source.position.x - 10, y: 2000 + source.position.y - 20 });
  }
  const copiedEdge = first.document.edges.find(e => !original.edges.some(old => old.id === e.id))!;
  assert.equal(copiedEdge.relation, "지지");
  assert.equal(copiedEdge.source, copies.find(n => n.title === captured.nodes[0].title)!.id);
  assert.equal(copiedEdge.target, copies.find(n => n.title === captured.nodes[1].title)!.id);
  assert.equal(first.document.edges.length, original.edges.length + 1);
  const second = pasteNodeClipboard(first.document, captured, "b", { makeId, now: pastedAt });
  assert.ok(second.ids.every(id => !first.document.nodes.some(n => n.id === id)));
  assert.equal(second.document.nodes.length, original.nodes.length + 4);
  assert.equal(second.document.edges.length, original.edges.length + 2);
  assert.equal(documentSchema.safeParse(second.document).success, true);
  const history = new DocumentHistory<Workspace>();
  history.record(original, first.document);
  assert.deepEqual(history.undo(first.document), original);
  assert.deepEqual(history.redo(original), first.document);
});

test("copy paste uses captured content even if the source is edited or deleted", () => {
  const original = fixture();
  const captured = clipboard(original);
  const changed = structuredClone(original);
  changed.nodes = changed.nodes.filter(n => n.id !== "a1");
  changed.nodes.find(n => n.id === "a2")!.body = "새로운 본문";
  changed.edges = changed.edges.filter(e => e.source !== "a1" && e.target !== "a1");
  const result = pasteNodeClipboard(changed, captured, "b", { makeId: ids("snapshot") });
  const copies = result.ids.map(id => result.document.nodes.find(n => n.id === id)!);
  assert.deepEqual(copies.map(content), captured.nodes.map(content));
  assert.equal(documentSchema.safeParse(result.document).success, true);
});

test("cut paste moves latest content and internal edges, removes boundary edges, and undoes atomically", () => {
  const document = fixture();
  const captured = clipboard(document);
  const edited = document.nodes.find(n => n.id === "a1")!;
  edited.title = "잘라내기 후 수정한 제목";
  edited.body = "잘라내기 후 수정한 본문";
  edited.tags = ["최신 태그"];
  document.edges.find(e => e.id === "inside")!.relation = "반박";
  document.edges.push({ id: "new-boundary", source: "a1", target: "a3", relation: "관련" });
  const before = structuredClone(document);
  const result = pasteNodeClipboard(document, captured, "b", {
    cut: true, anchor: { x: 700, y: 800 }, now: pastedAt,
    makeId: () => { throw Error("cut must preserve IDs"); },
  });
  assert.deepEqual(document, before);
  assert.deepEqual(new Set(result.ids), new Set(["a1", "a2"]));
  assert.equal(result.removedEdges, 3);
  assert.equal(result.document.nodes.length, document.nodes.length);
  for (const id of result.ids) {
    const moved = result.document.nodes.find(n => n.id === id)!;
    const source = document.nodes.find(n => n.id === id)!;
    assert.deepEqual(content(moved), content(source));
    assert.equal(moved.mapId, "b");
    assert.equal(moved.createdAt, source.createdAt);
  }
  assert.deepEqual(result.document.edges, document.edges.filter(e => ["inside", "unrelated"].includes(e.id)));
  assert.deepEqual(result.document.nodes.find(n => n.id === "a3"), document.nodes.find(n => n.id === "a3"));
  assert.equal(documentSchema.safeParse(result.document).success, true);
  const history = new DocumentHistory<Workspace>();
  history.record(before, result.document);
  assert.equal(history.past.length, 1);
  assert.deepEqual(history.undo(result.document), before);
  assert.deepEqual(history.redo(before), result.document);
});

test("same-map cut paste keeps all internal and boundary connections", () => {
  const document = fixture();
  const result = pasteNodeClipboard(document, clipboard(document), "a", { cut: true, anchor: { x: 500, y: 600 }, now: pastedAt });
  assert.equal(result.removedEdges, 0);
  assert.deepEqual(result.document.edges, document.edges);
  assert.deepEqual(result.document.nodes.find(n => n.id === "a1")!.position, { x: 500, y: 600 });
  assert.deepEqual(result.document.nodes.find(n => n.id === "a2")!.position, { x: 700, y: 700 });
  assert.equal(documentSchema.safeParse(result.document).success, true);
});

test("missing destinations and stale cut sources fail without mutating graph or clipboard", () => {
  for (const scenario of ["missing-target", "missing-source", "moved-source", "replaced-source"] as const) {
    const document = fixture();
    const captured = clipboard(document);
    if (scenario === "missing-target") document.maps = document.maps.filter(m => m.id !== "b");
    if (scenario === "missing-target") {
      document.nodes = document.nodes.filter(n => n.mapId !== "b");
      document.edges = document.edges.filter(e => e.id !== "unrelated");
    }
    if (scenario === "missing-source") document.nodes = document.nodes.filter(n => n.id !== "a1");
    if (scenario === "moved-source") document.nodes.find(n => n.id === "a1")!.mapId = "b";
    if (scenario === "missing-source" || scenario === "moved-source") document.edges = document.edges.filter(e => e.source !== "a1" && e.target !== "a1");
    if (scenario === "replaced-source") document.nodes.find(n => n.id === "a1")!.createdAt = pastedAt;
    assert.equal(documentSchema.safeParse(document).success, true);
    const before = structuredClone(document);
    const savedClipboard = structuredClone(captured);
    assert.throws(() => pasteNodeClipboard(document, captured, "b", { cut: true, makeId: ids("invalid") }), scenario);
    assert.deepEqual(document, before, scenario);
    assert.deepEqual(captured, savedClipboard, scenario);
  }
  const document = fixture();
  assert.throws(() => pasteNodeClipboard(document, clipboard(document), "missing", { makeId: ids("missing") }));
});

test("copy paste rejects workspace node limit overflow atomically", () => {
  const document = fixture();
  const captured = clipboard(document);
  document.nodes = Array.from({ length: 2000 }, (_, index) => node(`existing-${index}`, "a", 0, 0));
  document.edges = [];
  assert.equal(documentSchema.safeParse(document).success, true);
  const before = structuredClone(document);
  assert.throws(() => pasteNodeClipboard(document, captured, "b", { makeId: ids("overflow") }));
  assert.deepEqual(document, before);
});

test("group placement clamps translation while preserving relative positions", () => {
  const document = fixture();
  const captured = clipboard(document);
  const result = pasteNodeClipboard(document, captured, "b", { anchor: { x: 100000, y: 100000 }, makeId: ids("clamped") });
  const copies = result.ids.map(id => result.document.nodes.find(n => n.id === id)!);
  assert.deepEqual(copies.map(n => n.position), [{ x: 99800, y: 99900 }, { x: 100000, y: 100000 }]);
  assert.equal(documentSchema.safeParse(result.document).success, true);
});
