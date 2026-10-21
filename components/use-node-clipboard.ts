"use client";
import { useEffect, useRef, useState } from "react";
import { captureNodeClipboard, parseNodeClipboard, type NodeClipboard } from "@/lib/node-clipboard";
import type { Workspace } from "@/lib/model";

type Options = {
  workspace: Workspace | null;
  selectedIds: string[];
  generation: number;
  blocked: boolean;
  inMap: boolean;
  paste: (clipboard: NodeClipboard, cut: boolean, offset: number) => { removedEdges: number };
};

export function useNodeClipboard(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const pendingCut = useRef<{ clipboard: NodeClipboard; generation: number } | null>(null);
  const [cut, setCut] = useState<{ ids: string[]; generation: number } | null>(null);
  const [message, setMessage] = useState("");
  const lastPaste = useRef({ token: "", count: 0 });
  useEffect(() => {
    function ignored(event: ClipboardEvent) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      return event.defaultPrevented || latest.current.blocked ||
        target?.isContentEditable ||
        !!target?.closest('input,textarea,select,[role="textbox"],dialog,[role="dialog"]') ||
        !!document.querySelector('dialog[open],[role="dialog"],[role="alertdialog"]');
    }
    function copy(event: ClipboardEvent) {
      if (ignored(event)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        const ancestor = selection.rangeCount ? selection.getRangeAt(0).commonAncestorContainer : null;
        const element = ancestor instanceof Element ? ancestor : ancestor?.parentElement;
        const editor = element?.closest('[contenteditable="true"],[contenteditable=""],input,textarea,[role="textbox"]');
        // Chromium keeps a rich-text range after focus moves onto a node. That
        // blurred selection must not mask node shortcuts. Focused editing and
        // explicitly selected ordinary page text retain native copy behavior.
        if (!editor || editor.contains(document.activeElement)) return;
      }
      const { workspace, selectedIds, generation } = latest.current;
      if (!workspace || !event.clipboardData) return;
      const clipboard = captureNodeClipboard(workspace, selectedIds);
      if (!clipboard) return;
      selection?.removeAllRanges();
      event.clipboardData.setData("text/plain", JSON.stringify(clipboard));
      event.preventDefault();
      const cutting = event.type === "cut";
      pendingCut.current = cutting ? { clipboard, generation } : null;
      setCut(cutting ? { ids: clipboard.nodes.map(n => n.id), generation } : null);
      lastPaste.current = { token: clipboard.token, count: 0 };
      setMessage(cutting
        ? `${clipboard.nodes.length}개 노드 잘라내기 준비 · 다른 맵에서 Ctrl/⌘ V로 이동`
        : `${clipboard.nodes.length}개 노드 복사됨 · 같은 맵이나 다른 맵에서 Ctrl/⌘ V`);
    }
    function paste(event: ClipboardEvent) {
      if (ignored(event)) return;
      const clipboard = parseNodeClipboard(event.clipboardData?.getData("text/plain") ?? "");
      if (!clipboard) return;
      event.preventDefault();
      const current = latest.current;
      if (!current.inMap) { setMessage("왼쪽에서 붙여넣을 맵을 먼저 선택하세요."); return; }
      const cutting = pendingCut.current?.clipboard.token === clipboard.token;
      try {
        if (cutting && pendingCut.current!.generation !== current.generation)
          throw Error("작업실이 교체되었습니다. 원본에서 다시 복사하거나 잘라내세요.");
        const count = lastPaste.current.token === clipboard.token ? lastPaste.current.count : 0;
        const result = current.paste(cutting ? pendingCut.current!.clipboard : clipboard, cutting, count * 35);
        lastPaste.current = { token: clipboard.token, count: count + 1 };
        pendingCut.current = null;
        setCut(null);
        setMessage(`${clipboard.nodes.length}개 노드 ${cutting ? "이동" : "붙여넣기"} 완료` +
          (result.removedEdges ? ` · 다른 맵에 남은 노드와의 연결 ${result.removedEdges}개 해제 · Ctrl/⌘ Z로 복원` : ""));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "붙여넣지 못했습니다.");
      }
    }
    window.addEventListener("copy", copy);
    window.addEventListener("cut", copy);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("copy", copy);
      window.removeEventListener("cut", copy);
      window.removeEventListener("paste", paste);
    };
  }, []);
  useEffect(() => {
    if (!message) return;
    const timeout = setTimeout(() => setMessage(""), 6500);
    return () => clearTimeout(timeout);
  }, [message]);
  return { cutIds: cut?.generation === options.generation ? cut.ids : [], message };
}
