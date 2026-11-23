import {
  doc, getDocFromServer, onSnapshot, runTransaction, writeBatch, type Firestore,
} from "firebase/firestore";
import {
  createFirebaseWorkspaceEngine, FirebaseHeadConflict, FirebaseSessionChanged, firebaseChunkId,
  parseFirebaseHead, type FirebaseWorkspaceStore,
} from "./firebase-protocol.ts";
export * from "./firebase-protocol.ts";

function serverOperation<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Firebase 응답이 지연되고 있습니다. 기기 데이터는 보존됩니다. 네트워크를 확인하고 다시 동기화하세요.")), 30000);
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function createFirestoreWorkspace(db: Firestore, uid: string, options: { isCurrent?: () => boolean } = {}) {
  if (!uid || uid.includes("/") || uid.length > 128) throw Error("Firebase 계정 식별자가 올바르지 않습니다.");
  const isCurrent = options.isCurrent ?? (() => true);
  const guard = () => { if (!isCurrent()) throw new FirebaseSessionChanged(); };
  const headRef = doc(db, "users", uid, "workspaces", "main");
  const versionRef = (id: string) => doc(headRef, "versions", id);
  const chunkRef = (id: string, index: number) => doc(versionRef(id), "chunks", firebaseChunkId(index));
  const store: FirebaseWorkspaceStore = {
    async getHead() {
      guard();
      const snapshot = await serverOperation(getDocFromServer(headRef));
      return snapshot.exists() ? parseFirebaseHead(snapshot.data()) : null;
    },
    async readManifest(id) {
      guard();
      const snapshot = await serverOperation(getDocFromServer(versionRef(id)));
      if (!snapshot.exists()) throw Error("Firebase 작업실 버전을 찾을 수 없습니다. 기기 내용은 유지됩니다.");
      return snapshot.data();
    },
    async readChunks(id, count) {
      const chunks: unknown[] = [];
      for (let offset = 0; offset < count; offset += 12) {
        guard();
        const snapshots = await Promise.all(Array.from({ length: Math.min(12, count - offset) }, (_, index) =>
          serverOperation(getDocFromServer(chunkRef(id, offset + index)))));
        for (const snapshot of snapshots) {
          if (!snapshot.exists()) throw Error("Firebase 저장 파일 일부가 없습니다. 기기 내용은 유지됩니다.");
          chunks.push(snapshot.data());
        }
      }
      return chunks;
    },
    async stage(manifest, chunks) {
      // A failed or interrupted upload cannot become the current version. Keep
      // each request below Firestore's 10MiB limit and publish the manifest last.
      for (let offset = 0; offset < chunks.length; offset += 20) {
        guard();
        const batch = writeBatch(db);
        for (const chunk of chunks.slice(offset, offset + 20)) batch.set(chunkRef(manifest.id, chunk.index), chunk);
        await serverOperation(batch.commit());
      }
      guard();
      const batch = writeBatch(db);
      batch.set(versionRef(manifest.id), manifest);
      await serverOperation(batch.commit());
    },
    async compareAndSwap(next, expected) {
      guard();
      await serverOperation(runTransaction(db, async transaction => {
        guard();
        const snapshot = await transaction.get(headRef);
        const actual = snapshot.exists() ? parseFirebaseHead(snapshot.data()).headId : null;
        if (actual !== expected) throw new FirebaseHeadConflict(expected, actual, next.headId);
        guard();
        transaction.set(headRef, next);
      }));
    },
    watchHead(onHead, onError) {
      return onSnapshot(headRef, { includeMetadataChanges: true }, snapshot => {
        if (!isCurrent() || snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
        try { onHead(snapshot.exists() ? parseFirebaseHead(snapshot.data()) : null); }
        catch (error) { onError(error instanceof Error ? error : Error("Firebase 저장소 확인에 실패했습니다.")); }
      }, error => { if (isCurrent()) onError(error); });
    },
  };
  return createFirebaseWorkspaceEngine(store, isCurrent);
}
