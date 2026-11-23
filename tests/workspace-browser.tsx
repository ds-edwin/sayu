import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useWorkspace } from "../components/use-workspace";
import { documentSchema, type KnowledgeNode, type Workspace } from "../lib/model";
import { getSetting, writeLocal, type LocalWorkspace } from "../lib/local-store";

type Phase = "idle" | "checking" | "running" | "passed" | "failed";
type Report = (line: string) => void;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function expect(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}

async function until(predicate: () => boolean | Promise<boolean>, message: string, timeout = 8000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await pause(30);
  }
  throw Error(`${message} (${timeout}ms 시간 초과)`);
}

async function saved() {
  const value = await getSetting<LocalWorkspace>("workspace");
  expect(value, "검증용 workspace 기록이 없습니다.");
  return value;
}

async function checkFreshOrigin(report: Report) {
  expect(["localhost", "127.0.0.1", "[::1]"].includes(location.hostname), "localhost 전용 검증입니다.");
  expect(location.port && !["4173", "3000", "5173"].includes(location.port), "4189 같은 사용한 적 없는 별도 포트를 사용하세요.");
  expect(typeof indexedDB.databases === "function", "기존 DB를 확인할 수 있는 브라우저에서 실행하세요.");
  const databases = await indexedDB.databases();
  expect(databases.length === 0, "기존 IndexedDB가 있습니다. 삭제하거나 덮어쓰지 않고 중단했습니다. 새 포트를 사용하세요.");
  if ("serviceWorker" in navigator) {
    expect(!navigator.serviceWorker.controller, "서비스 워커가 제어하는 주소에서는 실행하지 않습니다.");
    expect((await navigator.serviceWorker.getRegistrations()).length === 0, "서비스 워커가 등록된 주소입니다. 새 포트를 사용하세요.");
  }
  expect(await getSetting("workspace") === undefined, "기존 작업실이 발견되어 변경 없이 중단했습니다.");
  report(`통과: 전용 origin ${location.origin}, 기존 DB·작업실·서비스 워커 없음`);
}

