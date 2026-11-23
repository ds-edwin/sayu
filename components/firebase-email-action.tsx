import { useEffect, useRef, useState } from "react";
import { applyActionCode, checkActionCode, confirmPasswordReset, verifyPasswordResetCode } from "firebase/auth";
import { getFirebaseConfig, getFirebaseServices } from "@/lib/firebase-client";
import { parseEmailAction } from "@/lib/email-action";

type Action = ReturnType<typeof parseEmailAction>;
type Phase = "verifying" | "ready" | "submitting" | "success" | "error";
type Failure = { message: string; retry: boolean };
const copy = {
  resetPassword: { title: "새 비밀번호 설정", description: "사유 계정에서 사용할 새 비밀번호를 입력하세요.", button: "비밀번호 변경", success: "비밀번호를 변경했습니다. 새 비밀번호로 앱에 로그인하세요.", email: "계정 이메일" },
  verifyEmail: { title: "이메일 주소 확인", description: "아래 주소를 확인한 뒤 이메일 인증을 완료하세요.", button: "이메일 인증 완료", success: "이메일 인증을 완료했습니다.", email: "확인할 이메일" },
  recoverEmail: { title: "원래 이메일 복구", description: "아래 주소로 계정 이메일을 복구하려면 버튼을 눌러 주세요.", button: "원래 이메일로 복구", success: "계정 이메일을 복구했습니다. 앱에서 계정을 확인하세요.", email: "복구할 이메일" },
  verifyAndChangeEmail: { title: "새 이메일 주소 확인", description: "아래 주소로 계정 이메일을 변경하려면 확인해 주세요.", button: "이메일 변경 확인", success: "이메일 변경을 확인했습니다. 앱에서 계정을 확인하세요.", email: "변경할 이메일" },
};

function failure(problem: unknown): Failure {
  const code = (problem as { code?: string })?.code;
  if (["auth/network-request-failed", "auth/internal-error"].includes(code ?? ""))
    return { message: "연결을 확인하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.", retry: true };
  if (code === "auth/too-many-requests")
    return { message: "요청이 많습니다. 잠시 기다린 뒤 링크를 다시 확인해 주세요.", retry: true };
  if (["auth/expired-action-code", "auth/invalid-action-code", "auth/user-disabled", "auth/user-not-found", "action/mode-mismatch"].includes(code ?? ""))
    return { message: "만료되었거나 사용할 수 없는 링크입니다. 앱에서 새 안내 메일을 요청해 주세요.", retry: false };
  if (["auth/invalid-api-key", "auth/configuration-not-found", "auth/operation-not-allowed"].includes(code ?? ""))
    return { message: "계정 연결 설정을 확인하지 못했습니다. 앱에서 다시 시도하거나 관리자에게 알려주세요.", retry: false };
  if (!code) return { message: "계정 연결 설정을 확인하지 못했습니다. 앱에서 다시 시도하거나 관리자에게 알려주세요.", retry: false };
  return { message: "링크를 확인하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.", retry: true };
}

function homeUrl() {
  const home = new URL("./", window.location.href);
  if (getFirebaseConfig().emulator) home.searchParams.set("firebaseEmulator", "1");
  return home.href;
}

