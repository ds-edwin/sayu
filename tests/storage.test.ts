import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { blankWorkspace, exampleWorkspace } from "../lib/model.ts";
import {
  getSetting,
  writeLocal,
  parsePortable,
  type LocalWorkspace,
  archiveCurrentWorkspace,
  LocalRevisionConflict,
} from "../lib/local-store.ts";
import {
  findHeads,
  snapshotName,
  decideSync,
  parseSnapshot,
} from "../lib/sync-graph.ts";
Object.assign(globalThis, { window: new EventTarget() });
const a = "10000000-0000-4000-8000-000000000001",
  b = "10000000-0000-4000-8000-000000000002",
  c = "10000000-0000-4000-8000-000000000003",
  d = "10000000-0000-4000-8000-000000000004";
test("local revision guard prevents a stale tab from overwriting saved changes", async () => {
  const initial = blankWorkspace();
  const rev = await writeLocal(initial, 0);
  const updated = exampleWorkspace();
  assert.equal(await writeLocal(updated, rev), rev + 1);
  await assert.rejects(writeLocal(initial, rev), LocalRevisionConflict);
  assert.deepEqual(
    (await getSetting<LocalWorkspace>("workspace"))?.document,
    updated,
  );
  await archiveCurrentWorkspace();
  assert.deepEqual((await getSetting<{ document: unknown }[]>("recovery"))?.[0].document, updated);
  assert.equal((await getSetting<LocalWorkspace>("workspace"))?.revision, rev + 1);
  await writeLocal(initial, rev + 1, true);
  const recovery = await getSetting<{ document: unknown }[]>("recovery");
  assert.deepEqual(recovery?.[0].document, updated);
});
test("portable imports accept original JSON and backups; reject unsupported versions", () => {
  const document = exampleWorkspace();
  assert.deepEqual(parsePortable(document), document);
  assert.deepEqual(
    parsePortable({ format: "sayu-workspace", version: 1, document }),
    document,
  );
  assert.throws(() =>
    parsePortable({ format: "sayu-workspace", version: 2, document }),
  );
});
test("empty and whitespace title drafts survive local save, backup and remote snapshots", async () => {
  const document = exampleWorkspace();
  document.nodes[0].title = "";
  document.nodes[1].title = "  \n  ";
  const before = structuredClone(document);
  const revision = (await getSetting<LocalWorkspace>("workspace"))!.revision;
  await writeLocal(document, revision);
  assert.deepEqual((await getSetting<LocalWorkspace>("workspace"))!.document, before);
  assert.deepEqual(parsePortable({ format: "sayu-workspace", version: 1, document }), before);
  assert.deepEqual(parseSnapshot({ format: "sayu-snapshot", version: 1, id: a, parents: [],
    createdAt: new Date().toISOString(), document }, a).document, before);
  assert.deepEqual(document, before, "validation must not mutate the editable draft");

  document.nodes[0].title = "제목 다시 입력";
  await writeLocal(document, revision + 1);
  assert.deepEqual((await getSetting<LocalWorkspace>("workspace"))!.document, document);
});
test("invalid data leaves the saved revision intact and a corrected draft can be retried", async () => {
  const saved = (await getSetting<LocalWorkspace>("workspace"))!;
  const draft = structuredClone(saved.document);
  draft.nodes[0].title = "a".repeat(201);
  await assert.rejects(writeLocal(draft, saved.revision), error => {
    assert.ok(!(error instanceof LocalRevisionConflict));
    return true;
  });
  assert.deepEqual(await getSetting("workspace"), saved);
  draft.nodes[0].title = "수정 후 저장";
  await writeLocal(draft, saved.revision);
  assert.deepEqual((await getSetting<LocalWorkspace>("workspace"))!.document, draft);
});
test("immutable remote history preserves concurrent branches and resolves with a new version", () => {
  const names = [
    snapshotName(a, []),
    snapshotName(b, [a]),
    snapshotName(c, [a]),
  ];
  assert.deepEqual(
    findHeads(names).map((s) => s.id),
    [b, c],
  );
  assert.deepEqual(
    findHeads([...names, snapshotName(d, [b, c])]).map((s) => s.id),
    [d],
  );
  assert.throws(() => findHeads([snapshotName(b, [a])]), /기록 일부/);
  assert.throws(() =>
    parseSnapshot(
      { format: "sayu-snapshot", version: 1, id: a, parents: [], document: {} },
      a,
    ),
  );
});
test("sync decisions never silently replace independent local and remote edits", () => {
  assert.equal(decideSync("local", "base", a, [b], "remote"), "conflict");
  assert.equal(decideSync("base", "base", a, [b], "remote"), "pull");
  assert.equal(decideSync("local", "base", a, [a], "base"), "push");
  assert.equal(decideSync("same", undefined, undefined, [a], "same"), "same");
  assert.equal(
    decideSync("local", undefined, undefined, [a], "remote"),
    "conflict",
  );
  assert.equal(decideSync("local", "base", a, [b, c], "remote"), "conflict");
  assert.throws(() => decideSync("local", "base", a, []));
});
