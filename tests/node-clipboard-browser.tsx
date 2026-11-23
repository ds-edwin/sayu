import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { useNodeClipboard } from "../components/use-node-clipboard";
import { exampleWorkspace, type Workspace } from "../lib/model";
import { pasteNodeClipboard, type NodeClipboard } from "../lib/node-clipboard";

type ProbeState = { workspace: Workspace; selectedIds: string[]; generation: number; mapId: string };
type HookResult = ReturnType<typeof useNodeClipboard>;

function check(condition: unknown, message: string): void {
  if (!condition) throw Error(message);
}
const settle = async () => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class FakeClipboard {
  text = "";
  writes = 0;
  rejectWrite = false;
  rejectRead = false;
  pendingRead: ReturnType<typeof deferred<string>> | null = null;
  writeText = async (text: string) => {
    this.writes++;
    if (this.rejectWrite) throw Error("test: clipboard write denied");
    this.text = text;
  };
  readText = async () => {
    if (this.rejectRead) throw Error("test: clipboard read denied");
    return this.pendingRead ? this.pendingRead.promise : this.text;
  };
}

class ProbeCase {
  root: Root;
  state: ProbeState;
  clipboard = new FakeClipboard();
  latest!: HookResult;
  pastes: { cut: boolean; offset: number; ids: string[] }[] = [];
  mounted = true;
  private sequence = 0;

  constructor() {
    const workspace = exampleWorkspace();
    workspace.maps.push({ id: "destination", name: "붙여넣을 맵", description: "", folderId: null });
    this.state = { workspace, selectedIds: [workspace.nodes[0].id], generation: 1, mapId: workspace.maps[0].id };
    this.root = createRoot(document.getElementById("fixture")!);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: this.clipboard });
    window.getSelection()?.removeAllRanges();
    this.render();
  }
  render() { flushSync(() => this.root.render(<Probe scenario={this} />)); }
  update(patch: Partial<ProbeState>) { this.state = { ...this.state, ...patch }; this.render(); }
  focusCanvas() { document.getElementById("clipboard-test-canvas")!.focus(); }
  paste = (clipboard: NodeClipboard, cut: boolean, offset: number) => {
    const result = pasteNodeClipboard(this.state.workspace, clipboard, this.state.mapId, {
      cut,
      anchor: { x: 700 + offset, y: 400 + offset },
      makeId: () => `browser-copy-${++this.sequence}`,
    });
    this.pastes.push({ cut, offset, ids: result.ids });
    this.update({ workspace: result.document });
    return { removedEdges: result.removedEdges };
  };
  unmount() {
    if (!this.mounted) return;
    this.mounted = false;
    flushSync(() => this.root.unmount());
  }
}

function Probe({ scenario }: { scenario: ProbeCase }) {
  const state = scenario.state;
  scenario.latest = useNodeClipboard({
    workspace: state.workspace, selectedIds: state.selectedIds, generation: state.generation,
    contextKey: state.mapId, blocked: false, inMap: true, paste: scenario.paste,
  });
  return <section>
    <button id="clipboard-test-canvas" type="button">시험 맵 캔버스</button>
    <input id="clipboard-test-text" aria-label="시험 텍스트 입력" defaultValue="native text" />
    <p>맵: {state.mapId} · 노드: {state.workspace.nodes.length} · 붙여넣기: {scenario.pastes.length}</p>
    <p>잘라내기 대기: {scenario.latest.cutIds.join(", ") || "없음"}</p>
    <p role="status">{scenario.latest.message}</p>
  </section>;
}

function keyEvent(type: "keydown" | "keyup", key: string, target: EventTarget = document.getElementById("clipboard-test-canvas")!) {
  const event = new KeyboardEvent(type, { key, code: `Key${key.toUpperCase()}`, metaKey: true, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}
async function shortcut(key: string) {
  keyEvent("keydown", key);
  await settle();
  keyEvent("keyup", key);
  await settle();
}
function clipboardEvent(type: "copy" | "paste", text: string, target: EventTarget = window) {
  const data = new Map([["text/plain", text]]);
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    getData: (format: string) => data.get(format) ?? "",
    setData: (format: string, value: string) => { data.set(format, value); },
  } });
  target.dispatchEvent(event);
  return event;
}