export default function FirebaseEmailAction() {
  const [action] = useState<Action | null>(() => {
    try { return parseEmailAction(window.location.search); } catch { return null; }
  });
  const [home] = useState(homeUrl);
  const [phase, setPhase] = useState<Phase>(action ? "verifying" : "error");
  const [error, setError] = useState<Failure | null>(action ? null : {
    message: "올바른 안내 링크가 아닙니다. 앱에서 새 안내 메일을 요청해 주세요.", retry: false,
  });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [formError, setFormError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const submitting = useRef(false);
  const words = action ? copy[action.mode] : null;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);

  useEffect(() => {
    if (!action) return;
    const ticket = ++sequence.current;
    setPhase("verifying"); setError(null); setFormError(""); setPassword(""); setConfirmation("");
    void (async () => {
      try {
        const { auth } = await getFirebaseServices();
        if (!mounted.current || ticket !== sequence.current) return;
        let address: string;
        if (action.mode === "resetPassword") address = await verifyPasswordResetCode(auth, action.code);
        else {
          const info = await checkActionCode(auth, action.code);
          const operations = { verifyEmail: "VERIFY_EMAIL", recoverEmail: "RECOVER_EMAIL", verifyAndChangeEmail: "VERIFY_AND_CHANGE_EMAIL" } as const;
          if (info.operation !== operations[action.mode]) throw { code: "action/mode-mismatch" };
          address = info.data.email ?? "";
        }
        if (!address) throw { code: "auth/invalid-action-code" };
        if (!mounted.current || ticket !== sequence.current) return;
        setEmail(address); setPhase("ready");
      } catch (problem) {
        if (mounted.current && ticket === sequence.current) { setError(failure(problem)); setPhase("error"); }
      }
    })();
    return () => { sequence.current++; };
  }, [action, attempt]);

  async function confirm() {
    if (!action || phase !== "ready" || submitting.current) return;
    if (action.mode === "resetPassword") {
      if (password.length < 6 || password.length > 4096) { setFormError("비밀번호는 6~4,096자로 입력해 주세요."); return; }
      if (password !== confirmation) { setFormError("두 비밀번호가 일치하지 않습니다."); return; }
    }
    submitting.current = true;
    setPhase("submitting"); setFormError("");
    let completed = false;
    try {
      const { auth } = await getFirebaseServices();
      if (!mounted.current) return;
      if (action.mode === "resetPassword") await confirmPasswordReset(auth, action.code, password);
      else await applyActionCode(auth, action.code);
      if (!mounted.current) return;
      completed = true;
      setPassword(""); setConfirmation(""); setPhase("success");
      // Only a completed action loses its single-use code from browser history.
      try {
        const clean = new URL(window.location.pathname, window.location.origin);
        if (getFirebaseConfig().emulator) clean.searchParams.set("firebaseEmulator", "1");
        window.history.replaceState(window.history.state, "", clean.href);
      } catch { /* Completion remains successful if the address cannot be cleaned. */ }
    } catch (problem) {
      if (!mounted.current) return;
      const code = (problem as { code?: string })?.code;
      if (action.mode === "resetPassword" && ["auth/weak-password", "auth/password-does-not-meet-requirements"].includes(code ?? "")) {
        setFormError("이 비밀번호는 사용할 수 없습니다. 계정의 비밀번호 규칙에 맞게 다시 입력해 주세요."); setPhase("ready");
      } else { setPassword(""); setConfirmation(""); setError(failure(problem)); setPhase("error"); }
    } finally { if (!completed) submitting.current = false; }
  }

  const working = phase === "verifying" || phase === "submitting";
  return <div className="email-action-shell">
    <header className="email-action-header"><a href={home} className="email-action-brand">사유<span>THOUGHT MAP</span></a><span>계정 안내</span></header>
    <main className="email-action-card" aria-busy={working}>
      <div className="email-action-mark" aria-hidden="true">✓</div>
      <h1>{phase === "success" ? "완료되었습니다" : words?.title ?? "링크 확인"}</h1>
      {phase === "verifying" && <p role="status">안내 링크를 확인하고 있습니다…</p>}
      {(phase === "ready" || phase === "submitting") && words && <>
        <p>{words.description}</p>
        {email && <div className="email-action-address"><span>{words.email}</span><strong>{email}</strong></div>}
        {action?.mode === "resetPassword" ? <form onSubmit={event => { event.preventDefault(); void confirm(); }}>
          <label htmlFor="new-password">새 비밀번호<input id="new-password" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false}
            minLength={6} maxLength={4096} required disabled={phase === "submitting"} value={password} onChange={event => setPassword(event.target.value)} aria-describedby="password-hint" /></label>
          <label htmlFor="confirm-password">새 비밀번호 확인<input id="confirm-password" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false}
            minLength={6} maxLength={4096} required disabled={phase === "submitting"} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
          <p id="password-hint" className="email-action-hint">사유 계정의 새 비밀번호를 6~4,096자로 입력하세요.</p>
          {formError && <p className="email-action-error" role="alert">{formError}</p>}
          <button className="email-action-primary" disabled={phase === "submitting"}>{phase === "submitting" ? "변경 중…" : words.button}</button>
        </form> : <button className="email-action-primary" disabled={phase === "submitting"} onClick={() => void confirm()}>{phase === "submitting" ? "확인 중…" : words.button}</button>}
      </>}
      {phase === "error" && error && <div className="email-action-failure"><p role="alert">{error.message}</p>
        {error.retry && action && <button className="email-action-primary" onClick={() => setAttempt(value => value + 1)}>링크 다시 확인</button>}
      </div>}
      {phase === "success" && <p role="status">{words?.success}</p>}
      <a className="email-action-home" href={home}>앱으로 돌아가기 <span aria-hidden="true">→</span></a>
    </main>
    <footer className="email-action-footer">사유 계정 안내{action?.mode === "resetPassword" ? " · 새 비밀번호는 직접 입력해 주세요." : " · 이메일 주소 확인"}</footer>
  </div>;
}
