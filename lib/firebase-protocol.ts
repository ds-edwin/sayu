import { blankWorkspace, documentSchema, type Workspace } from "./model.ts";

export const FIREBASE_MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
export const FIREBASE_MAX_CHUNK_BYTES = 256 * 1024;
export const FIREBASE_MAX_CHUNKS = 164;
const CHUNK_CHARACTERS = 64 * 1024;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hashPattern = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

export type FirebaseHead = { version: 1; headId: string; updatedAt: string; sha256: string };
export type FirebaseManifest = {
  format: "sayu-firebase-snapshot";
  version: 1;
  id: string;
  parentId: string | null;
  createdAt: string;
  chunkCount: number;
  byteLength: number;
  sha256: string;
};
export type FirebaseChunk = { index: number; text: string };
export type FirebaseVersion = {
  id: string;
  parentId: string | null;
  createdAt: string;
  sha256: string;
  document: Workspace;
};
export type FirebaseBaseline = { id: string; document: Workspace };
export type FirebaseDecision = "push" | "pull" | "same" | "conflict";

export class FirebaseHeadConflict extends Error {
  readonly expected: string | null;
  readonly actual: string | null;
  readonly stagedVersionId: string;
  constructor(expected: string | null, actual: string | null, stagedVersionId: string) {
    super("다른 기기에서 먼저 저장했습니다. 두 버전은 보존되었습니다. 다시 동기화해 내용을 확인하세요.");
    this.name = "FirebaseHeadConflict";
    this.expected = expected;
    this.actual = actual;
    this.stagedVersionId = stagedVersionId;
  }
}
export class FirebaseSessionChanged extends Error {
  constructor() {
    super("로그인 계정이 변경되어 이전 계정의 동기화를 중지했습니다.");
    this.name = "FirebaseSessionChanged";
  }
}

export function firebaseVersionId(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Firebase 저장 정보가 올바르지 않습니다.");
  return value as Record<string, unknown>;
}
export function parseFirebaseHead(value: unknown): FirebaseHead {
  const v = record(value);
  if (v.version !== 1 || !firebaseVersionId(v.headId) || !timestamp(v.updatedAt) ||
    typeof v.sha256 !== "string" || !hashPattern.test(v.sha256)) throw Error("Firebase 최신 버전 정보가 올바르지 않습니다.");
  return { version: 1, headId: v.headId, updatedAt: v.updatedAt, sha256: v.sha256 };
}
export function parseFirebaseManifest(value: unknown, expectedId: string): FirebaseManifest {
  const v = record(value);
  if (v.format !== "sayu-firebase-snapshot" || v.version !== 1 || !firebaseVersionId(v.id) || v.id !== expectedId ||
    !(v.parentId === null || firebaseVersionId(v.parentId)) || v.parentId === v.id || !timestamp(v.createdAt) ||
    typeof v.chunkCount !== "number" || !Number.isInteger(v.chunkCount) || v.chunkCount < 1 || v.chunkCount > FIREBASE_MAX_CHUNKS ||
    typeof v.byteLength !== "number" || !Number.isInteger(v.byteLength) || v.byteLength < 1 || v.byteLength > FIREBASE_MAX_SNAPSHOT_BYTES ||
    typeof v.sha256 !== "string" || !hashPattern.test(v.sha256)) throw Error("Firebase 작업실 버전 정보가 올바르지 않습니다.");
  return { format: "sayu-firebase-snapshot", version: 1, id: v.id, parentId: v.parentId, createdAt: v.createdAt,
    chunkCount: v.chunkCount, byteLength: v.byteLength, sha256: v.sha256 };
}
export function firebaseWorkspaceSignature(document: Workspace): string {
  return JSON.stringify(documentSchema.parse(document));
}
export async function firebaseSha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function firebaseChunkId(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= FIREBASE_MAX_CHUNKS) throw Error("Firebase 조각 번호가 올바르지 않습니다.");
  return String(index).padStart(4, "0");
}

export async function encodeFirebaseVersion(document: Workspace, parentId: string | null,
  id = crypto.randomUUID(), createdAt = new Date().toISOString()) {
  if (!firebaseVersionId(id) || !(parentId === null || firebaseVersionId(parentId)) || id === parentId || !timestamp(createdAt))
    throw Error("Firebase 버전 식별자가 올바르지 않습니다.");
  const text = firebaseWorkspaceSignature(document);
  const byteLength = encoder.encode(text).byteLength;
  if (byteLength > FIREBASE_MAX_SNAPSHOT_BYTES)
    throw Error("Firebase 동기화 한도(작업실 10MB)를 초과했습니다. 기기 데이터는 보존됩니다. JSON으로 백업하세요.");
  const chunks: FirebaseChunk[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + CHUNK_CHARACTERS, text.length);
    // A UTF-16 surrogate pair must never be split across Firestore strings.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    const part = text.slice(offset, end);
    chunks.push({ index: chunks.length, text: part });
    offset = end;
  }
  if (chunks.length > FIREBASE_MAX_CHUNKS) throw Error("Firebase 작업실 조각 수 한도를 초과했습니다.");
  const sha256 = await firebaseSha256(text);
  const manifest: FirebaseManifest = { format: "sayu-firebase-snapshot", version: 1, id, parentId, createdAt,
    chunkCount: chunks.length, byteLength, sha256 };
  const version: FirebaseVersion = { id, parentId, createdAt, sha256, document: JSON.parse(text) as Workspace };
  return { manifest, chunks, version };
}

