"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { chooseLocalFolder, disconnectLocalFolder, permitLocalFolder, supportsLocalFolder, syncLocalFolder, FolderPermissionError, type FolderConfig } from "@/lib/local-folder";
type SyncSource = "drive" | "folder";
type Props = {
  flush: () => Promise<Workspace>;
  replace: (doc: Workspace, expected?: string) => Promise<void>;
};
export default function StorageControls({ flush, replace }: Props) {
  const [open, setOpen] = useState(false),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [offline, setOffline] = useState(false),
    [choices, setChoices] = useState<RemoteChoice[]>([]),
    [choiceSource, setChoiceSource] = useState<SyncSource>("drive");
  const running = useRef(false),
    actions = useRef({ flush, replace });
  actions.current = { flush, replace };
  const synchronize = useRef<(resolution?: string, source?: SyncSource) => Promise<void>>(
    async () => {},
  );
  synchronize.current = async (resolution, source = "drive") => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage(source === "folder" ? "선택한 폴더 확인 중…" : "OneDrive 동기화 중…");
    try {
      const doc = await actions.current.flush();
      setMessage(await (source === "folder" ? syncLocalFolder : syncDrive)(doc, actions.current.replace, resolution));
      setChoices([]);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "동기화 실패");
      if (e instanceof SyncConflict) {
        await setSetting(source === "folder" ? "folder-auto-sync" : "auto-sync", false);
        setChoices(e.choices);
        setChoiceSource(source);
        setOpen(true);
      }
      if (e instanceof FolderPermissionError) await setSetting("folder-auto-sync", false);
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
      if (document.visibilityState !== "visible") return;
      if ((await getSetting("folder-auto-sync")) && (await getSetting("folder-config"))) {
        await synchronize.current(undefined, "folder");
        return;
      }
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
    window.addEventListener("focus", saved);
    document.addEventListener("visibilitychange", saved);
    return () => {
      clearTimeout(debounce);
      clearInterval(timer);
      window.removeEventListener("sayu-local-saved", saved);
      window.removeEventListener("online", saved);
      window.removeEventListener("focus", saved);
      document.removeEventListener("visibilitychange", saved);
    };
  }, []);
  return (
    <>
      <button className="nav-item" onClick={() => setOpen(true)}>
        <Database size={17} /> 저장소 · 설치
      </button>
      {open && createPortal(
        <StorageDialog
          {...{ flush, replace, busy, message, choices, choiceSource, offline }}
          sync={(resolution, source) => synchronize.current(resolution, source)}
          close={() => setOpen(false)}
          report={setMessage}
        />, document.body
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
  choiceSource,
  offline,
  sync,
  close,
  report,
}: Props & {
  busy: boolean;
  message: string;
  choices: RemoteChoice[];
  choiceSource: SyncSource;
  offline: boolean;
  sync: (resolution?: string, source?: SyncSource) => Promise<void>;
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
    [localFolder, setLocalFolder] = useState<FolderConfig | null>(null),
    [folderAuto, setFolderAuto] = useState(false),
    [folderLast, setFolderLast] = useState(""),
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
    setLocalFolder((await getSetting<FolderConfig>("folder-config")) ?? null);
    setFolderAuto(!!(await getSetting("folder-auto-sync")));
    setFolderLast((await getSetting<string>("folder-last-sync")) ?? "");
    setRecovery((await getSetting("recovery")) ?? []);
  }
  useEffect(() => {
    dialog.current?.showModal();
    void refresh().catch((e) => report(e.message));
  }, []);
  useEffect(() => {
    if (!busy) void refresh().catch((e) => report(e.message));
  }, [busy]);
  async function run(action: () => Promise<void>) {
    if (blocked) return;
    setWorking(true);
    try {
      await action();
      await refresh();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
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
        OneDrive가 동기화하는 기기 폴더를 연결하거나 JSON 파일을 다른 기기에서 열 수 있습니다.
      </p>
      {message && <p className="storage-message" role="status">{message}</p>}
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
          {offline ? "오프라인 자료 설치 완료. " : "오프라인 자료를 준비하고 있습니다. "}
          첫 실행과 설치는 온라인에서 진행하세요. 앱과 오프라인 자료가
          내려받아진 뒤에는 인터넷 없이 편집할 수 있습니다. 앱을 삭제하거나
          브라우저 데이터를 지우기 전에는 반드시 내보내세요.
        </small>
      </section>
      <section>
        <h3>2. 기기 폴더 연결 · Microsoft 앱 등록 불필요</h3>
        <p>
          Mac·Windows의 Chrome/Edge에서 OneDrive 안의 사유 전용 폴더를 선택하세요.
          각 기기에서 같은 클라우드 폴더를 선택하고 OneDrive 앱의 동기화가 완료되었는지 확인하세요.
          다른 문서는 수정하지 않으며 사유의 버전 파일은 sayu-versions 폴더에 보관됩니다.
        </p>
        <p><b>연결된 폴더:</b> {localFolder?.handle.name ?? "없음"}</p>
        {supportsLocalFolder() ? (
          <div className="storage-actions">
            <button disabled={blocked} onClick={() => void run(async () => {
              await chooseLocalFolder();
              await sync(undefined, "folder");
            })}>기기 폴더 선택 · 연결</button>
            <button disabled={blocked || !localFolder} onClick={() => void run(async () => {
              await permitLocalFolder();
              await sync(undefined, "folder");
            })}>폴더 접근 허용 · 동기화</button>
            <button disabled={blocked || !localFolder} onClick={() => void run(async () => {
              await disconnectLocalFolder();
              report("폴더 연결을 해제했습니다. 기기 내용과 폴더 파일은 보관됩니다.");
            })}>폴더 연결 해제</button>
          </div>
        ) : <p>이 브라우저는 폴더 자동 저장을 지원하지 않습니다. iPad·Safari에서는 아래의 JSON 파일 열기·저장을 이용하세요.</p>}
        <label className="storage-check">
          <input type="checkbox" checked={folderAuto} disabled={blocked || !localFolder || !supportsLocalFolder()}
            onChange={e => {
              const value = e.target.checked;
              void run(async () => {
                if (value) await permitLocalFolder();
                await setSetting("folder-auto-sync", value);
                if (value) await setSetting("auto-sync", false);
                if (value) await sync(undefined, "folder");
              });
            }} /> 앱을 열어 둔 동안 폴더 자동 저장·불러오기
        </label>
        <small>
          저장 뒤 약 5초 및 1분마다 확인합니다. 브라우저를 다시 열면 폴더 접근 허용이 필요할 수 있습니다.
          이 표시는 기기 폴더에 저장된 시점이며 OneDrive 업로드 완료 표시는 아닙니다.
          마지막 성공: {folderLast ? new Date(folderLast).toLocaleString() : "없음"}
        </small>
        <p>기존 JSON 백업은 아래 ‘JSON 파일 열기’로 가져온 뒤 연결하세요. 다른 내용이 있는 폴더를 처음 연결하면 사용할 버전을 선택합니다.</p>
      </section>
      <section>
        <h3>3. OneDrive 온라인 연결 · 선택 사항</h3>
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
              if (value) { setFolderAuto(false); void setSetting("folder-auto-sync", false); }
            }}
          />{" "}
          앱을 열어 둔 동안 자동 동기화
        </label>
        <small>
          저장 뒤 약 5초 및 1분마다 확인합니다. iPad에서 앱을 닫으면 동기화가
          멈춥니다. 마지막 성공:{" "}
          {last ? new Date(last).toLocaleString() : "없음"}
        </small>
      </section>
        {choices.length > 0 && (
          <section className="storage-conflicts">
            <b>{choiceSource === "folder" ? "기기 폴더" : "OneDrive"} 버전 선택 — 원본 버전은 삭제하지 않습니다</b>
            <button
              disabled={blocked}
              onClick={() => {
                if (
                  confirm(
                    "이 기기의 내용을 최신 버전으로 지정할까요? 저장소의 다른 버전은 모두 보관됩니다.",
                  )
                )
                  void run(() => sync("local", choiceSource));
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
                        "이 저장소 버전을 사용하겠습니까? 이 기기 내용은 복원 기록에 보관됩니다.",
                      )
                    )
                      void run(() => sync(choice.id, choiceSource));
                  }}
                >
                  이 버전 사용
                </button>
              </div>
            ))}
          </section>
        )}
      <section>
        <h3>4. 파일 저장소 · 백업</h3>
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
