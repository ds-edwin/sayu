import { test } from "node:test";
import assert from "node:assert/strict";
import { copyMap } from "../lib/graph-operations.ts";
import { DocumentHistory } from "../lib/history.ts";
import { documentSchema, type KnowledgeNode, type Workspace } from "../lib/model.ts";

const createdAt = "2026-10-01T00:00:00.000Z";
const copiedAt = "2026-11-19T00:00:00.000Z";

function ids(prefix = "copy") {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function node(id: string, mapId: string | null, x: number, y: number): KnowledgeNode {
  return {
    id, mapId, title: `${id}의 원래 제목`,
    body: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `${id}의 본문`, marks: [{ type: "bold" }] }] }] }),
    kind: "질문", confidence: "탐색 중", tags: ["보존", id],
    source: `https://example.com/references/${id}`,
    position: { x, y }, createdAt, updatedAt: "2026-10-02T00:00:00.000Z",
  };
}

function fixture(): Workspace {
  const document: Workspace = {
    folders: [
      { id: "parent", name: "상위 폴더", parentId: null },
      { id: "nested", name: "하위 폴더", parentId: "parent" },
    ],
    maps: [
      { id: "source", name: "원본 맵", description: "설명도 그대로 보존합니다.", folderId: "nested" },
      { id: "other", name: "다른 맵", description: "관계없는 내용", folderId: null },
    ],
    nodes: [
      node("a1", "source", -100000, 125.5),
      node("a2", "source", 450.25, 100000),
      node("a3", "source", -30, -240),
      node("b1", "other", 0, 0),
      node("b2", "other", 300, 0),
      node("inbox", null, 77, 88),
    ],
    edges: [
      { id: "supports", source: "a1", target: "a2", relation: "지지" },
      { id: "opposes", source: "a3", target: "a1", relation: "반박" },
      { id: "unrelated", source: "b1", target: "b2", relation: "구체화" },
    ],
  };
  Object.assign(document.nodes[1], { kind: "근거", confidence: "정리됨", source: "" });
  Object.assign(document.nodes[2], { kind: "메모", confidence: "검토 전", tags: [], body: "" });
  return document;
}

function assertReadableFailure(action: () => unknown) {
  assert.throws(action, (problem: unknown) => problem instanceof Error && /[가-힣]/.test(problem.message));
}

test("map copy preserves nested-folder metadata and exact node content and positions with fresh graph IDs", () => {
  const original = fixture();
  const before = structuredClone(original);
  assert.equal(documentSchema.safeParse(original).success, true);
  const result = copyMap(original, "source", ids(), copiedAt);
  const copiedMap = result.document.maps.find(map => map.id === result.mapId);
  assert.ok(copiedMap);
  assert.notEqual(result.mapId, "source");
  assert.deepEqual(copiedMap, {
    ...original.maps[0], id: result.mapId, name: "원본 맵 (복사)",
  });

  const sources = original.nodes.filter(value => value.mapId === "source");
  const copies = result.document.nodes.filter(value => value.mapId === result.mapId);
  assert.equal(copies.length, sources.length);
  const remap = new Map<string, string>();
  for (const source of sources) {
    const copy = copies.find(value => value.title === source.title);
    assert.ok(copy);
    assert.ok(!original.nodes.some(value => value.id === copy.id));
    assert.deepEqual(copy, {
      ...source, id: copy.id, mapId: result.mapId, createdAt: copiedAt, updatedAt: copiedAt,
    });
    remap.set(source.id, copy.id);
  }
  assert.equal(new Set(copies.map(value => value.id)).size, sources.length);
  const copiedEdges = result.document.edges.filter(edge => !original.edges.some(value => value.id === edge.id));
  assert.equal(copiedEdges.length, 2);
  assert.equal(new Set(copiedEdges.map(value => value.id)).size, 2);
  for (const source of original.edges.filter(edge => remap.has(edge.source) && remap.has(edge.target))) {
    const copy = copiedEdges.find(edge => edge.source === remap.get(source.source) && edge.target === remap.get(source.target));
    assert.ok(copy);
    assert.deepEqual(copy, { ...source, id: copy.id, source: remap.get(source.source), target: remap.get(source.target) });
  }
  assert.equal(result.document.maps.length, original.maps.length + 1);
  assert.equal(result.document.nodes.length, original.nodes.length + sources.length);
  assert.equal(result.document.edges.length, original.edges.length + 2);
  assert.deepEqual(result.document.folders, original.folders);
  for (const map of original.maps) assert.deepEqual(result.document.maps.find(value => value.id === map.id), map);
  for (const value of original.nodes) assert.deepEqual(result.document.nodes.find(copy => copy.id === value.id), value);
  for (const edge of original.edges) assert.deepEqual(result.document.edges.find(copy => copy.id === edge.id), edge);
  assert.deepEqual(original, before);
  assert.equal(documentSchema.safeParse(result.document).success, true);
});

