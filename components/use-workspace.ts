"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { blankWorkspace, documentSchema, type Workspace } from "@/lib/model";
import { readLocal, prepareAccountWorkspace, writeLocal, LocalRevisionConflict } from "@/lib/local-store";
import { DocumentHistory } from "@/lib/history";
export function useWorkspace(scope?: string) {
  // Each callback retains its own account's references, even if a late database
  // operation completes after the signed-in account has changed.
  const binding = useMemo(() => ({
    active: true,
    loadVersion: 0,
    history: { current: new DocumentHistory<Workspace>() },
    current: { current: null as Workspace | null },
    revision: { current: 0 },
    persisted: { current: "" },
    busy: { current: false },
    conflict: { current: false },
    timer: { current: null as ReturnType<typeof setTimeout> | null },
  }), [scope]);
  const { history, current, revision, persisted, busy, conflict, timer } = binding;
  const [loadedBinding, setLoadedBinding] = useState(binding);
  const [, refreshHistory] = useState(0);
  const [document, setDocument] = useState<Workspace | null>(null);
  const [status, setStatus] = useState("불러오는 중");
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [generation, setGeneration] = useState(0);
  const load = useCallback(async () => {
    if (!binding.active) return;
    const loadVersion = ++binding.loadVersion;
    setLoadedBinding(binding);
    setDocument(null);
    setStatus("불러오는 중");
    setError("");
    try {
      let local = scope === undefined ? await readLocal() : await prepareAccountWorkspace(scope);
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
          await writeLocal(initial, 0, false, scope);
        } catch {
          if (!(await readLocal(scope)))
            throw Error("기기 저장소를 열 수 없습니다.");
        }
        local = await readLocal(scope);
      }
      if (!binding.active || loadVersion !== binding.loadVersion) return;
      if (!local) throw Error("기기 저장소를 열 수 없습니다.");
      const parsed = documentSchema.parse(local.document);
      current.current = parsed;
      persisted.current = JSON.stringify(parsed);
      revision.current = local.revision;
      history.current.reset();
      conflict.current = false;
      setDocument(parsed);
      setGeneration(value => value + 1);
      setStatus("기기에 저장됨");
      setNeedsLogin(false);
    } catch (e) {
      if (!binding.active || loadVersion !== binding.loadVersion) return;
      setError(e instanceof Error ? e.message : "기기 저장 실패");
      setStatus("저장소 오류");
    }
  }, [binding, scope]);
  const save = useCallback(async function persist(): Promise<void> {
    if (!current.current || busy.current || conflict.current) return;
    const snapshot = JSON.stringify(current.current);
    if (snapshot === persisted.current) {
      if (binding.active) { setError(""); setStatus("기기에 저장됨"); }
      return;
    }
    busy.current = true;
    let succeeded = false;
    if (binding.active) setStatus("저장 중…");
    try {
      revision.current = await writeLocal(
        JSON.parse(snapshot),
        revision.current,
        false,
        scope,
      );
      persisted.current = snapshot;
      succeeded = true;
      if (binding.active) {
        setError("");
        setStatus(JSON.stringify(current.current) === snapshot ? "기기에 저장됨" : "저장 대기");
      }
    } catch (e) {
      if (binding.active) {
        setError(e instanceof Error ? e.message : "기기 저장 실패");
        setStatus("저장 실패");
      }
      // Validation or storage errors can be corrected and retried. Only a stale
      // tab must stop writing until its newer on-disk revision is reconciled.
      conflict.current = e instanceof LocalRevisionConflict;
    } finally {
      busy.current = false;
      if (
        binding.active && !conflict.current &&
        (succeeded || JSON.stringify(current.current) !== snapshot) &&
        JSON.stringify(current.current) !== persisted.current
      )
        timer.current = setTimeout(persist, 100);
    }
  }, [binding, scope]);
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
  useEffect(() => {
    binding.active = true;
    void load();
    return () => {
      binding.active = false;
      binding.loadVersion++;
      if (timer.current) clearTimeout(timer.current);
      // Normal sign-out flushes first. This also preserves a pending draft on
      // an unexpected auth change, always under the previous account's key.
      if (current.current) void flush().catch(() => {});
    };
  }, [binding, load, flush]);
  const replace = useCallback(
    async (next: Workspace, expected?: string) => {
      const before = await flush();
      if (expected !== undefined && JSON.stringify(before) !== expected)
        throw Error("동기화 중 편집되었습니다. 다시 동기화하세요.");
      const parsed = documentSchema.parse(next);
      busy.current = true;
      try {
        revision.current = await writeLocal(parsed, revision.current, true, scope);
        persisted.current = JSON.stringify(parsed);
        if (JSON.stringify(current.current) !== JSON.stringify(before)) {
          if (binding.active) timer.current = setTimeout(() => void save(), 100);
          throw Error(
            "동기화 중 추가 편집이 발생했습니다. 편집 내용은 유지됩니다. 다시 동기화하세요.",
          );
        }
        current.current = parsed;
        history.current.reset();
        if (binding.active) {
          setDocument(parsed);
          setGeneration(value => value + 1);
          refreshHistory((v) => v + 1);
          setError("");
          setStatus("기기에 저장됨");
        }
      } finally {
        busy.current = false;
      }
    },
    [binding, scope, flush, save],
  );
  const update = useCallback(
    (fn: (d: Workspace) => Workspace, group?: string) => {
      if (!binding.active || !current.current) return;
      const next = fn(current.current);
      if (!history.current.record(current.current, next, group)) return;
      refreshHistory((v) => v + 1);
      current.current = next;
      setDocument(next);
      setStatus("저장 대기");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), 200);
    },
    [binding, save],
  );
  const restore = useCallback(
    (direction: "undo" | "redo") => {
      if (!binding.active || !current.current) return;
      const next = history.current[direction](current.current);
      if (!next) return;
      current.current = next;
      setDocument(next);
      setStatus("저장 대기");
      refreshHistory((v) => v + 1);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), 300);
    },
    [binding, save],
  );
  const undo = useCallback(() => restore("undo"), [restore]);
  const redo = useCallback(() => restore("redo"), [restore]);
  const beginGroup = useCallback(() => history.current.begin(), [binding]);
  const endGroup = useCallback(() => history.current.end(), [binding]);
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
    scope,
    flush,
    replace,
    document: loadedBinding === binding ? document : null,
    status: loadedBinding === binding ? status : "불러오는 중",
    error: loadedBinding === binding ? error : "",
    needsLogin,
    generation,
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
