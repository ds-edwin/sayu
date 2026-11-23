"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FirebaseServices } from "../lib/firebase-client.ts";
import { documentSchema, type Workspace } from "../lib/model.ts";
import { exportFile, getSetting, setSetting } from "../lib/local-store.ts";
import { mergeFirebaseWorkspaces, stampWorkspace } from "../lib/firebase-merge.ts";
import {
  createFirestoreWorkspace, decideFirebaseSync, firebaseVersionId, firebaseWorkspaceSignature,
  FirebaseHeadConflict, FirebaseSessionChanged, type FirebaseBaseline, type FirebaseVersion,
} from "../lib/firebase-sync.ts";

export type FirebaseSyncStatus = "idle" | "syncing" | "synced" | "offline" | "conflict" | "error";
export type FirebaseSyncConflict = { local: Workspace; remote: FirebaseVersion };
export type FirebaseSyncState = {
  status: FirebaseSyncStatus;
  error: string | null;
  conflict: FirebaseSyncConflict | null;
};
type Choice = "local" | "remote";
type WorkspaceActions = {
  flush: () => Promise<Workspace>;
  replace: (document: Workspace, expected?: string, options?: { source?: "local" | "remote" }) => Promise<void>;
};
type SyncProps = WorkspaceActions & {
  ready: boolean;
  scope: string | undefined;
  services: FirebaseServices | null;
  uid: string | null;
};
type Engine = ReturnType<typeof createFirestoreWorkspace>;
const initialState: FirebaseSyncState = { status: "idle", error: null, conflict: null };

function syncError(problem: unknown) {
  const code = String((problem as { code?: unknown })?.code ?? "").replace(/^firestore\//, "");
  const messages: Record<string, string> = {
    "permission-denied": "이 계정의 Firebase 저장소에 접근할 수 없습니다. 보안 규칙과 로그인 상태를 확인해 주세요. 기기 내용은 보존됩니다.",
    "unauthenticated": "로그인이 만료되었습니다. 다시 로그인해 주세요. 기기 내용은 보존됩니다.",
    "unavailable": "Firebase에 연결할 수 없습니다. 인터넷 연결 후 다시 동기화해 주세요. 기기 내용은 보존됩니다.",
    "resource-exhausted": "Firebase 사용 한도에 도달했습니다. 기기 저장은 유지되며, 한도가 회복된 뒤 다시 동기화할 수 있습니다.",
  };
  return messages[code] ?? (problem instanceof Error ? problem.message : "동기화하지 못했습니다. 기기 내용은 보존됩니다.");
}

function parseBaseline(value: unknown): FirebaseBaseline | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || !firebaseVersionId((value as FirebaseBaseline).id))
    throw Error("이 기기의 동기화 기록을 확인할 수 없습니다. 기존 데이터는 보존됩니다.");
  return { id: (value as FirebaseBaseline).id, document: documentSchema.parse((value as FirebaseBaseline).document) };
}