function Regression({ report, done }: { report: Report; done: (passed: boolean) => void }) {
  const workspace = useWorkspace();
  const latest = useRef(workspace);
  latest.current = workspace;
  const started = useRef(false);
  const restoreParse = useRef<(() => void) | null>(null);
  useEffect(() => () => restoreParse.current?.(), []);

  useEffect(() => {
    if (!workspace.document || started.current) return;
    started.current = true;
    void (async () => {
      let passed = false;
      try {
        const initial = latest.current.document!;
        expect(initial.nodes.length === 0 && initial.edges.length === 0 && initial.folders.length === 0 &&
          initial.maps.length === 1 && initial.maps[0].id === "first-map", "초기 작업실이 빈 기본 작업실이 아닙니다.");
        const initialRecord = await saved();
        expect(initialRecord.document.nodes.length === 0, "초기 DB에 기존 노드가 있습니다.");
        report(`통과: 실제 훅이 빈 작업실을 불러옴 (revision ${initialRecord.revision})`);

        const now = new Date().toISOString();
        const node: KnowledgeNode = {
          id: `regression-${crypto.randomUUID()}`, mapId: initial.maps[0].id,
          title: "", body: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "빈 제목이어도 보존할 원래 본문" }] }] }),
          kind: "메모", tags: ["본문 보존"], source: "https://example.test/workspace-regression", confidence: "탐색 중",
          position: { x: 125.5, y: -80 }, createdAt: now, updatedAt: now,
        };
        latest.current.update(current => ({ ...current, nodes: [...current.nodes, node] }));
        await until(async () => {
          const record = await saved();
          const stored = record.document.nodes.find(value => value.id === node.id);
          return record.revision > initialRecord.revision && stored?.title === "" && stored.body === node.body &&
            latest.current.status === "기기에 저장됨";
        }, "빈 제목 자동 저장 실패");
        const blankRecord = await saved();
        const blankNode = blankRecord.document.nodes[0];
        expect(blankNode.id === node.id && blankNode.mapId === node.mapId && blankNode.title === node.title &&
          blankNode.body === node.body && blankNode.kind === node.kind && blankNode.confidence === node.confidence &&
          blankNode.source === node.source && JSON.stringify(blankNode.tags) === JSON.stringify(node.tags) &&
          blankNode.position.x === node.position.x && blankNode.position.y === node.position.y &&
          blankNode.createdAt === node.createdAt && blankNode.updatedAt === node.updatedAt,
        "빈 제목 자동 저장에서 본문·태그·출처·위치가 달라졌습니다.");
        report(`통과: 빈 제목 update → 실제 자동 저장 → DB의 본문·메타데이터 보존 (revision ${blankRecord.revision}, flush 미사용)`);

        let invalidAttempts = 0;
        const originalParse = documentSchema.parse;
        const observedParse: typeof originalParse = (...args: Parameters<typeof originalParse>) => {
          const candidate = args[0] as Workspace | undefined;
          if (candidate?.nodes?.some(value => value.id === node.id && value.title.length === 201)) invalidAttempts++;
          return originalParse(...args);
        };
        documentSchema.parse = observedParse;
        restoreParse.current = () => {
          if (documentSchema.parse === observedParse) documentSchema.parse = originalParse;
          restoreParse.current = null;
        };
        latest.current.update(current => ({ ...current, nodes: current.nodes.map(value =>
          value.id === node.id ? { ...value, title: "가".repeat(201) } : value) }));
        await until(() => latest.current.status === "저장 실패" && !!latest.current.error && invalidAttempts > 0, "201자 검증 오류가 발생하지 않음");
        expect(invalidAttempts === 1, `첫 검증 오류에 저장을 ${invalidAttempts}회 시도했습니다.`);
        await pause(1000);
        expect(invalidAttempts === 1, `검증 오류 이후 무한 재시도가 감지되었습니다 (${invalidAttempts}회).`);
        expect(JSON.stringify(await saved()) === JSON.stringify(blankRecord), "검증 실패가 저장된 원본을 변경했습니다.");
        expect(latest.current.document?.nodes[0].title.length === 201, "실패한 메모리 초안이 사라졌습니다.");
        report(`통과: 201자 제목 저장 실패 → DB 원본·메모리 초안 보존 → 1,000ms 동안 저장 시도 ${invalidAttempts}회 (자동 재시도 없음)`);
        restoreParse.current();

        latest.current.update(current => ({ ...current, nodes: current.nodes.map(value =>
          value.id === node.id ? { ...value, title: "검증 오류 후 복구한 제목" } : value) }));
        await latest.current.flush();
        await until(() => latest.current.status === "기기에 저장됨" && !latest.current.error, "수정 후 저장 오류가 해제되지 않음");
        const recovered = await saved();
        expect(recovered.revision === blankRecord.revision + 1 && recovered.document.nodes[0].body === node.body &&
          recovered.document.nodes[0].title === "검증 오류 후 복구한 제목", "수정 후 flush가 본문을 보존해 저장하지 못했습니다.");
        report(`통과: 제목 수정 → 실제 flush 성공·오류 해제·DB 본문 보존 (revision ${recovered.revision})`);

        const external = structuredClone(recovered.document);
        external.nodes[0].title = "외부 호출자가 먼저 저장한 제목";
        const externalRevision = await writeLocal(external, recovered.revision);
        latest.current.update(current => ({ ...current, nodes: current.nodes.map(value =>
          value.id === node.id ? { ...value, title: "덮어쓰면 안 되는 로컬 초안" } : value) }));
        let rejected = false;
        try { await latest.current.flush(); } catch { rejected = true; }
        expect(rejected, "실제 외부 revision 충돌인데 flush가 성공했습니다.");
        await until(() => latest.current.error.includes("다른 창에서 변경"), "revision 충돌이 구분되지 않음");
        const afterConflict = await saved();
        expect(afterConflict.revision === externalRevision && JSON.stringify(afterConflict.document) === JSON.stringify(external), "외부의 최신 작업실을 덮어썼습니다.");
        expect(latest.current.document?.nodes[0].title === "덮어쓰면 안 되는 로컬 초안", "충돌 후 메모리 초안이 사라졌습니다.");
        latest.current.update(current => ({ ...current, nodes: current.nodes.map(value =>
          value.id === node.id ? { ...value, title: "충돌 후에도 보존할 추가 초안" } : value) }));
        await pause(600);
        expect(JSON.stringify(await saved()) === JSON.stringify(afterConflict), "충돌 후 자동 저장이 외부 revision을 덮어썼습니다.");
        report(`통과: 실제 외부 writeLocal로 revision ${externalRevision} 생성 → 충돌 flush 거부 → DB 외부 버전·메모리 초안 보존 → 추가 자동 덮어쓰기 차단`);
        passed = true;
      } catch (problem) {
        report(`실패: ${problem instanceof Error ? problem.stack ?? problem.message : String(problem)}`);
      } finally {
        restoreParse.current?.();
        report("정리: parse 계측 복구, 훅 언마운트로 리스너·타이머 정리. 검증 DB는 그대로 보존합니다.");
        done(passed);
      }
    })();
  }, [workspace.document, report, done]);

  return <p>실제 훅 상태: <b>{workspace.status}</b>{workspace.error && <span> · {workspace.error}</span>}</p>;
}

function App() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [lines, setLines] = useState<string[]>(["실행 대기 — 시작 버튼을 누르기 전에는 훅을 마운트하지 않습니다."]);
  const report = (line: string) => setLines(previous => [...previous, line]);
  async function start() {
    setPhase("checking");
    setLines([]);
    try {
      await checkFreshOrigin(report);
      setPhase("running");
    } catch (problem) {
      report(`중단: ${problem instanceof Error ? problem.message : String(problem)}`);
      setPhase("failed");
    }
  }
  return <>
    <p>현재 origin: <code>{location.origin}</code></p>
    <button id="run" disabled={phase !== "idle"} onClick={() => void start()}>빈 테스트 origin 확인 후 검증 실행</button>
    {phase === "running" && <Regression report={report} done={passed => setPhase(passed ? "passed" : "failed")} />}
    <pre id="result" role="status" aria-live="polite" data-state={phase}>{lines.join("\n")}</pre>
    {phase === "passed" && <p><b>전체 통과</b> — 실제 훅과 IndexedDB를 사용했습니다. 검증 완료 후 훅은 언마운트됐습니다.</p>}
  </>;
}

createRoot(document.getElementById("root")!).render(<App />);
