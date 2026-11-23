"use client";
import { useEffect, useRef, useState } from "react";
import { parseNodeClipboard, type NodeClipboard } from "@/lib/node-clipboard";
import { NodeClipboardSession } from "@/lib/node-clipboard-session";
import { clipboardShortcut } from "@/lib/clipboard-shortcut";
import type { Workspace } from "@/lib/model";

type Options = {
  workspace: Workspace | null;
  selectedIds: string[];
  generation: number;
  contextKey: string;
  blocked: boolean;
  inMap: boolean;
  paste: (clipboard: NodeClipboard, cut: boolean, offset: number) => { removedEdges: number };
};

export function useNodeClipboard(options: Options) {
  const latest = useRef(options);
  const contextRevision = useRef(0);
  if (latest.current.contextKey !== options.contextKey || latest.current.inMap !== options.inMap || latest.current.blocked !== options.blocked)
    contextRevision.current++;
  latest.current = options;
  const session = useRef(new NodeClipboardSession(options.generation));
  session.current.setGeneration(options.generation);
  const [cut, setCut] = useState<{ ids: string[]; generation: number } | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const clipboardSession = session.current;
    let active = true, operation = 0;
    let localOnlyToken: string | null = null;
    let keyGesture: { command: "copy" | "cut" | "paste"; handled: boolean } | null = null;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const editableSelector = 'input,textarea,select,[role="textbox"],[contenteditable]:not([contenteditable="false"])';
    function ignored(event?: Event) {
      const target = event?.target instanceof Element ? event.target : null;
      return event?.defaultPrevented || latest.current.blocked ||
        !!target?.closest(`${editableSelector},dialog,[role="dialog"],[role="menu"]`) ||
        !!document.activeElement?.closest(editableSelector) ||
        !!document.querySelector('dialog[open],[role="dialog"],[role="alertdialog"]');
    }
    function nativeSelection() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return false;
      const ancestor = selection.rangeCount ? selection.getRangeAt(0).commonAncestorContainer : null;
      const element = ancestor instanceof Element ? ancestor : ancestor?.parentElement;
      const editor = element?.closest(editableSelector);
      // A blurred rich-text range must not mask a selected graph node.
      return !editor || editor.contains(document.activeElement);
    }
    function clearMemory() {
      operation++;
      clipboardSession.clear();
      localOnlyToken = null;
      keyGesture = null;
      setCut(null);
    }
    function capture(cutting: boolean) {
      const { workspace, selectedIds, generation } = latest.current;
      if (!workspace) return null;
      const value = clipboardSession.capture(workspace, selectedIds, generation, cutting);
      if (!value) return null;
      window.getSelection()?.removeAllRanges();
      setCut(cutting ? { ids: clipboardSession.cutIds, generation } : null);
      setMessage(cutting
        ? `${value.nodes.length}개 노드 잘라내기 준비 · 다른 맵에서 Ctrl/⌘ V로 이동`
        : `${value.nodes.length}개 노드 복사됨 · 같은 맵이나 다른 맵에서 Ctrl/⌘ V`);
      return value;
    }
    function applyPaste(value: NodeClipboard) {
      const current = latest.current;
      if (!current.inMap) { setMessage("왼쪽에서 붙여넣을 맵을 먼저 선택하세요."); return; }
      try {
        const prepared = clipboardSession.preparePaste(value, current.generation);
        const result = current.paste(prepared.clipboard, prepared.cut, prepared.offset);
        clipboardSession.didPaste(prepared);
        setCut(null);
        setMessage(`${value.nodes.length}개 노드 ${prepared.cut ? "이동" : "붙여넣기"} 완료` +
          (result.removedEdges ? ` · 다른 맵에 남은 노드와의 연결 ${result.removedEdges}개 해제 · Ctrl/⌘ Z로 복원` : ""));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "붙여넣지 못했습니다.");
      }
    }
    function copy(event: ClipboardEvent) {
      if (ignored(event) || nativeSelection()) { clearMemory(); return; }
      if (keyGesture?.command === event.type) { event.preventDefault(); return; }
      if (!event.clipboardData) return;
      operation++;
      const value = capture(event.type === "cut");
      if (!value) return;
      event.clipboardData.setData("text/plain", JSON.stringify(value));
      event.preventDefault();
      localOnlyToken = null;
    }
    function paste(event: ClipboardEvent) {
      if (ignored(event)) return;
      if (keyGesture?.command === "paste" && keyGesture.handled) { event.preventDefault(); return; }
      operation++; // Native paste supersedes any pending asynchronous read.
      if (keyGesture?.command === "paste") keyGesture.handled = true;
      const value = event.clipboardData
        ? parseNodeClipboard(event.clipboardData.getData("text/plain"))
        : clipboardSession.memory;
      if (!value) return;
      event.preventDefault();
      applyPaste(value);
    }
    function keydown(event: KeyboardEvent) {
      const command = clipboardShortcut(event);
      if (!command) return;
      if (ignored(event)) { if (command !== "paste") clearMemory(); return; }
      if (command !== "paste" && nativeSelection()) { clearMemory(); return; }
      if (event.repeat) { event.preventDefault(); return; }
      if (command !== "paste") {
        const value = capture(command === "cut");
        if (!value) return;
        event.preventDefault();
        operation++;
        const generation = latest.current.generation;
        keyGesture = { command, handled: true };
        localOnlyToken = value.token;
        // Start inside the gesture: Safari rejects writes deferred until later.
        try {
          const writing = navigator.clipboard?.writeText(JSON.stringify(value));
          if (writing) void writing.then(() => {
            if (active && generation === latest.current.generation && localOnlyToken === value.token) localOnlyToken = null;
          }).catch(() => { /* The same-app memory copy remains usable. */ });
        } catch { /* Clipboard access can be unavailable in installed web apps. */ }
        return;
      }
      if (!latest.current.inMap) {
        event.preventDefault(); setMessage("왼쪽에서 붙여넣을 맵을 먼저 선택하세요."); return;
      }
      event.preventDefault();
      const request = ++operation;
      const { generation, contextKey } = latest.current;
      const revision = contextRevision.current;
      const gesture = { command, handled: false };
      keyGesture = gesture;
      const valid = () => active && request === operation && generation === latest.current.generation &&
        revision === contextRevision.current && contextKey === latest.current.contextKey && latest.current.inMap && !ignored();
      const finish = (value: NodeClipboard | null) => {
        if (!valid() || gesture.handled) return;
        gesture.handled = true;
        if (value) applyPaste(value);
      };
      const memory = clipboardSession.memory;
      if (memory?.token === localOnlyToken || !navigator.clipboard?.readText) {
        finish(memory);
        return;
      }
      // Ordinary clipboard text must never be replaced by an older node copy.
      // Only absent/denied access falls back to this workspace's memory.
      try {
        const reading = navigator.clipboard.readText();
        void reading.then(text => finish(parseNodeClipboard(text))).catch(() => finish(memory));
      } catch { finish(memory); }
    }
    function keyup(event: KeyboardEvent) {
      const commandReleased = (event.key === "Meta" || event.key === "Control") && !event.metaKey && !event.ctrlKey;
      if (!keyGesture || (!commandReleased && !/^[cxv]$/i.test(event.key) && !/^Key[CXV]$/.test(event.code))) return;
      const gesture = keyGesture;
      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => { if (keyGesture === gesture) keyGesture = null; }, 0);
    }
    function pause() {
      operation++;
      keyGesture = null;
      // Check the system clipboard on return, but keep a deferred cut intact.
      localOnlyToken = null;
    }
    function hidden() { if (document.hidden) pause(); }
    function focus(event: FocusEvent) {
      if (event.target instanceof Element && event.target.closest(editableSelector)) operation++;
    }
    window.addEventListener("copy", copy);
    window.addEventListener("cut", copy);
    window.addEventListener("paste", paste);
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", pause);
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("focusin", focus);
    return () => {
      active = false;
      operation++;
      clearTimeout(releaseTimer);
      clipboardSession.clear();
      window.removeEventListener("copy", copy);
      window.removeEventListener("cut", copy);
      window.removeEventListener("paste", paste);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", pause);
      document.removeEventListener("visibilitychange", hidden);
      document.removeEventListener("focusin", focus);
    };
  }, []);
  useEffect(() => {
    if (!message) return;
    const timeout = setTimeout(() => setMessage(""), 6500);
    return () => clearTimeout(timeout);
  }, [message]);
  return { cutIds: cut?.generation === options.generation ? cut.ids : [], message };
}
