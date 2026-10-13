"use client";
import { useEffect, useRef, useState } from "react";
import { Database, Cloud, Download, X } from "lucide-react";
import {
  getSetting,
  setSetting,
  parsePortable,
  exportFile,
} from "@/lib/local-store";
import {
  finishSignIn,
  signIn,
  disconnect,
  syncDrive,
  SyncConflict,
  type RemoteChoice,
  type DriveConfig,
} from "@/lib/onedrive";
import type { Workspace } from "@/lib/model";
import { appBaseUrl } from "@/lib/app-url";
type Props = {
  flush: () => Promise<Workspace>;
  replace: (doc: Workspace, expected?: string) => Promise<void>;
};
export default function StorageControls({ flush, replace }: Props) {
  const [open, setOpen] = useState(false),
    [message, setMessage] = useState("기기 저장 · 저장소 선택"),
    [busy, setBusy] = useState(false),
    [offline, setOffline] = useState(false),
    [choices, setChoices] = useState<RemoteChoice[]>([]);
  const running = useRef(false),
    actions = useRef({ flush, replace });
  actions.current = { flush, replace };
  const synchronize = useRef<(resolution?: string) => Promise<void>>(
    async () => {},
  );
  synchronize.current = async (resolution) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("OneDrive 동기화 중…");
    try {
      const doc = await actions.current.flush();
      setMessage(await syncDrive(doc, actions.current.replace, resolution));
      setChoices([]);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "동기화 실패");
      if (e instanceof SyncConflict) {
        await setSetting("auto-sync", false);
        setChoices(e.choices);
        setOpen(true);
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    void finishSignIn().catch((e) => setMessage(e.message));
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register(new URL("sw.js", appBaseUrl()).href, { scope: appBaseUrl() })
        .then(() => navigator.serviceWorker.ready)
        .then(() => setOffline(true))
        .catch(() =>
          setMessage("오프라인 설치 실패. 온라인 상태에서 다시 열어 주세요."),
        );
    }
    void navigator.storage?.persist?.();
    let debounce: ReturnType<typeof setTimeout>;
    const attempt = async () => {
      if (
        document.visibilityState === "visible" &&
        navigator.onLine &&
        (await getSetting("auto-sync")) &&
        (await getSetting("drive-config"))
      )
        await synchronize.current();
    };
    const saved = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void attempt(), 5000);
    };
    const timer = setInterval(() => void attempt(), 60000);
    window.addEventListener("sayu-local-saved", saved);
    window.addEventListener("online", saved);
    return () => {
      clearTimeout(debounce);
      clearInterval(timer);
      window.removeEventListener("sayu-local-saved", saved);
      window.removeEventListener("online", saved);
    };
  }, []);
  return (
    <>
      <button className="nav-item" onClick={() => setOpen(true)}>
        <Database size={17} /> 저장소 · 설치
      </button>
      <small className="storage-summary" role="status">
        {message}
        <br />
        {offline ? "오프라인 실행 준비됨" : "오프라인 자료 준비 중"}
      </small>
      {open && (
        <StorageDialog
          {...{ flush, replace, busy, message, choices }}
          sync={(resolution) => synchronize.current(resolution)}
          close={() => setOpen(false)}
          report={setMessage}
        />
      )}
    </>
  );
}
function StorageDialog({
  flush,
  replace,
  busy,
  message,
  choices,
  sync,
  close,
  report,
}: Props & {
  busy: boolean;
  message: string;
  choices: RemoteChoice[];
  sync: (resolution?: string) => Promise<void>;
  close: () => void;
  report: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [clientId, setClientId] = useState(""),
    [folder, setFolder] = useState("MyThoughts"),
    [auto, setAuto] = useState(false),
    [working, setWorking] = useState(false),
    [last, setLast] = useState(""),
    [recovery, setRecovery] = useState<{ date: string; document: Workspace }[]>(
      [],
    ),
    [file, setFile] = useState<{ name: string; document: Workspace } | null>(
      null,
    );
  const blocked = busy || working;
  async function refresh() {
    const config = await getSetting<DriveConfig>("drive-config");
    if (config) {
      setClientId(config.clientId);
      setFolder(config.folder);
    }
    setAuto(!!(await getSetting("auto-sync")));
    setLast((await getSetting<string>("last-sync")) ?? "");
    setRecovery((await getSetting("recovery")) ?? []);
  }
  useEffect(() => {
    dialog.current?.showModal();
    void refresh().catch((e) => report(e.message));
  }, []);
  async function run(action: () => Promise<void>) {
    if (blocked) return;
    setWorking(true);
    try {
      await action();
      await refresh();
    } catch (e) {
      report(e instanceof Error ? e.message : "작업 실패");
    } finally {
      setWorking(false);
    }
  }
  async function saveFile() {
    const picker = (
      window as typeof window & {
        showSaveFilePicker?: (
          options: unknown,
        ) => Promise<{
          createWritable: () => Promise<{
            write: (value: string) => Promise<void>;
            close: () => Promise<void>;
          }>;
        }>;
      }
    ).showSaveFilePicker;
    const handle = picker
      ? await picker({
          suggestedName: `sayu-${new Date().toISOString().slice(0, 10)}.json`,
          types: [
            {
              description: "사유 작업실",
              accept: { "application/json": [".json"] },
            },
          ],
        })
      : null;
    const doc = await flush();
    const value = JSON.stringify(
      {
        format: "sayu-workspace",
        version: 1,
        createdAt: new Date().toISOString(),
        document: doc,
      },
      null,
      2,
    );
    if (handle) {
      const writable = await handle.createWritable();
      await writable.write(value);
      await writable.close();
      report("선택한 파일에 저장했습니다.");
      return;
    }
    const file = new File(
      [value],
      `sayu-${new Date().toISOString().slice(0, 10)}.json`,
      { type: "application/json" },
    );
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "사유 작업실" });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    }
    exportFile(doc);
  }
  return (
    <dialog
      ref={dialog}
      className="storage-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (!blocked) close();
      }}
      aria-label="저장소 및 앱 설치"
    >
      <header>
        <h2>저장소 · 앱 설치</h2>
        <button
          className="icon-button"
          aria-label="닫기"
          disabled={blocked}
          onClick={close}
        >
          <X />
        </button>
      </header>
      <p>
        편집 내용은 먼저 이 기기에 저장됩니다. 다른 기기에서 이어 쓰려면
        JSON 파일을 OneDrive에 저장하고 다른 기기에서 열 수 있습니다. 자동 동기화는 Microsoft 앱 등록 후 연결할 수 있습니다.
      </p>
      <p className="storage-message" role="status">
        {message}
      </p>
      <section>
        <h3>1. 앱처럼 설치</h3>
        <p>
          <b>iPad:</b> Safari → 공유 → 홈 화면에 추가 → 웹 앱으로 열기.
          <br />
          <b>Mac:</b> Safari → 파일 → Dock에 추가, 또는 Chrome의 앱 설치.
          <br />
          <b>Windows:</b> Edge/Chrome 주소창의 설치 버튼.
        </p>
        <small>
          첫 실행과 설치는 온라인에서 진행하세요. 앱과 오프라인 자료가
          내려받아진 뒤에는 인터넷 없이 편집할 수 있습니다. 앱을 삭제하거나
          브라우저 데이터를 지우기 전에는 반드시 내보내세요.
        </small>
      </section>
      <section>
        <h3>2. OneDrive 개인용 · 선택 사항</h3>
        <p>
          앱 전용 폴더 아래의 작업실 이름을 지정합니다. 모든 기기에 같은 Client
          ID와 작업실 이름을 입력하세요.
        </p>
        <label>
          Microsoft 앱 Client ID
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value.trim())}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            disabled={blocked}
          />
        </label>
        <label>
          작업실 폴더 이름
          <input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            maxLength={50}
            disabled={blocked}
          />
        </label>
        <details>
          <summary>처음 한 번 필요한 Microsoft 설정</summary>
          <ol>
            <li>
              Microsoft Entra 앱 등록에서 개인 Microsoft 계정을 허용하는 앱을
              만드세요.
            </li>
            <li>
              인증 플랫폼을 <b>단일 페이지 애플리케이션(SPA)</b>으로 추가하세요.
            </li>
            <li>
              리디렉션 URI를{" "}
              <code>
                {typeof location === "undefined" ? "" : appBaseUrl()}
              </code>
              로 등록하세요.
            </li>
            <li>
              Microsoft Graph 위임 권한 <code>Files.ReadWrite.AppFolder</code>를
              추가하세요.
            </li>
            <li>
              앱의 Application (client) ID를 위에 입력하세요. Client Secret은
              만들거나 입력하지 않습니다.
            </li>
          </ol>
          <p>
            폴더 지정만으로 Microsoft 인증을 생략할 수는 없습니다. 등록 전에도
            아래 JSON 파일 방식으로 사용할 수 있습니다.
          </p>
        </details>
        <div className="storage-actions">
          <button
            disabled={blocked}
            onClick={() =>
              void run(async () => {
                await flush();
                await signIn({ clientId, folder });
              })
            }
          >
            OneDrive 로그인 · 연결
          </button>
          <button disabled={blocked || !clientId} onClick={() => void sync()}>
            <Cloud size={16} /> 지금 동기화
          </button>
          <button
            disabled={blocked}
            onClick={() =>
              void run(async () => {
                await disconnect();
                await setSetting("auto-sync", false);
                setClientId("");
                report(
                  "연결 해제됨. 기기 데이터와 OneDrive 파일은 유지됩니다.",
                );
              })
            }
          >
            연결 해제
          </button>
        </div>
        <label className="storage-check">
          <input
            type="checkbox"
            checked={auto}
            disabled={blocked}
            onChange={(e) => {
              const value = e.target.checked;
              setAuto(value);
              void setSetting("auto-sync", value);
            }}
          />{" "}
          앱을 열어 둔 동안 자동 동기화
        </label>
        <small>
          저장 뒤 약 5초 및 1분마다 확인합니다. iPad에서 앱을 닫으면 동기화가
          멈춥니다. 마지막 성공:{" "}
          {last ? new Date(last).toLocaleString() : "없음"}
        </small>
        {choices.length > 0 && (
          <div className="storage-conflicts">
            <b>충돌 해결 — 원본 버전은 삭제하지 않습니다</b>
            <button
              disabled={blocked}
              onClick={() => {
                if (
                  confirm(
                    "이 기기의 내용을 공유 최신 버전으로 지정할까요? 다른 버전은 OneDrive에 보관됩니다.",
                  )
                )
                  void sync("local");
              }}
            >
              이 기기 내용 유지
            </button>
            {choices.map((choice) => (
              <div key={choice.id}>
                <p>
                  {choice.date} · 노드 {choice.document.nodes.length} · 맵{" "}
                  {choice.document.maps.length}
                </p>
                <button onClick={() => exportFile(choice.document)}>
                  이 버전 내보내기
                </button>
                <button
                  disabled={blocked}
                  onClick={() => {
                    if (
                      confirm(
                        "이 OneDrive 버전을 사용하겠습니까? 이 기기 내용은 복원 기록에 보관됩니다.",
                      )
                    )
                      void sync(choice.id);
                  }}
                >
                  이 버전 사용
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      <section>
        <h3>3. 파일 저장소 · 백업</h3>
        <p>
          JSON 파일을 OneDrive·iCloud·기기 폴더에 저장하고 다른 기기에서 열 수
          있습니다. 이 방식은 수동 이동이며 자동 동기화가 아닙니다.
        </p>
        <div className="storage-actions">
          <button disabled={blocked} onClick={() => void run(saveFile)}>
            <Download size={16} /> 파일로 저장 / 공유
          </button>
          <button disabled={blocked} onClick={() => input.current?.click()}>
            JSON 파일 열기
          </button>
          <button
            disabled={blocked}
            onClick={() =>
              void run(async () => {
                const r = await fetch(new URL("api/workspace", appBaseUrl()), { cache: "no-store" });
                if (!r.ok)
                  throw Error(
                    "기존 온라인 데이터에 접근할 수 없습니다. 원래 앱에서 JSON을 내보내 가져오세요.",
                  );
                const value = (await r.json()) as { document: unknown };
                setFile({
                  name: "기존 온라인 저장본",
                  document: parsePortable(value.document),
                });
              })
            }
          >
            기존 온라인 저장본 가져오기
          </button>
        </div>
        <input
          ref={input}
          hidden
          type="file"
          accept=".json,application/json"
          onChange={(e) => {
            const selected = e.target.files?.[0];
            e.target.value = "";
            if (selected)
              void run(async () => {
                if (selected.size > 15 * 1024 * 1024)
                  throw Error("15MB 이하의 JSON만 열 수 있습니다.");
                setFile({
                  name: selected.name,
                  document: parsePortable(JSON.parse(await selected.text())),
                });
              });
          }}
        />
        {file && (
          <div className="storage-preview">
            <b>{file.name}</b>
            <p>
              폴더 {file.document.folders.length} · 맵{" "}
              {file.document.maps.length} · 노드 {file.document.nodes.length} ·
              연결 {file.document.edges.length}
            </p>
            <button
              disabled={blocked}
              onClick={() => {
                if (
                  confirm(
                    "이 파일로 현재 작업실 전체를 교체할까요? 기존 내용은 이 기기의 복원 기록에 보관됩니다.",
                  )
                )
                  void run(async () => {
                    await replace(file.document);
                    setFile(null);
                    report(
                      "가져오기 완료. OneDrive 연결 시 다음 동기화에서 변경을 확인하세요.",
                    );
                  });
              }}
            >
              이 내용으로 가져오기
            </button>
            <button onClick={() => setFile(null)}>취소</button>
          </div>
        )}
        <details>
          <summary>이 기기의 복원 기록 ({recovery.length}/20)</summary>
          {recovery.map((item, index) => (
            <div key={index}>
              <span>
                {new Date(item.date).toLocaleString()} ·{" "}
                {item.document.nodes.length} 노드{" "}
              </span>
              <button
                disabled={blocked}
                onClick={() =>
                  setFile({ name: item.date, document: item.document })
                }
              >
                미리보기
              </button>
              <button onClick={() => exportFile(item.document)}>
                내보내기
              </button>
            </div>
          ))}
        </details>
      </section>
    </dialog>
  );
}
