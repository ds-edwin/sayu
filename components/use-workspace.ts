"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { blankWorkspace, documentSchema, type Workspace } from "@/lib/model";
import { getSetting, writeLocal, type LocalWorkspace } from "@/lib/local-store";
import { DocumentHistory } from "@/lib/history";
export function useWorkspace() {
  const history = useRef(new DocumentHistory<Workspace>());
  const [, refreshHistory] = useState(0);
  const [document, setDocument] = useState<Workspace | null>(null);
  const [status, setStatus] = useState("불러오는 중");
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const current = useRef<Workspace | null>(null),
    revision = useRef(0),
    persisted = useRef(""),
    busy = useRef(false),
    conflict = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(async () => {
    setError("");
    try {
      let local = await getSetting<LocalWorkspace>("workspace");
      if (!local) {
        let initial = blankWorkspace();
        try {
          const response = await fetch("./api/workspace", {
            cache: "no-store",
            signal: AbortSignal.timeout(5000),
          });
          if (response.ok)
            initial = documentSchema.parse(
              ((await response.json()) as { document: unknown }).document,
            );
        } catch {
          /* Offline first use: a blank workspace is editable. Legacy import stays available. */
        }
        try {
          await writeLocal(initial, 0);
        } catch {
          if (!(await getSetting("workspace")))
            throw Error("기기 저장소를 열 수 없습니다.");
        }
        local = await getSetting<LocalWorkspace>("workspace");
      }
      if (!local) throw Error("기기 저장소를 열 수 없습니다.");
      const parsed = documentSchema.parse(local.document);
      current.current = parsed;
      persisted.current = JSON.stringify(parsed);
      revision.current = local.revision;
      history.current.reset();
      conflict.current = false;
      setDocument(parsed);
      setStatus("기기에 저장됨");
      setNeedsLogin(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "기기 저장 실패");
      setStatus("저장소 오류");
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);
  const save = useCallback(async function persist(): Promise<void> {
    if (!current.current || busy.current || conflict.current) return;
    const snapshot = JSON.stringify(current.current);
    if (snapshot === persisted.current) {
      setStatus("기기에 저장됨");
      return;
    }
    busy.current = true;
    setStatus("저장 중…");
    try {
      revision.current = await writeLocal(
        JSON.parse(snapshot),
        revision.current,
      );
      persisted.current = snapshot;
      setError("");
      setStatus(
        JSON.stringify(current.current) === snapshot
          ? "기기에 저장됨"
          : "저장 대기",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "기기 저장 실패");
      setStatus("저장 실패");
      conflict.current = true;
    } finally {
      busy.current = false;
      if (
        !conflict.current &&
        JSON.stringify(current.current) !== persisted.current
      )
        timer.current = setTimeout(persist, 100);
    }
  }, []);
  const flush = useCallback(async (): Promise<Workspace> => {
    if (timer.current) clearTimeout(timer.current);
    while (busy.current) await new Promise((r) => setTimeout(r, 25));
    await save();
    if (
      !current.current ||
      conflict.current ||
      JSON.stringify(current.current) !== persisted.current
    )
      throw Error(
        "기기 저장을 먼저 완료하세요. 오류가 있으면 JSON을 내보낸 뒤 다시 불러오세요.",
      );
    return structuredClone(current.current);
  }, [save]);
  const replace = useCallback(
    async (next: Workspace, expected?: string) => {
      const before = await flush();
      if (expected !== undefined && JSON.stringify(before) !== expected)
        throw Error("동기화 중 편집되었습니다. 다시 동기화하세요.");
      const parsed = documentSchema.parse(next);
      busy.current = true;
      try {
        revision.current = await writeLocal(parsed, revision.current, true);
        persisted.current = JSON.stringify(parsed);
        if (JSON.stringify(current.current) !== JSON.stringify(before)) {
          timer.current = setTimeout(() => void save(), 100);
          throw Error(
            "동기화 중 추가 편집이 발생했습니다. 편집 내용은 유지됩니다. 다시 동기화하세요.",
          );
        }
        current.current = parsed;
        setDocument(parsed);
        history.current.reset();
        refreshHistory((v) => v + 1);
        setError("");
        setStatus("기기에 저장됨");
      } finally {
        busy.current = false;
      }
    },
    [flush, save],
  );
  const update = useCallback(
    (fn: (d: Workspace) => Workspace, group?: string) => {
      if (!current.current) return;
      const next = fn(current.current);
      if (!history.current.record(current.current, next, group)) return;
      refreshHistory((v) => v + 1);
      current.current = next;
      setDocument(next);
      setStatus("저장 대기");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), 200);
    },
    [save],
  );
  const restore = useCallback(
    (direction: "undo" | "redo") => {
      if (!current.current) return;
      const next = history.current[direction](current.current);
      if (!next) return;
      current.current = next;
      setDocument(next);
      setStatus("저장 대기");
      refreshHistory((v) => v + 1);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), 300);
    },
    [save],
  );
  const undo = useCallback(() => restore("undo"), [restore]);
  const redo = useCallback(() => restore("redo"), [restore]);
  const beginGroup = useCallback(() => history.current.begin(), []);
  const endGroup = useCallback(() => history.current.end(), []);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (
        current.current &&
        JSON.stringify(current.current) !== persisted.current
      ) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const keys = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    const hidden = () => {
      if (window.document.visibilityState === "hidden") void save();
    };
    window.document.addEventListener("visibilitychange", hidden);
    window.addEventListener("beforeunload", before);
    window.addEventListener("keydown", keys);
    return () => {
      window.document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("beforeunload", before);
      window.removeEventListener("keydown", keys);
    };
  }, [save]);
  return {
    flush,
    replace,
    document,
    status,
    error,
    needsLogin,
    load,
    update,
    save,
    undo,
    redo,
    beginGroup,
    endGroup,
    canUndo: history.current.past.length > 0,
    canRedo: history.current.future.length > 0,
  };
}