test("repeated copies, including a copy of a copy, use distinct names and fresh IDs", () => {
  const original = fixture();
  const makeId = ids("repeat");
  const first = copyMap(original, "source", makeId, copiedAt);
  const firstSnapshot = structuredClone(first.document);
  const second = copyMap(first.document, first.mapId, makeId, copiedAt);
  const third = copyMap(second.document, "source", makeId, copiedAt);
  assert.deepEqual([first, second, third].map(result => result.document.maps.find(map => map.id === result.mapId)!.name), [
    "원본 맵 (복사)", "원본 맵 (복사 2)", "원본 맵 (복사 3)",
  ]);
  assert.equal(new Set([first.mapId, second.mapId, third.mapId]).size, 3);
  assert.equal(new Set(third.document.maps.map(map => map.id)).size, third.document.maps.length);
  assert.equal(new Set(third.document.nodes.map(value => value.id)).size, third.document.nodes.length);
  assert.equal(new Set(third.document.edges.map(edge => edge.id)).size, third.document.edges.length);
  assert.deepEqual(first.document, firstSnapshot);
  assert.equal(documentSchema.safeParse(third.document).success, true);
});

test("100-character map names keep visible copy suffixes and remain unique after truncation", () => {
  for (const name of ["가".repeat(100), "😀".repeat(50)]) {
    const original = fixture();
    original.maps[0].name = name;
    const makeId = ids("long");
    const first = copyMap(original, "source", makeId, copiedAt);
    const second = copyMap(first.document, "source", makeId, copiedAt);
    const firstName = first.document.maps.find(map => map.id === first.mapId)!.name;
    const secondName = second.document.maps.find(map => map.id === second.mapId)!.name;
    assert.ok(firstName.endsWith(" (복사)"));
    assert.ok(secondName.endsWith(" (복사 2)"));
    assert.ok(firstName.length <= 100);
    assert.ok(secondName.length <= 100);
    assert.notEqual(firstName, secondName);
    for (const copiedName of [firstName, secondName]) {
      const stem = copiedName.replace(/ \(복사(?: \d+)?\)$/, "");
      assert.ok([...stem].every(character => character === [...name][0]), "Truncation preserves complete Unicode characters");
    }
    assert.equal(new Set(second.document.maps.map(map => map.name)).size, second.document.maps.length);
    assert.equal(original.maps[0].name, name);
    assert.equal(documentSchema.safeParse(second.document).success, true);
  }
});

test("copying an empty map creates only a map and preserves the rest of the workspace", () => {
  const original = fixture();
  original.maps.push({ id: "empty", name: "빈 맵", description: "빈 맵 설명", folderId: "nested" });
  const before = structuredClone(original);
  const result = copyMap(original, "empty", ids("empty"), copiedAt);
  assert.deepEqual(result.document.maps.find(map => map.id === result.mapId), {
    id: result.mapId, name: "빈 맵 (복사)", description: "빈 맵 설명", folderId: "nested",
  });
  assert.deepEqual(result.document.nodes, original.nodes);
  assert.deepEqual(result.document.edges, original.edges);
  assert.deepEqual(result.document.folders, original.folders);
  assert.deepEqual(original, before);
  assert.equal(documentSchema.safeParse(result.document).success, true);
});

test("a missing source fails with a readable message and leaves the workspace intact", () => {
  const original = fixture();
  const before = structuredClone(original);
  assertReadableFailure(() => copyMap(original, "missing", ids(), copiedAt));
  assert.deepEqual(original, before);
});

test("the 100th map can be created, and copying beyond that limit fails atomically", () => {
  const original = fixture();
  for (let index = original.maps.length; index < 99; index += 1) {
    original.maps.push({ id: `existing-map-${index}`, name: `기존 맵 ${index}`, description: "", folderId: null });
  }
  assert.equal(documentSchema.safeParse(original).success, true);
  const makeId = ids("map-limit");
  const atLimit = copyMap(original, "source", makeId, copiedAt).document;
  assert.equal(atLimit.maps.length, 100);
  assert.equal(documentSchema.safeParse(atLimit).success, true);
  const before = structuredClone(atLimit);
  assertReadableFailure(() => copyMap(atLimit, "source", makeId, copiedAt));
  assert.deepEqual(atLimit, before);
});

test("copying beyond the 2,000-node limit fails without partial maps, nodes, or edges", () => {
  const original = fixture();
  for (let index = original.nodes.length; index < 2000; index += 1) {
    original.nodes.push(node(`existing-${index}`, "other", 0, 0));
  }
  assert.equal(documentSchema.safeParse(original).success, true);
  const before = structuredClone(original);
  assertReadableFailure(() => copyMap(original, "source", ids("node-limit"), copiedAt));
  assert.deepEqual(original, before);
});

test("invalid generated IDs are rejected before committing any copied graph data", () => {
  const original = fixture();
  const before = structuredClone(original);
  assertReadableFailure(() => copyMap(original, "source", () => "source", copiedAt));
  assert.deepEqual(original, before);
  assert.equal(documentSchema.safeParse(original).success, true);
});

test("one history operation removes and restores the entire copied map and graph", () => {
  const original = fixture();
  const after = copyMap(original, "source", ids("history"), copiedAt).document;
  const history = new DocumentHistory<Workspace>();
  assert.equal(history.record(original, after), true);
  assert.equal(history.past.length, 1);
  assert.deepEqual(history.undo(after), original);
  assert.equal(history.past.length, 0);
  assert.deepEqual(history.redo(original), after);
  assert.equal(history.future.length, 0);
  assert.equal(documentSchema.safeParse(after).success, true);
});
