import { test } from "node:test";
import assert from "node:assert/strict";
import { exampleWorkspace } from "../lib/model.ts";
import { captureNodeClipboard, pasteNodeClipboard } from "../lib/node-clipboard.ts";
import { NodeClipboardSession } from "../lib/node-clipboard-session.ts";

function fixture() {
  const workspace = exampleWorkspace();
  workspace.maps.push({ id: "destination", name: "다른 맵", description: "", folderId: null });
  return workspace;
}

test("memory-only copy preserves captured content and advances paste offsets for repeated copies", () => {
  const workspace = fixture(), before = structuredClone(workspace);
  const session = new NodeClipboardSession(1);
  const captured = session.capture(workspace, [workspace.nodes[0].id], 1, false, "memory-copy")!;
  assert.deepEqual(workspace, before);
  assert.equal(session.memory, captured);
  assert.deepEqual(session.cutIds, []);
  workspace.nodes[0].title = "복사 후 바뀐 원본";
  const first = session.preparePaste(session.memory!, 1);
  assert.equal(first.cut, false);
  assert.equal(first.offset, 0);
  const copied = pasteNodeClipboard(workspace, first.clipboard, "destination", { makeId: () => "copy-1" });
  session.didPaste(first);
  assert.equal(copied.document.nodes.at(-1)!.title, before.nodes[0].title);
  const second = session.preparePaste(session.memory!, 1);
  assert.equal(second.offset, 35);
  const copiedAgain = pasteNodeClipboard(copied.document, second.clipboard, "destination", { makeId: () => "copy-2" });
  session.didPaste(second);
  assert.equal(copiedAgain.document.nodes.length, before.nodes.length + 2);
  assert.notEqual(copiedAgain.document.nodes.at(-1)!.id, copiedAgain.document.nodes.at(-2)!.id);
  assert.equal(session.preparePaste(session.memory!, 1).offset, 70);
});

test("cut never changes the original until a successful paste and survives a failed destination", () => {
  const workspace = fixture(), before = structuredClone(workspace), id = workspace.nodes[0].id;
  const session = new NodeClipboardSession(4);
  session.capture(workspace, [id], 4, true, "deferred-cut");
  assert.deepEqual(workspace, before);
  assert.deepEqual(session.cutIds, [id]);
  const failed = session.preparePaste(session.memory!, 4);
  assert.throws(() => pasteNodeClipboard(workspace, failed.clipboard, "missing", { cut: failed.cut }));
  assert.deepEqual(workspace, before);
  assert.deepEqual(session.cutIds, [id]);
  const retry = session.preparePaste(session.memory!, 4);
  assert.equal(retry.cut, true);
  assert.equal(retry.offset, 0);
  const moved = pasteNodeClipboard(workspace, retry.clipboard, "destination", { cut: retry.cut });
  session.didPaste(retry);
  assert.equal(moved.document.nodes.length, workspace.nodes.length);
  assert.equal(moved.document.nodes.find(node => node.id === id)!.mapId, "destination");
  assert.deepEqual(session.cutIds, []);
  assert.equal(session.preparePaste(session.memory!, 4).cut, false);
});

test("workspace generation changes clear private memory and reject old asynchronous operations", () => {
  const workspace = fixture(), session = new NodeClipboardSession(2);
  const captured = session.capture(workspace, [workspace.nodes[0].id], 2, true)!;
  const prepared = session.preparePaste(captured, 2);
  session.setGeneration(3);
  assert.equal(session.memory, null);
  assert.deepEqual(session.cutIds, []);
  assert.throws(() => session.preparePaste(captured, 2), /작업실이 교체/);
  assert.throws(() => session.capture(workspace, [workspace.nodes[0].id], 2, false), /작업실이 교체/);
  assert.throws(() => session.didPaste(prepared), /작업실이 교체/);
  assert.equal(session.memory, null);
  const fresh = session.capture(workspace, [workspace.nodes[1].id], 3, false)!;
  assert.equal(session.preparePaste(fresh, 3).offset, 0);
});

test("ordinary rerenders preserve the clipboard, while a new copy cancels pending cut", () => {
  const workspace = fixture(), session = new NodeClipboardSession(6);
  const cutting = session.capture(workspace, [workspace.nodes[0].id], 6, true)!;
  session.setGeneration(6);
  assert.equal(session.memory, cutting);
  assert.deepEqual(session.cutIds, [workspace.nodes[0].id]);
  const copied = session.capture(workspace, [workspace.nodes[1].id], 6, false)!;
  assert.equal(session.memory, copied);
  assert.deepEqual(session.cutIds, []);
  assert.equal(session.preparePaste(cutting, 6).cut, false);
  assert.equal(session.capture(workspace, ["missing"], 6, false), null);
  assert.equal(session.memory, copied);
});

test("external node paste resets position count without accidentally cutting other selected nodes", () => {
  const workspace = fixture(), session = new NodeClipboardSession(1);
  session.capture(workspace, [workspace.nodes[0].id], 1, true, "local-cut");
  const external = captureNodeClipboard(workspace, [workspace.nodes[1].id], "external-copy")!;
  const prepared = session.preparePaste(external, 1);
  assert.equal(prepared.cut, false);
  assert.equal(prepared.offset, 0);
  session.didPaste(prepared);
  assert.deepEqual(session.cutIds, []);
  assert.equal(session.memory, external);
  assert.equal(session.preparePaste(external, 1).offset, 35);
  session.clear();
  assert.equal(session.memory, null);
  assert.deepEqual(session.cutIds, []);
});
