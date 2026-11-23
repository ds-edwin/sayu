import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { X } from "lucide-react";
import { createAccount, getFirebaseConfig, getFirebaseServices, resetPassword, signInEmail, signOut, type FirebaseServices } from "@/lib/firebase-client";
import type { Workspace } from "@/lib/model";

type WorkspaceActions = { flush: () => Promise<Workspace>; exportCurrent: () => void };
type Session = {
  user: User | null; services: FirebaseServices | null; scope?: string;
  registerWorkspace: (actions: WorkspaceActions) => () => void;
  openAccount: () => void;
};
const SessionContext = createContext<Session>({ user: null, services: null, registerWorkspace: () => () => {}, openAccount: () => {} });
export const useFirebaseSession = () => useContext(SessionContext);

export default function FirebaseSessionProvider({ children }: { children: (scope?: string) => ReactNode }) {
  const config = getFirebaseConfig();
  const [services, setServices] = useState<FirebaseServices | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [initialized, setInitialized] = useState(!config.configured);
  const [switching, setSwitching] = useState(false);
  const [transitionError, setTransitionError] = useState("");
  const [open, setOpen] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const actions = useRef<WorkspaceActions | null>(null);
  const desiredUser = useRef<User | null>(null);
  const changeSession = useRef<(next: User | null) => Promise<void>>(async () => {});
  const scope = user && config.projectId ? `firebase:${config.projectId}:${user.uid}` : undefined;
  const registerWorkspace = useCallback((value: WorkspaceActions) => {
    actions.current = value;
    return () => { if (actions.current === value) actions.current = null; };
  }, []);
  useEffect(() => {
    if (!config.configured) return;
    let alive = true, unsubscribe = () => {}, sequence = 0;
    changeSession.current = async next => {
      const ticket = ++sequence;
      desiredUser.current = next;
      setSwitching(true);
      setTransitionError("");
      try {
        // Keep the previous workspace mounted until every local edit is durable.
        await actions.current?.flush();
        if (!alive || ticket !== sequence) return;
        setUser(next);
        setInitialized(true);
        setSwitching(false);
      } catch (problem) {
        if (alive && ticket === sequence) setTransitionError(problem instanceof Error ? problem.message : "기기 저장을 완료하지 못했습니다.");
      }
    };
    void getFirebaseServices().then(value => {
      if (!alive) return;
      setServices(value);
      unsubscribe = onAuthStateChanged(value.auth, next => { void changeSession.current(next); });
    }).catch(problem => {
      if (!alive) return;
      setInitialized(true);
      setTransitionError(problem instanceof Error ? problem.message : "로그인 연결을 확인해 주세요.");
      setOpen(true);
    });
    return () => { alive = false; sequence++; unsubscribe(); };
  }, [config.configured, connectionAttempt]);
  const beforeAuth = async () => { await actions.current?.flush(); };
  return <SessionContext.Provider value={{ user, services, scope, registerWorkspace, openAccount: () => setOpen(true) }}>
    {initialized && <div className="firebase-workspace" hidden={switching}>{children(scope)}</div>}
    {(!initialized || switching) && <div className="firebase-transition" role="status">
      <h2>{transitionError ? "기기 저장을 확인해 주세요" : "작업실을 여는 중…"}</h2>
      {transitionError && <><p role="alert">{transitionError}</p><p>현재 편집 내용은 이 창에 남아 있습니다. 내보내기로 보관할 수 있습니다.</p>
        <button onClick={() => actions.current?.exportCurrent()}>현재 내용 내보내기</button>
        <button onClick={() => void changeSession.current(desiredUser.current)}>저장 다시 시도</button></>}
    </div>}
    {open && <AccountDialog user={user} configured={config.configured} setupError={config.error ?? transitionError}
      close={() => setOpen(false)} beforeAuth={beforeAuth}
      afterAuth={() => { if (!services) { setTransitionError(""); setConnectionAttempt(value => value + 1); } }} />}
  </SessionContext.Provider>;
}

function AccountDialog({ user, configured, setupError, close, beforeAuth, afterAuth }: {
  user: User | null; configured: boolean; setupError: string | null; close: () => void; beforeAuth: () => Promise<void>; afterAuth: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<"login" | "create">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  async function run(action: () => Promise<unknown>, success?: string) {
    if (busy) return;
    setBusy(true); setMessage("");
    try { await beforeAuth(); await action(); afterAuth(); setPassword(""); if (success) setMessage(success); else close(); }
    catch (problem) { setMessage(problem instanceof Error ? problem.message : "잠시 후 다시 시도해 주세요."); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="firebase-dialog" onCancel={close} aria-labelledby="firebase-account-title">
    <header><h2 id="firebase-account-title">계정 · 자동 동기화</h2><button className="icon-button" aria-label="계정 창 닫기" onClick={close}><X size={20} /></button></header>
    <div className="firebase-dialog-body">
      {user ? <><p><strong>{user.email}</strong></p><p>PC와 iPad에서 이 이메일로 로그인하면 같은 작업실을 사용합니다.</p>
        <p>오프라인 편집은 이 기기에 저장되며, 인터넷에 다시 연결하면 동기화합니다. 앱을 열어 둔 동안 동기화됩니다.</p>
        <button disabled={busy} onClick={() => void run(signOut)}>로그아웃</button></> : <>
        <p>사유에서 이메일과 비밀번호로 계정을 만드세요. 같은 계정으로 모든 기기에서 생각을 이어갈 수 있습니다.</p>
        <p className="firebase-note">Gmail 주소도 사용할 수 있습니다. Google 계정 로그인과는 별개이며, 사유용 비밀번호를 설정합니다.</p>
        <p className="firebase-note">처음 연결하는 계정에 이 기기의 기존 내용을 복사합니다. 원본과 복원 기록은 유지됩니다.</p>
        {!configured ? <p role="status">{setupError}</p> : <form onSubmit={event => { event.preventDefault(); void run(() => mode === "create" ? createAccount(email, password) : signInEmail(email, password)); }}>
          <label>이메일<input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
          <label>비밀번호<input type="password" autoComplete={mode === "create" ? "new-password" : "current-password"} minLength={mode === "create" ? 6 : undefined} required value={password} onChange={e => setPassword(e.target.value)} /></label>
          <button className="primary" disabled={busy}>{busy ? "연결 중…" : mode === "create" ? "계정 만들기" : "로그인"}</button>
          <div className="firebase-account-links"><button type="button" disabled={busy} onClick={() => { setMode(mode === "login" ? "create" : "login"); setMessage(""); }}>{mode === "login" ? "처음이라면 계정 만들기" : "기존 계정으로 로그인"}</button>
            <button type="button" disabled={busy || !email.trim()} onClick={() => void run(() => resetPassword(email), "이메일을 확인해 주세요. 가입한 주소라면 비밀번호 재설정 안내가 도착합니다.")}>비밀번호 재설정</button></div>
        </form>}
      </>}
      {configured && setupError && <p role="alert">{setupError}</p>}
      {message && <p role="status">{message}</p>}
    </div>
  </dialog>;
}
