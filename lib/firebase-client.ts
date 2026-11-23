/// <reference types="vite/client" />
import { getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import {
  browserLocalPersistence, connectAuthEmulator, createUserWithEmailAndPassword, getAuth,
  indexedDBLocalPersistence, initializeAuth, inMemoryPersistence, sendPasswordResetEmail,
  signInWithEmailAndPassword, signOut as firebaseSignOut, type Auth,
} from "firebase/auth";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore";
import configuredValues from "../portable/firebase-config.json" with { type: "json" };
import { appBaseUrl } from "./app-url.ts";

export type FirebaseServices = { app: FirebaseApp; auth: Auth; db: Firestore };
export type FirebaseConfigStatus = {
  configured: boolean;
  emulator: boolean;
  projectId: string | null;
  error: string | null;
};
type ClientCache = { key: string; promise: Promise<FirebaseServices> };
// Keep initialization stable when Vite refreshes modules; emulator connections run once per app.
const state = globalThis as typeof globalThis & { __sayuFirebaseClient?: ClientCache };

function emulatorEnabled() {
  return typeof location !== "undefined" && import.meta.env?.DEV === true &&
    ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) &&
    new URLSearchParams(location.search).get("firebaseEmulator") === "1";
}

function configuration(): { config: FirebaseOptions | null; emulator: boolean; error: string | null } {
  if (emulatorEnabled()) return {
    config: { apiKey: "demo-sayu-api-key", authDomain: "demo-sayu.firebaseapp.com", projectId: "demo-sayu", appId: "1:1234567890:web:0123456789abcdef012345" },
    emulator: true, error: null,
  };
  const input: unknown = configuredValues;
  if (!input || typeof input !== "object" || Array.isArray(input)) return {
    config: null, emulator: false, error: "Firebase 웹앱 구성 파일의 형식을 확인해 주세요.",
  };
  const values = input as Record<string, unknown>;
  const required = ["apiKey", "authDomain", "projectId", "appId"] as const;
  if ("private_key" in values || "client_email" in values) return {
    config: null, emulator: false,
    error: "Firebase 웹앱 구성값이 필요합니다. 서비스 계정 키는 앱에 넣지 마세요.",
  };
  if (required.some(key => typeof values[key] !== "string" || !String(values[key]).trim() ||
      /^(COPY_|YOUR_)/.test(String(values[key])))) return {
    config: null, emulator: false,
    error: "Firebase 연결이 아직 설정되지 않았습니다. 관리자가 프로젝트의 웹앱 구성값을 등록한 뒤 앱을 다시 배포해야 합니다.",
  };
  return {
    config: Object.fromEntries(required.map(key => [key, String(values[key]).trim()])) as FirebaseOptions,
    emulator: false, error: null,
  };
}

/** Public status for the UI; it excludes API keys and authentication tokens. */
export function getFirebaseConfig(): FirebaseConfigStatus {
  const current = configuration();
  return { configured: current.config !== null, emulator: current.emulator, projectId: current.config?.projectId ?? null, error: current.error };
}

export function getFirebaseServices(): Promise<FirebaseServices> {
  const current = configuration();
  if (!current.config) return Promise.reject(Error(current.error!));
  const config = current.config;
  const key = JSON.stringify({ config, emulator: current.emulator });
  if (state.__sayuFirebaseClient) {
    if (state.__sayuFirebaseClient.key !== key)
      return Promise.reject(Error("Firebase 설정이 변경되었습니다. 페이지를 새로 열어 주세요."));
    return state.__sayuFirebaseClient.promise;
  }
  const promise = (async () => {
    const name = current.emulator ? "sayu-emulator" : "sayu";
    const existing = getApps().find(app => app.name === name);
    if (existing && Object.keys(config).some(key => existing.options[key as keyof FirebaseOptions] !== config[key as keyof FirebaseOptions]))
      throw Error("Firebase 설정이 변경되었습니다. 페이지를 새로 열어 주세요.");
    const app = existing ?? initializeApp(config, name);
    let auth: Auth;
    try {
      auth = initializeAuth(app, {
        persistence: [indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence],
      });
    } catch (problem) {
      if ((problem as { code?: string })?.code !== "auth/already-initialized") throw problem;
      auth = getAuth(app);
    }
    if (current.emulator) connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    const db = getFirestore(app);
    if (current.emulator) connectFirestoreEmulator(db, "127.0.0.1", 8080);
    await auth.authStateReady();
    return { app, auth, db };
  })();
  const cached = { key, promise };
  state.__sayuFirebaseClient = cached;
  void promise.catch(() => {
    if (state.__sayuFirebaseClient === cached) delete state.__sayuFirebaseClient;
  });
  return promise;
}

function authError(problem: unknown) {
  const code = (problem as { code?: string })?.code;
  const messages: Record<string, string> = {
    "auth/invalid-email": "이메일 주소를 확인해 주세요.",
    "auth/missing-password": "비밀번호를 입력해 주세요.",
    "auth/invalid-credential": "이메일 또는 비밀번호를 확인해 주세요.",
    "auth/user-not-found": "이메일 또는 비밀번호를 확인해 주세요.",
    "auth/wrong-password": "이메일 또는 비밀번호를 확인해 주세요.",
    "auth/email-already-in-use": "이미 가입한 이메일입니다. 로그인하거나 비밀번호를 재설정해 주세요.",
    "auth/weak-password": "프로젝트의 비밀번호 규칙에 맞는 비밀번호를 사용해 주세요.",
    "auth/operation-not-allowed": "Firebase의 이메일·비밀번호 로그인 설정을 확인해 주세요.",
    "auth/unauthorized-domain": "Firebase에서 이 앱의 배포 주소를 허용 도메인으로 등록해야 합니다.",
    "auth/too-many-requests": "로그인 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
    "auth/network-request-failed": "네트워크 연결을 확인한 뒤 다시 시도해 주세요.",
    "auth/invalid-api-key": "Firebase 웹앱 구성값을 확인해 주세요.",
    "auth/configuration-not-found": "Firebase 프로젝트의 Authentication 설정을 확인해 주세요.",
  };
  return Error(code ? messages[code] ?? "Firebase 인증에 실패했습니다. 잠시 후 다시 시도해 주세요." :
    problem instanceof Error ? problem.message : "Firebase 연결에 실패했습니다.");
}

export async function signInEmail(email: string, password: string) {
  try { return await signInWithEmailAndPassword((await getFirebaseServices()).auth, email.trim(), password); }
  catch (problem) { throw authError(problem); }
}

export async function createAccount(email: string, password: string) {
  try { return await createUserWithEmailAndPassword((await getFirebaseServices()).auth, email.trim(), password); }
  catch (problem) { throw authError(problem); }
}

export async function resetPassword(email: string) {
  try {
    const { auth } = await getFirebaseServices();
    auth.languageCode = "ko";
    await sendPasswordResetEmail(auth, email.trim(), { url: appBaseUrl(), handleCodeInApp: false });
  }
  catch (problem) { throw authError(problem); }
}

export async function signOut() {
  try { await firebaseSignOut((await getFirebaseServices()).auth); }
  catch (problem) { throw authError(problem); }
}
