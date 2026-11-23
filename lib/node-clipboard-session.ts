import { captureNodeClipboard, type NodeClipboard } from "./node-clipboard.ts";
import type { Workspace } from "./model.ts";

export type PreparedNodePaste = {
  clipboard: NodeClipboard;
  cut: boolean;
  offset: number;
  generation: number;
};

/** Same-workspace clipboard fallback. Never stored in browser or cloud storage. */
export class NodeClipboardSession {
  private generation: number;
  private clipboard: NodeClipboard | null = null;
  private pendingCut: NodeClipboard | null = null;
  private lastPaste = { token: "", count: 0 };

  constructor(generation: number) {
    this.generation = generation;
  }

  get memory(): NodeClipboard | null { return this.clipboard; }
  get cutIds(): string[] { return this.pendingCut?.nodes.map(node => node.id) ?? []; }

  clear() {
    this.clipboard = null;
    this.pendingCut = null;
    this.lastPaste = { token: "", count: 0 };
  }

  setGeneration(generation: number) {
    if (generation === this.generation) return;
    this.clear();
    this.generation = generation;
  }

  private requireGeneration(generation: number) {
    if (generation !== this.generation)
      throw Error("작업실이 교체되었습니다. 원본에서 다시 복사하거나 잘라내세요.");
  }

  capture(workspace: Workspace, ids: string[], generation: number, cutting: boolean, token?: string): NodeClipboard | null {
    this.requireGeneration(generation);
    const clipboard = captureNodeClipboard(workspace, ids, token);
    if (!clipboard) return null;
    this.clipboard = clipboard;
    this.pendingCut = cutting ? clipboard : null;
    this.lastPaste = { token: clipboard.token, count: 0 };
    return clipboard;
  }

  preparePaste(clipboard: NodeClipboard, generation: number): PreparedNodePaste {
    this.requireGeneration(generation);
    const cut = this.pendingCut?.token === clipboard.token;
    return {
      clipboard: cut ? this.pendingCut! : clipboard,
      cut,
      offset: (this.lastPaste.token === clipboard.token ? this.lastPaste.count : 0) * 35,
      generation,
    };
  }

  /** Call only after the workspace accepted the paste. Failed pastes retain cut state. */
  didPaste(prepared: PreparedNodePaste) {
    this.requireGeneration(prepared.generation);
    this.clipboard = prepared.clipboard;
    this.lastPaste = {
      token: prepared.clipboard.token,
      count: prepared.offset / 35 + 1,
    };
    this.pendingCut = null;
  }
}
