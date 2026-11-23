import test from "node:test";
import assert from "node:assert/strict";
import { createFirebaseSyncController, type FirebaseSyncState } from "../components/use-firebase-sync.ts";
import { blankWorkspace, exampleWorkspace, type Workspace } from "../lib/model.ts";
import { FirebaseHeadConflict, type FirebaseBaseline, type FirebaseVersion } from "../lib/firebase-protocol.ts";
import { stampWorkspace } from "../lib/firebase-merge.ts";

function workspace(name: string): Workspace {
  const document = blankWorkspace();
  document.maps[0].name = name;
  return document;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(initial: Workspace, cloud?: Workspace) {
  let local = structuredClone(initial);
  let current = true;
  let sequence = 0;
  let baseline: FirebaseBaseline | undefined;
  let head: FirebaseVersion | null = null;
  let beforeHead: (() => Promise<void>) | undefined;
  let beforeCommit: (() => void) | undefined;
  let beforeReplace: (() => void) | undefined;
  let failBaseline = false;
  const versions = new Map<string, FirebaseVersion>();
  const archived: Workspace[] = [];
  const committedParents: Array<string | null> = [];
  const states: FirebaseSyncState[] = [];
  function publish(document: Workspace) {
    const version: FirebaseVersion = {
      id: `10000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      parentId: head?.id ?? null, createdAt: "2026-11-23T00:00:00.000Z",
      sha256: String(sequence).padStart(64, "0"), document: structuredClone(document),
    };
    versions.set(version.id, version);
    head = version;
    return version;
  }
  if (cloud) publish(cloud);
  const controller = createFirebaseSyncController({
    engine: {
      async getHead() {
        await beforeHead?.();
        return head ? { version: 1, headId: head.id, sha256: head.sha256, updatedAt: head.createdAt } : null;
      },
      async readVersion(id) { return structuredClone(versions.get(id)!); },
      async commit(document, expected) {
        beforeCommit?.();
        if ((head?.id ?? null) !== expected) throw new FirebaseHeadConflict(expected, head?.id ?? null, "staged-version");
        committedParents.push(expected);
        return publish(document);
      },
      watchHead() { return () => {}; },
    },
    async flush() { return structuredClone(local); },
    async replace(document, expected, options) {
      beforeReplace?.();
      assert.equal(options?.source, "remote", "cloud changes must retain their original edit stamps");
      assert.equal(expected, JSON.stringify(local), "a pull must compare against the flushed local snapshot");
      archived.push(structuredClone(local));
      local = structuredClone(document);
    },
    async readBaseline() { return structuredClone(baseline); },
    async writeBaseline(value) {
      if (failBaseline) throw Error("기기 동기화 기록 저장 실패");
      baseline = structuredClone(value);
    },
    isCurrent: () => current,
    isOnline: () => true,
    onChange: value => states.push(value),
  });
  return {
    controller, archived, committedParents, states, versions, publish,
    get local() { return local; },
    set local(value: Workspace) { local = value; },
    get head() { return head; },
    get baseline() { return baseline; },
    set baseline(value: FirebaseBaseline | undefined) { baseline = value; },
    set current(value: boolean) { current = value; },
    set beforeHead(value: (() => Promise<void>) | undefined) { beforeHead = value; },
    set beforeCommit(value: (() => void) | undefined) { beforeCommit = value; },
    set beforeReplace(value: (() => void) | undefined) { beforeReplace = value; },
    set failBaseline(value: boolean) { failBaseline = value; },
  };
}

test("first login preserves different local/cloud data until an explicit choice", async () => {
  const f = fixture(workspace("기존 PC 데이터"), workspace("iPad 데이터"));
  const originalHead = f.head!;
  await f.controller.sync();
  assert.equal(f.controller.state.status, "conflict");
  assert.deepEqual(f.controller.state.conflict?.local, f.local);
  assert.deepEqual(f.controller.state.conflict?.remote.document, originalHead.document);
  assert.equal(f.versions.size, 1);
  assert.equal(f.archived.length, 0);
  assert.equal(f.baseline, undefined);
  await f.controller.resolve("local");
  assert.equal(f.controller.state.status, "synced");
  assert.deepEqual(f.committedParents, [originalHead.id]);
  assert.deepEqual(f.head!.document, f.local);
  assert.equal(f.versions.has(originalHead.id), true);
  assert.equal(f.baseline!.id, f.head!.id);
});

test("a fresh device pulls, then local edits commit against the last synchronized version", async () => {
  const f = fixture(blankWorkspace(), workspace("클라우드 작업실"));
  const firstHead = f.head!;
  await f.controller.sync();
  assert.equal(f.controller.state.status, "synced");
  assert.deepEqual(f.local, firstHead.document);
  assert.deepEqual(f.archived, [blankWorkspace()]);
  assert.equal(f.committedParents.length, 0);
  f.local = workspace("PC에서 수정");
  await f.controller.sync();
  assert.deepEqual(f.committedParents, [firstHead.id]);
  assert.deepEqual(f.baseline!.document, f.local);
});

test("concurrent edits to the same item automatically keep its latest edit and archive the previous local copy", async () => {
  const f = fixture(workspace("공통 원본"), workspace("공통 원본"));
  await f.controller.sync();
  f.local = stampWorkspace(f.local, workspace("PC 오프라인 편집"), "pc", 100);
  f.publish(stampWorkspace(f.baseline!.document, workspace("iPad 오프라인 편집"), "ipad", 200));
  const savedLocal = structuredClone(f.local);
  await f.controller.sync();
  assert.equal(f.controller.state.status, "synced");
  assert.equal(f.controller.state.conflict, null);
  assert.deepEqual(f.archived, [savedLocal]);
  assert.deepEqual(f.local, f.head!.document);
  assert.equal(f.local.maps[0].name, "iPad 오프라인 편집");
});

test("a stale conflict choice refreshes changed cloud/local copies without replacing either", async () => {
  const f = fixture(workspace("기존 기기"), workspace("클라우드 A"));
  await f.controller.sync();
  f.publish(workspace("클라우드 B"));
  await f.controller.resolve("local");
  assert.equal(f.controller.state.status, "conflict");
  assert.deepEqual(f.controller.state.conflict!.remote.document, workspace("클라우드 B"));
  assert.equal(f.committedParents.length, 0);
  f.local = workspace("선택하는 동안 추가 편집");
  await f.controller.resolve("remote");
  assert.equal(f.controller.state.status, "conflict");
  assert.deepEqual(f.controller.state.conflict!.local, f.local);
  assert.equal(f.archived.length, 0);
  await f.controller.resolve("remote");
  assert.equal(f.controller.state.status, "synced");
  assert.deepEqual(f.archived, [workspace("선택하는 동안 추가 편집")]);
});

test("a CAS race automatically merges independent node edits and retries against the winning head", async () => {
  const common = exampleWorkspace();
  const f = fixture(common, common);
  await f.controller.sync();
  const local = structuredClone(common), other = structuredClone(common);
  local.nodes[0].title = "내 수정";
  other.nodes[1].title = "다른 노드 수정";
  f.local = stampWorkspace(common, local, "pc", 100);
  f.beforeCommit = () => {
    f.beforeCommit = undefined;
    f.publish(stampWorkspace(common, other, "ipad", 200));
  };
  await f.controller.sync();
  assert.equal(f.controller.state.status, "synced");
  assert.equal(f.controller.state.conflict, null);
  assert.equal(f.local.nodes.find(node => node.id === common.nodes[0].id)!.title, "내 수정");
  assert.equal(f.local.nodes.find(node => node.id === common.nodes[1].id)!.title, "다른 노드 수정");
  assert.deepEqual(f.local, f.head!.document);
  assert.equal(f.baseline!.id, f.head!.id);
});

test("account changes during a remote read stop local replacement and baseline writes", async () => {
  const f = fixture(blankWorkspace(), workspace("이전 계정 데이터"));
  const started = deferred(), finish = deferred();
  f.beforeHead = async () => { started.resolve(); await finish.promise; };
  const syncing = f.controller.sync();
  await started.promise;
  const stateCount = f.states.length;
  f.current = false;
  finish.resolve();
  await syncing;
  assert.deepEqual(f.local, blankWorkspace());
  assert.equal(f.archived.length, 0);
  assert.equal(f.baseline, undefined);
  assert.equal(f.states.length, stateCount, "an old account cannot publish status into the new session");
});

test("editing during a first cloud download preserves the draft and requests only migration confirmation", async () => {
  const f = fixture(blankWorkspace(), workspace("클라우드"));
  const started = deferred(), finish = deferred();
  f.beforeHead = async () => { started.resolve(); await finish.promise; };
  const syncing = f.controller.sync();
  await started.promise;
  f.local = workspace("다운로드 도중 편집");
  finish.resolve();
  await syncing;
  assert.equal(f.controller.state.status, "conflict");
  assert.deepEqual(f.local, workspace("다운로드 도중 편집"));
  assert.equal(f.archived.length, 0);
  assert.equal(f.baseline, undefined);
});

test("an edit racing with a normal remote replacement is re-read and automatically merged", async () => {
  const common = exampleWorkspace(), remote = structuredClone(common), local = structuredClone(common);
  const f = fixture(common, common);
  await f.controller.sync();
  remote.nodes[0].title = "원격 새 제목";
  local.nodes[1].body = "불러오는 중 입력한 본문";
  f.publish(stampWorkspace(common, remote, "ipad", 100));
  f.beforeReplace = () => {
    f.beforeReplace = undefined;
    f.local = stampWorkspace(f.local, local, "pc", 200);
  };
  await f.controller.sync();
  assert.equal(f.controller.state.status, "synced");
  assert.equal(f.controller.state.conflict, null);
  assert.equal(f.local.nodes.find(node => node.id === common.nodes[0].id)!.title, "원격 새 제목");
  assert.equal(f.local.nodes.find(node => node.id === common.nodes[1].id)!.body, "불러오는 중 입력한 본문");
  assert.deepEqual(f.head!.document, f.local);
});

test("edits made during an upload are saved in the following version without a confirmation dialog", async () => {
  const common = workspace("공통"), f = fixture(common, common);
  await f.controller.sync();
  f.local = stampWorkspace(common, workspace("업로드 시작"), "pc", 100);
  f.beforeCommit = () => {
    f.beforeCommit = undefined;
    f.local = stampWorkspace(f.local, workspace("업로드 도중 추가 편집"), "pc", 200);
  };
  await f.controller.sync();
  assert.equal(f.controller.state.status, "synced");
  assert.equal(f.controller.state.conflict, null);
  assert.equal(f.head!.document.maps[0].name, "업로드 도중 추가 편집");
  assert.equal(f.committedParents.length, 2);
});

test("continuous CAS races yield a bounded automatic retry without opening a conflict dialog", async () => {
  const common = exampleWorkspace(), local = structuredClone(common), f = fixture(common, common);
  await f.controller.sync();
  local.nodes[0].title = "계속 보존할 로컬 수정";
  f.local = stampWorkspace(common, local, "pc", 100);
  let races = 0;
  f.beforeCommit = () => {
    const remote = structuredClone(common);
    remote.nodes[1].title = `동시 원격 수정 ${++races}`;
    f.publish(stampWorkspace(common, remote, "ipad", 200 + races));
  };
  await f.controller.sync();
  assert.equal(races, 4);
  assert.equal(f.controller.retryPending, true);
  assert.equal(f.controller.state.status, "syncing");
  assert.equal(f.controller.state.error, null);
  assert.equal(f.controller.state.conflict, null);
  f.beforeCommit = undefined;
  await f.controller.sync();
  assert.equal(f.controller.retryPending, false);
  assert.equal(f.controller.state.status, "synced");
  assert.equal(f.head!.document.nodes.find(node => node.id === common.nodes[0].id)!.title, "계속 보존할 로컬 수정");
  assert.equal(f.head!.document.nodes.find(node => node.id === common.nodes[1].id)!.title, "동시 원격 수정 4");
});

test("baseline storage failure preserves a committed snapshot and retry does not republish it", async () => {
  const f = fixture(workspace("원본"), workspace("원본"));
  await f.controller.sync();
  f.local = workspace("변경");
  f.failBaseline = true;
  await f.controller.sync();
  assert.equal(f.controller.state.status, "error");
  assert.deepEqual(f.head!.document, f.local);
  assert.equal(f.committedParents.length, 1);
  f.failBaseline = false;
  await f.controller.sync();
  assert.equal(f.controller.state.status, "synced");
  assert.equal(f.committedParents.length, 1);
  assert.equal(f.baseline!.id, f.head!.id);
});
