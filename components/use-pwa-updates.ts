"use client";
import { useEffect, useRef, useState } from "react";
import { appBaseUrl } from "@/lib/app-url";

const CHECK_INTERVAL = 60_000;
const ACTIVATION_TIMEOUT = 20_000;

export function usePwaUpdates(flush: () => Promise<unknown>) {
  const save = useRef(flush);
  save.current = flush;
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const mounted = useRef(false);
  const applyingRef = useRef(false);
  const availableRef = useRef(false);
  const cancelActivation = useRef<(() => void) | null>(null);
  const [offline, setOffline] = useState(false);
  const [available, setAvailable] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    mounted.current = true;
    if (!("serviceWorker" in navigator)) return () => { mounted.current = false; };
    const serviceWorker = navigator.serviceWorker;
    let disposed = false;
    let previousController = serviceWorker.controller;
    let lastCheck = 0;
    let checking = false;
    const cleanup: Array<() => void> = [];
    const watched = new Set<ServiceWorker>();
    function readyToUpdate() {
      if (disposed) return;
      availableRef.current = true;
      setAvailable(true);
    }
    function inspectWaiting() {
      if (registration.current?.waiting) readyToUpdate();
    }
    function watch(worker: ServiceWorker | null) {
      if (!worker || watched.has(worker)) return;
      watched.add(worker);
      const change = () => {
        if (disposed) return;
        inspectWaiting();
        if (worker.state === "installed" && serviceWorker.controller) readyToUpdate();
        if (worker.state === "redundant" && !serviceWorker.controller)
          setError("오프라인 자료를 준비하지 못했습니다. 온라인 상태에서 다시 열어 주세요.");
      };
      worker.addEventListener("statechange", change);
      cleanup.push(() => worker.removeEventListener("statechange", change));
      change();
    }
    const controllerChanged = () => {
      const controller = serviceWorker.controller;
      if (controller && controller !== previousController) {
        setOffline(true);
        // Another tab may activate an update. This tab reloads only after its own save button.
        if (previousController) readyToUpdate();
      }
      previousController = controller;
    };
    const check = () => {
      const current = registration.current;
      if (disposed || !current || checking || applyingRef.current ||
          document.visibilityState !== "visible" || !navigator.onLine ||
          Date.now() - lastCheck < CHECK_INTERVAL) return;
      lastCheck = Date.now();
      checking = true;
      void current.update().then(() => {
        if (!disposed) { inspectWaiting(); watch(current.installing); }
      }).catch(() => {
        // A failed background check leaves the current offline app usable.
      }).finally(() => { checking = false; });
    };
    serviceWorker.addEventListener("controllerchange", controllerChanged);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", check);
    void serviceWorker.register(new URL("sw.js", appBaseUrl()).href, {
      scope: appBaseUrl(), updateViaCache: "none",
    }).then(current => {
      if (disposed) return;
      registration.current = current;
      const found = () => { inspectWaiting(); watch(current.installing); };
      current.addEventListener("updatefound", found);
      cleanup.push(() => current.removeEventListener("updatefound", found));
      inspectWaiting();
      watch(current.installing);
      void serviceWorker.ready.then(() => { if (!disposed) setOffline(true); });
      check();
    }).catch(() => {
      if (!disposed) setError("오프라인 자료를 준비하지 못했습니다. 온라인 상태에서 다시 열어 주세요.");
    });
    return () => {
      disposed = true;
      mounted.current = false;
      registration.current = null;
      cancelActivation.current?.();
      cancelActivation.current = null;
      serviceWorker.removeEventListener("controllerchange", controllerChanged);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", check);
      cleanup.forEach(remove => remove());
    };
  }, []);

  async function applyUpdate() {
    if (applyingRef.current || !availableRef.current || !registration.current) return;
    applyingRef.current = true;
    setApplying(true);
    setError("");
    let reloading = false;
    try {
      await save.current();
      if (!mounted.current) return;
      const waiting = registration.current?.waiting;
      if (waiting) {
        await new Promise<void>((resolve, reject) => {
          const serviceWorker = navigator.serviceWorker;
          const previous = serviceWorker.controller;
          let timer: ReturnType<typeof setTimeout>;
          let settled = false;
          function finish(problem?: Error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            serviceWorker.removeEventListener("controllerchange", changed);
            waiting!.removeEventListener("statechange", stateChanged);
            cancelActivation.current = null;
            if (problem) reject(problem); else resolve();
          }
          function changed() {
            if (serviceWorker.controller && serviceWorker.controller !== previous) finish();
          }
          function stateChanged() {
            if (waiting!.state === "redundant") finish(Error("새 버전을 적용하지 못했습니다. 다시 시도해 주세요."));
          }
          cancelActivation.current = () => finish(Error("업데이트가 중단되었습니다."));
          serviceWorker.addEventListener("controllerchange", changed);
          waiting.addEventListener("statechange", stateChanged);
          timer = setTimeout(() => finish(Error("새 버전 적용을 확인하지 못했습니다. 열린 앱 탭을 모두 닫고 다시 열거나 다시 시도해 주세요.")), ACTIVATION_TIMEOUT);
          try { waiting.postMessage({ type: "SKIP_WAITING" }); }
          catch (problem) { finish(problem instanceof Error ? problem : Error("새 버전을 적용하지 못했습니다.")); }
        });
      }
      if (!mounted.current) return;
      await save.current();
      if (mounted.current) { reloading = true; window.location.reload(); }
    } catch (problem) {
      reloading = false;
      if (mounted.current) setError(problem instanceof Error ? problem.message : "업데이트하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      if (!reloading) {
        applyingRef.current = false;
        if (mounted.current) setApplying(false);
      }
    }
  }

  return { offline, available, applying, error, applyUpdate, dismissError: () => setError("") };
}
