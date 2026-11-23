import { useEffect, useRef } from "react";
import { Cloud, X } from "lucide-react";
import { useFirebaseSession } from "./firebase-session";
import { useFirebaseSync } from "./use-firebase-sync";
import type { Workspace } from "@/lib/model";

export default function FirebaseAccountControls({ flush, replace, ready }: {
  flush: () => Promise<Workspace>; replace: (document: Workspace, expected?: string) => Promise<void>; ready: boolean;
}) {
  const session = useFirebaseSession();
  const cloud = useFirebaseSync({ flush, replace, ready, scope: session.scope, services: session.services, uid: session.user?.uid ?? null });
  const titles = { idle: "동기화 준비 중", syncing: "동기화 중…", synced: "클라우드에 저장됨", offline: "기기에 저장됨 · 연결 대기", conflict: "두 기기의 변경 확인 필요", error: "동기화 확인 필요" };
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current; if (cloud.conflict) node?.showModal(); else node?.close(); }, [cloud.conflict]);
  return <>
    <button className="nav-item firebase-account-button" onClick={session.openAccount}><Cloud size={17} />
      <span>{session.user ? session.user.email : "로그인 · 자동 동기화"}</span>
    </button>
    {session.user && <div className="firebase-sync-status" role="status">
      <span>{titles[cloud.status]}</span>
      <button disabled={cloud.status === "syncing"} onClick={() => void cloud.sync()} aria-label="지금 동기화">↻</button>
      {cloud.error && <p>{cloud.error}</p>}
      {cloud.conflict && <button onClick={() => dialog.current?.showModal()}>변경 내용 확인</button>}
    </div>}
    {cloud.conflict && <dialog ref={dialog} className="firebase-dialog" aria-labelledby="firebase-conflict-title">
      <header><h2 id="firebase-conflict-title">두 기기에 서로 다른 내용이 있습니다</h2><button className="icon-button" aria-label="변경 확인 창 닫기" onClick={() => dialog.current?.close()}><X size={20} /></button></header>
      <div className="firebase-dialog-body"><p>두 내용을 내보내 확인한 뒤, 이어서 사용할 내용을 선택하세요. 자동 동기화는 선택할 때까지 잠시 멈춥니다.</p>
        <div className="firebase-conflict-options">
          <section><h3>이 기기의 내용</h3><p>맵 {cloud.conflict.local.maps.length}개 · 생각 {cloud.conflict.local.nodes.length}개</p>
            <button onClick={() => cloud.downloadConflict("local")}>기기 내용 내보내기</button><button className="primary" disabled={cloud.status === "syncing"} onClick={() => void cloud.resolve("local")}>기기 내용 사용</button></section>
          <section><h3>클라우드의 내용</h3><p>맵 {cloud.conflict.remote.document.maps.length}개 · 생각 {cloud.conflict.remote.document.nodes.length}개</p>
            <button onClick={() => cloud.downloadConflict("remote")}>클라우드 내용 내보내기</button><button className="primary" disabled={cloud.status === "syncing"} onClick={() => void cloud.resolve("remote")}>클라우드 내용 사용</button></section>
        </div><p className="firebase-note">기기의 이전 내용은 복원 기록에, 클라우드의 이전 내용은 저장 이력에 보존됩니다.</p>
        {cloud.error && <p role="alert">{cloud.error}</p>}
      </div>
    </dialog>}
  </>;
}