export async function decodeFirebaseVersion(rawManifest: unknown, rawChunks: unknown[], expectedId: string): Promise<FirebaseVersion> {
  const manifest = parseFirebaseManifest(rawManifest, expectedId);
  if (rawChunks.length !== manifest.chunkCount) throw Error("Firebase 저장 파일 일부가 없습니다. 기기 내용은 유지됩니다.");
  const parts = rawChunks.map((raw, index) => {
    const chunk = record(raw);
    if (chunk.index !== index || typeof chunk.text !== "string" || !chunk.text ||
      encoder.encode(chunk.text).byteLength > FIREBASE_MAX_CHUNK_BYTES) throw Error("Firebase 저장 파일 일부가 올바르지 않습니다.");
    return chunk.text;
  });
  const text = parts.join("");
  if (encoder.encode(text).byteLength !== manifest.byteLength || await firebaseSha256(text) !== manifest.sha256)
    throw Error("Firebase 저장 파일 검증에 실패했습니다. 기기 내용은 유지됩니다.");
  return { id: manifest.id, parentId: manifest.parentId, createdAt: manifest.createdAt, sha256: manifest.sha256,
    document: documentSchema.parse(JSON.parse(text)) };
}

/** Only the exact untouched starter workspace can be replaced on a first sign-in. */
export function decideFirebaseSync(local: Workspace, base?: FirebaseBaseline | null, remote?: FirebaseVersion | null): FirebaseDecision {
  const localText = firebaseWorkspaceSignature(local);
  if (!remote) {
    if (base) throw Error("Firebase에 연결된 작업실 기록이 없어졌습니다. 기기 데이터는 유지됩니다. 저장소를 확인하세요.");
    return "push";
  }
  const remoteText = firebaseWorkspaceSignature(remote.document);
  if (localText === remoteText) return "same";
  if (!base) return localText === firebaseWorkspaceSignature(blankWorkspace()) ? "pull" : "conflict";
  const baseText = firebaseWorkspaceSignature(base.document);
  if (base.id === remote.id) {
    if (baseText !== remoteText) throw Error("Firebase의 기존 버전 내용이 변경되었습니다. 동기화를 중지했습니다.");
    return localText === baseText ? "same" : "push";
  }
  return localText === baseText ? "pull" : "conflict";
}

/** The adapter contract makes commit order and races testable without a live account. */
export type FirebaseWorkspaceStore = {
  getHead(): Promise<FirebaseHead | null>;
  readManifest(id: string): Promise<unknown>;
  readChunks(id: string, count: number): Promise<unknown[]>;
  stage(manifest: FirebaseManifest, chunks: FirebaseChunk[]): Promise<void>;
  compareAndSwap(next: FirebaseHead, expected: string | null): Promise<void>;
  watchHead(onHead: (head: FirebaseHead | null) => void, onError: (error: Error) => void): () => void;
};
export function createFirebaseWorkspaceEngine(store: FirebaseWorkspaceStore, isCurrent: () => boolean = () => true) {
  const guard = () => { if (!isCurrent()) throw new FirebaseSessionChanged(); };
  return {
    async getHead() {
      guard();
      const head = await store.getHead();
      guard();
      return head;
    },
    async readVersion(id: string) {
      guard();
      if (!firebaseVersionId(id)) throw Error("Firebase 버전 식별자가 올바르지 않습니다.");
      const manifest = parseFirebaseManifest(await store.readManifest(id), id);
      guard();
      const chunks = await store.readChunks(id, manifest.chunkCount);
      guard();
      const version = await decodeFirebaseVersion(manifest, chunks, id);
      guard();
      return version;
    },
    async commit(document: Workspace, expectedHead: string | null) {
      guard();
      if (expectedHead !== null && !firebaseVersionId(expectedHead)) throw Error("Firebase 기준 버전이 올바르지 않습니다.");
      const encoded = await encodeFirebaseVersion(document, expectedHead);
      guard();
      await store.stage(encoded.manifest, encoded.chunks);
      guard();
      await store.compareAndSwap({ version: 1, headId: encoded.version.id, updatedAt: encoded.version.createdAt,
        sha256: encoded.version.sha256 }, expectedHead);
      guard();
      return encoded.version;
    },
    watchHead(onHead: (head: FirebaseHead | null) => void, onError: (error: Error) => void) {
      guard();
      return store.watchHead(head => { if (isCurrent()) onHead(head); }, error => { if (isCurrent()) onError(error); });
    },
  };
}