/** Independent of React so race, recovery, and account-change behavior can be exercised directly. */
export function createFirebaseSyncController(options: WorkspaceActions & {
  engine: Engine;
  readBaseline: () => Promise<unknown>;
  writeBaseline: (value: FirebaseBaseline) => Promise<void>;
  isCurrent: () => boolean;
  isOnline: () => boolean;
  onChange: (state: FirebaseSyncState) => void;
}) {
  let state = initialState;
  let running: Promise<void> | null = null;
  let cachedRemote: FirebaseVersion | null = null;
  let observedHead: string | null | undefined;
  let retryPending = false;
  const migrationActor = `migration:${crypto.randomUUID()}`;
  const guard = () => { if (!options.isCurrent()) throw new FirebaseSessionChanged(); };
  const publish = (next: FirebaseSyncState) => {
    guard();
    state = next;
    options.onChange(next);
  };
  async function readRemote() {
    guard();
    const head = await options.engine.getHead();
    guard();
    observedHead = head?.headId ?? null;
    if (!head) return null;
    const version = cachedRemote?.id === head.headId ? cachedRemote : await options.engine.readVersion(head.headId);
    guard();
    if (version.sha256 !== head.sha256)
      throw Error("Firebase 저장 버전의 확인값이 일치하지 않습니다. 기기 내용은 보존됩니다.");
    cachedRemote = version;
    return version;
  }
  async function remember(version: FirebaseVersion) {
    guard();
    cachedRemote = version;
    observedHead = version.id;
    await options.writeBaseline({ id: version.id, document: version.document });
    guard();
    publish({ status: "synced", error: null, conflict: null });
  }
  async function readPair() {
    guard();
    await options.flush();
    guard();
    const remote = await readRemote();
    guard();
    // Remote reads may take time. Use the latest persisted draft when deciding
    // what to merge, including edits made while that request was in flight.
    const latest = await options.flush();
    guard();
    return { local: latest, remote };
  }
  function showConflict(local: Workspace, remote: FirebaseVersion, error: string | null = null) {
    publish({ status: "conflict", error, conflict: { local, remote } });
  }
  async function synchronize() {
    retryPending = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { local, remote } = await readPair();
      const base = parseBaseline(await options.readBaseline());
      guard();
      const decision = decideFirebaseSync(local, base, remote);
      // Only the first connection of unrelated existing workspaces needs a
      // choice. Devices with a common baseline always reconcile automatically.
      if (decision === "conflict" && !base) return showConflict(local, remote!);
      let candidate = decision === "pull" ? remote!.document : decision === "conflict"
        ? mergeFirebaseWorkspaces(base!.document, local, remote!.document, { remoteTime: Date.parse(remote!.createdAt) })
        : local;
      if (firebaseWorkspaceSignature(candidate) !== firebaseWorkspaceSignature(local)) {
        guard();
        try {
          // Incoming data keeps its existing edit stamps and archives the
          // previous local copy. A racing local edit is merged by replace.
          await options.replace(candidate, JSON.stringify(local), { source: "remote" });
        } catch (problem) {
          guard();
          const latest = await options.flush();
          guard();
          if (firebaseWorkspaceSignature(latest) !== firebaseWorkspaceSignature(local)) continue;
          throw problem;
        }
        candidate = await options.flush();
        guard();
      }
      try {
        const version = remote && firebaseWorkspaceSignature(candidate) === firebaseWorkspaceSignature(remote.document)
          ? remote : await options.engine.commit(candidate, remote?.id ?? null);
        guard();
        await remember(version);
        const latest = await options.flush();
        guard();
        if (firebaseWorkspaceSignature(latest) === firebaseWorkspaceSignature(version.document)) return;
        publish({ status: "syncing", error: null, conflict: null });
      } catch (problem) {
        if (!(problem instanceof FirebaseHeadConflict)) throw problem;
        guard();
        // Another device won the head CAS. Read its version and merge again;
        // every staged snapshot remains immutable and recoverable.
      }
    }
    retryPending = true;
    publish({ status: "syncing", error: null, conflict: null });
  }
  function run(action: () => Promise<void>): Promise<void> {
    if (running) return running.then(() => run(action));
    if (!options.isCurrent()) return Promise.resolve();
    if (!options.isOnline()) {
      publish({ ...state, status: "offline", error: null });
      return Promise.resolve();
    }
    publish({ ...state, status: "syncing", error: null });
    running = action().catch(async problem => {
      if (!options.isCurrent() || problem instanceof FirebaseSessionChanged) return;
      if (problem instanceof FirebaseHeadConflict) {
        try {
          const { local, remote } = await readPair();
          if (!remote) throw Error("다른 기기에서 저장소가 변경되었습니다. 기기 내용은 보존됩니다.");
          showConflict(local, remote, "다른 기기에서 먼저 저장했습니다. 두 내용을 확인한 뒤 사용할 버전을 선택해 주세요.");
          return;
        } catch (refreshError) { problem = refreshError; }
      }
      if (!options.isCurrent() || problem instanceof FirebaseSessionChanged) return;
      publish({ ...state, status: state.conflict ? "conflict" : "error", error: syncError(problem) });
    }).finally(() => { running = null; });
    return running;
  }
  return {
    get state() { return state; },
    get busy() { return running !== null; },
    get observedHead() { return observedHead; },
    get retryPending() { return retryPending; },
    sync: () => run(synchronize),
    resolve(choice: Choice) {
      const chosen = state.conflict;
      if (!chosen) return Promise.resolve();
      return run(async () => {
        const { local, remote } = await readPair();
        if (!remote) throw Error("클라우드 작업실이 변경되었습니다. 기기 내용은 보존됩니다. 다시 동기화해 주세요.");
        if (remote.id !== chosen.remote.id ||
            firebaseWorkspaceSignature(local) !== firebaseWorkspaceSignature(chosen.local)) {
          showConflict(local, remote, "확인하는 동안 내용이 바뀌었습니다. 최신 내용을 확인하고 다시 선택해 주세요.");
          return;
        }
        if (choice === "local") {
          // Explicit first-login replacement is itself a new edit; tombstone
          // omitted cloud entities so a previously connected device cannot
          // revive them using an older snapshot.
          const chosenLocal = stampWorkspace(remote.document, local, migrationActor);
          await options.replace(chosenLocal, JSON.stringify(local), { source: "remote" });
          guard();
          const committed = await options.engine.commit(await options.flush(), remote.id);
          guard();
          await remember(committed);
        } else {
          guard();
          await options.replace(remote.document, JSON.stringify(local), { source: "remote" });
          guard();
          await remember(remote);
        }
      });
    },
    report(problem: unknown) {
      if (options.isCurrent()) publish({ ...state, status: state.conflict ? "conflict" : "error", error: syncError(problem) });
    },
  };
}