const scenarios: [string, (test: ProbeCase) => Promise<void>][] = [
  ["⌘C/⌘V: ClipboardEvent 없이 한 번만 복사하고 반복 붙여넣기", async test => {
    const initial = test.state.workspace.nodes.length;
    await shortcut("c");
    check(test.latest.message.includes("복사됨"), "복사 알림이 없습니다.");
    await shortcut("v");
    check(test.pastes.length === 1 && test.state.workspace.nodes.length === initial + 1, "첫 붙여넣기가 정확히 한 번 실행되지 않았습니다.");
    await shortcut("v");
    check(test.pastes.length === 2 && test.state.workspace.nodes.length === initial + 2, "반복 붙여넣기가 실패했습니다.");
    check(test.pastes[1].offset === 35 && test.pastes[0].ids[0] !== test.pastes[1].ids[0], "반복 복사 ID 또는 위치가 중복됩니다.");
  }],
  ["⌘X: 원본을 보존하다 다른 맵에 붙여넣을 때 이동", async test => {
    const ids = test.state.workspace.nodes.slice(0, 2).map(node => node.id);
    const initial = structuredClone(test.state.workspace);
    test.update({ selectedIds: ids });
    await shortcut("x");
    check(JSON.stringify(test.state.workspace) === JSON.stringify(initial), "붙여넣기 전에 원본이 바뀌었습니다.");
    check(test.latest.cutIds.length === 2, "잘라내기 대기 표시가 없습니다.");
    test.update({ mapId: "destination" });
    await shortcut("v");
    check(test.pastes.length === 1 && test.pastes[0].cut, "잘라내기 이동이 실행되지 않았습니다.");
    check(test.state.workspace.nodes.length === initial.nodes.length, "잘라내기 시 원본 개수가 바뀌었습니다.");
    check(ids.every(id => test.state.workspace.nodes.find(node => node.id === id)?.mapId === "destination"), "원본 ID를 유지한 다른 맵 이동이 실패했습니다.");
    check(test.latest.cutIds.length === 0, "이동 후 잘라내기 대기 표시가 남았습니다.");
  }],
  ["키보드와 ClipboardEvent가 함께 와도 한 번만 붙여넣기", async test => {
    await shortcut("c");
    test.clipboard.pendingRead = deferred<string>();
    keyEvent("keydown", "v");
    clipboardEvent("paste", test.clipboard.text);
    await settle();
    test.clipboard.pendingRead.resolve(test.clipboard.text);
    await settle();
    keyEvent("keyup", "v");
    check(test.pastes.length === 1, "클립보드 이벤트와 비동기 읽기가 중복 붙여넣기 했습니다.");
  }],
  ["글자 키 해제 없이 Command만 놓아도 다음 메뉴 붙여넣기 허용", async test => {
    await shortcut("c");
    keyEvent("keydown", "v");
    await settle();
    check(test.pastes.length === 1, "Command 붙여넣기가 실행되지 않았습니다.");
    window.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Meta", code: "MetaLeft", metaKey: false, ctrlKey: false, bubbles: true, cancelable: true,
    }));
    await settle();
    const menuPaste = clipboardEvent("paste", test.clipboard.text);
    await settle();
    check(menuPaste.defaultPrevented && test.pastes.length === 2, "Command 해제 후 메뉴 붙여넣기가 차단되거나 중복 실행됐습니다.");
  }],
  ["다른 창으로 갔다 돌아와도 잘라내기는 붙여넣을 때까지 보존", async test => {
    const id = test.state.selectedIds[0], initial = structuredClone(test.state.workspace);
    await shortcut("x");
    window.dispatchEvent(new Event("blur"));
    await settle();
    check(test.latest.cutIds.includes(id), "창 전환으로 잘라내기 대기가 사라졌습니다.");
    check(JSON.stringify(test.state.workspace) === JSON.stringify(initial), "창 전환 전에 원본이 변경됐습니다.");
    test.update({ mapId: "destination" });
    test.focusCanvas();
    await shortcut("v");
    check(test.pastes.length === 1 && test.pastes[0].cut, "창 전환 후 잘라내기 대신 복사됐습니다.");
    check(test.state.workspace.nodes.length === initial.nodes.length &&
      test.state.workspace.nodes.find(node => node.id === id)?.mapId === "destination", "창 전환 후 원본 ID를 보존한 이동이 실패했습니다.");
  }],
  ["클립보드 쓰기·읽기 거부 시 같은 앱의 복사본 사용", async test => {
    test.clipboard.rejectWrite = true;
    test.clipboard.rejectRead = true;
    await shortcut("c");
    keyEvent("keydown", "v");
    const duplicate = clipboardEvent("paste", "");
    await settle();
    keyEvent("keyup", "v");
    check(test.pastes.length === 1 && duplicate.defaultPrevented, "내부 복사본 대체 처리 또는 중복 방지가 실패했습니다.");
  }],
  ["텍스트 입력의 복사·붙여넣기를 가로채지 않고 오래된 노드 복사본 제거", async test => {
    test.clipboard.rejectWrite = true;
    test.clipboard.rejectRead = true;
    await shortcut("c");
    const input = document.getElementById("clipboard-test-text") as HTMLInputElement;
    input.focus();
    input.select();
    const typingCopy = keyEvent("keydown", "c", input);
    const nativeCopy = clipboardEvent("copy", "native text", input);
    keyEvent("keyup", "c", input);
    const typingPaste = keyEvent("keydown", "v", input);
    const nativePaste = clipboardEvent("paste", "native text", input);
    keyEvent("keyup", "v", input);
    check(!typingCopy.defaultPrevented && !nativeCopy.defaultPrevented && !typingPaste.defaultPrevented && !nativePaste.defaultPrevented, "텍스트 클립보드 동작을 가로챘습니다.");
    check(test.clipboard.writes === 1, "텍스트를 노드 복사본으로 덮어썼습니다.");
    test.focusCanvas();
    await shortcut("v");
    check(test.pastes.length === 0, "텍스트 복사 후 오래된 노드 복사본이 붙여넣어졌습니다.");
  }],
  ["클립보드에 일반 글자가 있으면 오래된 노드를 붙여넣지 않음", async test => {
    await shortcut("c");
    test.clipboard.text = "다른 앱에서 복사한 일반 글자";
    await shortcut("v");
    check(test.pastes.length === 0, "일반 클립보드 글자 대신 오래된 노드가 붙여넣어졌습니다.");
  }],
  ["읽기 대기 중 맵을 전환했다 돌아오면 늦은 결과 무시", async test => {
    await shortcut("c");
    test.clipboard.pendingRead = deferred<string>();
    keyEvent("keydown", "v");
    const original = test.state.mapId;
    test.update({ mapId: "destination" });
    test.update({ mapId: original });
    test.clipboard.pendingRead.resolve(test.clipboard.text);
    await settle();
    keyEvent("keyup", "v");
    check(test.pastes.length === 0, "맵 전환 전 읽기 결과가 잘못 적용됐습니다.");
  }],
  ["작업실 세대가 바뀌면 메모리 복사본과 잘라내기 대기 제거", async test => {
    test.clipboard.rejectWrite = true;
    test.clipboard.rejectRead = true;
    await shortcut("x");
    test.update({ generation: 2 });
    await shortcut("v");
    check(test.pastes.length === 0 && test.latest.cutIds.length === 0, "다른 작업실로 복사본이 넘어갔습니다.");
  }],
  ["화면 종료 뒤 도착한 클립보드 읽기 결과 무시", async test => {
    await shortcut("c");
    test.clipboard.pendingRead = deferred<string>();
    keyEvent("keydown", "v");
    test.unmount();
    test.clipboard.pendingRead.resolve(test.clipboard.text);
    await settle();
    check(test.pastes.length === 0, "화면 종료 뒤 작업실이 변경됐습니다.");
  }],
];

