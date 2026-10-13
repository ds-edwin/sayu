import { z } from "zod";
export const kinds = ["질문", "주장", "근거", "개념", "사례", "메모"] as const;
export const relations = ["관련", "지지", "반박", "원인", "구체화"] as const;
const id = z.string().min(1).max(100);
const nodeSchema = z.object({
  id,
  title: z.string().trim().min(1).max(200),
  kind: z.enum(kinds),
  mapId: id.nullable(),
  body: z.string().max(200000),
  tags: z.array(z.string().max(40)).max(20),
  source: z.union([
    z.literal(""),
    z.url().refine((v) => /^https?:\/\//.test(v)),
  ]),
  confidence: z.enum(["검토 전", "탐색 중", "정리됨"]),
  position: z.object({
    x: z.number().finite().min(-100000).max(100000),
    y: z.number().finite().min(-100000).max(100000),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const documentSchema = z
  .object({
    folders: z
      .array(
        z.object({
          id,
          name: z.string().trim().min(1).max(100),
          parentId: id.nullable().default(null),
        }),
      )
      .max(100)
      .default([]),
    maps: z
      .array(
        z.object({
          id,
          name: z.string().trim().min(1).max(100),
          description: z.string().max(500),
          folderId: id.nullable().default(null),
        }),
      )
      .min(1)
      .max(100),
    nodes: z.array(nodeSchema).max(2000),
    edges: z
      .array(
        z.object({ id, source: id, target: id, relation: z.enum(relations) }),
      )
      .max(5000),
  })
  .superRefine((d, ctx) => {
    const folders = new Map(d.folders.map((f) => [f.id, f]));
    if (folders.size !== d.folders.length)
      ctx.addIssue({ code: "custom", message: "중복 폴더 ID입니다." });
    for (const f of d.folders) {
      const visited = new Set([f.id]);
      let parent = f.parentId;
      while (parent) {
        if (visited.has(parent) || !folders.has(parent)) {
          ctx.addIssue({ code: "custom", message: "잘못된 폴더 계층입니다." });
          break;
        }
        visited.add(parent);
        parent = folders.get(parent)!.parentId;
      }
    }
    for (const m of d.maps)
      if (m.folderId && !folders.has(m.folderId))
        ctx.addIssue({
          code: "custom",
          message: "맵 폴더를 찾을 수 없습니다.",
        });
    const maps = new Set(d.maps.map((m) => m.id));
    const nodes = new Map(d.nodes.map((n) => [n.id, n]));
    if (
      maps.size !== d.maps.length ||
      nodes.size !== d.nodes.length ||
      new Set(d.edges.map((e) => e.id)).size !== d.edges.length
    )
      ctx.addIssue({ code: "custom", message: "중복 ID가 있습니다." });
    for (const n of d.nodes)
      if (n.mapId && !maps.has(n.mapId))
        ctx.addIssue({ code: "custom", message: "맵을 찾을 수 없습니다." });
    const pairs = new Set<string>();
    for (const e of d.edges) {
      const a = nodes.get(e.source),
        b = nodes.get(e.target);
      const key = e.source + "|" + e.target;
      if (
        !a ||
        !b ||
        !a.mapId ||
        a.mapId !== b.mapId ||
        a.id === b.id ||
        pairs.has(key)
      )
        ctx.addIssue({ code: "custom", message: "유효하지 않은 연결입니다." });
      pairs.add(key);
    }
  });
export type KnowledgeNode = z.infer<typeof nodeSchema>;
export type Workspace = z.infer<typeof documentSchema>;
export const colors: Record<KnowledgeNode["kind"], string> = {
  질문: "#6155df",
  주장: "#2678d8",
  근거: "#168276",
  개념: "#b47b18",
  사례: "#b85a77",
  메모: "#758095",
};
export function blankWorkspace(): Workspace {
  return {
    folders: [],
    maps: [
      {
        id: "first-map",
        folderId: null,
        name: "나의 첫 번째 맵",
        description: "흩어진 생각을 연결하며 질문을 발전시켜 보세요.",
      },
    ],
    nodes: [],
    edges: [],
  };
}
export function exampleWorkspace(): Workspace {
  const now = new Date().toISOString();
  const node = (
    id: string,
    title: string,
    kind: KnowledgeNode["kind"],
    x: number,
    y: number,
    body: string,
  ): KnowledgeNode => ({
    id,
    title,
    kind,
    mapId: "first-map",
    position: { x, y },
    body: JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
    }),
    tags: ["사고 실험"],
    source: "",
    confidence: "탐색 중",
    createdAt: now,
    updatedAt: now,
  });
  return {
    folders: [],
    maps: [
      {
        id: "first-map",
        folderId: null,
        name: "AI와 일의 변화",
        description: "예시 맵 · 질문과 근거를 구분해 생각을 연결하기",
      },
    ],
    nodes: [
      node(
        "q",
        "AI는 우리의 일을 어떻게 바꿀까?",
        "질문",
        350,
        220,
        "일자리가 사라지는 것과 업무의 일부가 자동화되는 것은 다르다. 어떤 단위로 변화를 살펴봐야 할까?",
      ),
      node(
        "c",
        "직업보다 업무 단위로 바라보기",
        "개념",
        30,
        50,
        "하나의 직업은 여러 업무의 묶음이다. 업무별 자동화 가능성과 사람의 역할을 나누어 생각해 보자.",
      ),
      node(
        "a",
        "자동화는 새로운 역할도 만든다",
        "주장",
        690,
        80,
        "검증이 필요한 가설. 산업별로 어떤 역할이 등장하고 사라지는지 비교해 보자.",
      ),
      node(
        "e",
        "산업별 실제 도입 사례 조사",
        "근거",
        700,
        360,
        "아직 근거를 수집하지 않았다. 원문 출처, 조사 시점, 표본과 한계를 함께 기록할 것.",
      ),
      node(
        "m",
        "생산성 증가가 고용 증가로 이어질까?",
        "질문",
        30,
        400,
        "수요 확대, 비용 절감, 노동시간 단축 등 서로 다른 경로를 구분할 필요가 있다.",
      ),
    ],
    edges: [
      { id: "e1", source: "c", target: "q", relation: "구체화" },
      { id: "e2", source: "q", target: "a", relation: "관련" },
      { id: "e3", source: "e", target: "a", relation: "관련" },
      { id: "e4", source: "m", target: "q", relation: "관련" },
    ],
  };
}