type Session = {
  isCurrent: () => boolean;
  controller: ReturnType<typeof createFirebaseSyncController>;
  run: (choice?: Choice) => Promise<void>;
};

export function useFirebaseSync(props: SyncProps) {
  const latest = useRef(props);
  latest.current = props;
  const sessionRef = useRef<Session | null>(null);
  const [state, setState] = useState<FirebaseSyncState>(initialState);
  const { ready, scope, services, uid, flush, replace } = props;

  useEffect(() => {
    setState(initialState);
    if (!ready || !services || !uid || scope === undefined) return;
    let active = true;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let watchFailed = true;
    const isCurrent = () => active && latest.current.ready && latest.current.scope === scope &&
      latest.current.uid === uid && latest.current.services === services && services.auth.currentUser?.uid === uid;
    const engine = createFirestoreWorkspace(services.db, uid, { isCurrent });
    const key = `firebase-baseline:${scope}`;
    const controller = createFirebaseSyncController({
      engine, flush, replace, isCurrent, isOnline: () => navigator.onLine,
      readBaseline: () => getSetting(key), writeBaseline: value => setSetting(key, value),
      onChange: next => { if (isCurrent()) setState(next); },
    });
    const schedule = (delay = 700) => {
      if (!isCurrent()) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (!isCurrent() || document.visibilityState === "hidden" || controller.state.conflict) return;
        if (controller.busy) { pending = true; return; }
        void run();
      }, delay);
    };
    const watch = () => {
      if (!isCurrent() || !watchFailed) return;
      unsubscribe?.();
      watchFailed = false;
      unsubscribe = engine.watchHead(head => {
        if ((head?.headId ?? null) !== controller.observedHead) schedule(0);
      }, problem => {
        watchFailed = true;
        controller.report(problem);
      });
    };
    async function run(choice?: Choice) {
      if (!isCurrent()) return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      watch();
      if (choice) await controller.resolve(choice);
      else await controller.sync();
      if (isCurrent() && (pending || controller.retryPending)) { pending = false; schedule(); }
    }
    const session: Session = { isCurrent, controller, run };
    sessionRef.current = session;
    const saved = () => schedule();
    const resume = () => { if (document.visibilityState !== "hidden") schedule(0); };
    const offline = () => { if (isCurrent()) setState(previous => ({ ...previous, status: "offline", error: null })); };
    window.addEventListener("sayu-local-saved", saved);
    window.addEventListener("online", resume);
    window.addEventListener("offline", offline);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    watch();
    schedule(0);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      window.removeEventListener("sayu-local-saved", saved);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", offline);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [ready, scope, services, uid, flush, replace]);

  const sync = useCallback(async () => {
    const session = sessionRef.current;
    if (session?.isCurrent()) await session.run();
  }, []);
  const resolve = useCallback(async (choice: Choice) => {
    const session = sessionRef.current;
    if (session?.isCurrent()) await session.run(choice);
  }, []);
  const downloadConflict = useCallback((choice: Choice) => {
    const session = sessionRef.current;
    const conflict = session?.controller.state.conflict;
    if (session?.isCurrent() && conflict) exportFile(choice === "local" ? conflict.local : conflict.remote.document);
  }, []);
  return { ...(sessionRef.current?.isCurrent() ? state : initialState), sync, resolve, downloadConflict };
}