const runButton = document.getElementById("run") as HTMLButtonElement;
const output = document.getElementById("result")!;
const cases = document.getElementById("cases")!;
let running = false;
// A Vite timestamp/HMR re-evaluation must replace this handler, not attach a
// second scenario loop to the same fixture container. The DOM disabled guard
// also covers a previous module instance that is still finishing its run.
runButton.onclick = async () => {
  if (running || runButton.disabled) return;
  running = true;
  runButton.disabled = true;
  cases.replaceChildren();
  output.textContent = "RUNNING";
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  let passed = 0, failed = 0;
  try {
    for (const [name, run] of scenarios) {
      let probe: ProbeCase | undefined;
      const row = document.createElement("li");
      cases.append(row);
      try {
        probe = new ProbeCase();
        await settle();
        probe.focusCanvas();
        await run(probe);
        passed++;
        row.dataset.pass = "true";
        row.textContent = `PASS · ${name}`;
      } catch (error) {
        failed++;
        row.dataset.pass = "false";
        row.textContent = `FAIL · ${name}: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        probe?.unmount();
        await settle();
      }
      output.textContent = `PASS ${passed} / FAIL ${failed} / TOTAL ${scenarios.length}`;
    }
  } finally {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    running = false;
    runButton.disabled = false;
  }
};
