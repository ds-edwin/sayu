import {
  PublicClientApplication,
  InteractionRequiredAuthError,
} from "@azure/msal-browser";
import { getSetting, setSetting } from "./local-store.ts";
import { appBaseUrl } from "./app-url.ts";
import {
  decideSync,
  findHeads,
  parseSnapshot,
  snapshotName,
  type Snapshot,
} from "./sync-graph.ts";
import type { Workspace } from "./model.ts";
export type DriveConfig = { clientId: string; folder: string };
export type RemoteChoice = { id: string; date: string; document: Workspace };
export class SyncConflict extends Error {
  constructor(public choices: RemoteChoice[]) {
    super(
      "여러 기기에서 변경되었습니다. 보관할 내용을 선택하세요. 모든 원본은 OneDrive에 남습니다.",
    );
  }
}
const scopes = ["Files.ReadWrite.AppFolder"];
let instance: PublicClientApplication | undefined,
  instanceId = "";
let initialization: Promise<PublicClientApplication> | undefined;
async function client(config: DriveConfig) {
  if (!/^[a-f0-9-]{36}$/i.test(config.clientId))
    throw Error("Microsoft 앱의 Client ID를 입력하세요.");
  if (!instance || instanceId !== config.clientId) {
    instanceId = config.clientId;
    instance = new PublicClientApplication({
      auth: {
        clientId: config.clientId,
        authority: "https://login.microsoftonline.com/consumers",
        redirectUri: appBaseUrl(),
        postLogoutRedirectUri: appBaseUrl(),
        navigateToLoginRequestUrl: false,
      },
      cache: { cacheLocation: "sessionStorage" },
    });
    const current = instance;
    initialization = (async()=>{
      await current.initialize();
      const result = await current.handleRedirectPromise();
      if (result?.account) current.setActiveAccount(result.account);
      return current;
    })();
  }
  return initialization!;
}
export async function finishSignIn() {
  const config = await getSetting<DriveConfig>("drive-config");
  if (config) await client(config);
}
export async function signIn(config: DriveConfig) {
  if (!/^[\p{L}\p{N} _-]{1,50}$/u.test(config.folder))
    throw Error("폴더 이름은 문자·숫자·공백·_- 조합으로 1~50자입니다.");
  await setSetting("drive-config", config);
  const c = await client(config);
  await c.loginRedirect({ scopes, prompt: "select_account" });
}
async function token(config: DriveConfig) {
  const c = await client(config),
    account = c.getActiveAccount() ?? c.getAllAccounts()[0];
  if (!account) throw Error("OneDrive에 로그인하세요.");
  try {
    return (await c.acquireTokenSilent({ scopes, account })).accessToken;
  } catch (e) {
    if (e instanceof InteractionRequiredAuthError)
      throw Error(
        "Microsoft 인증을 갱신해야 합니다. OneDrive 로그인 버튼을 누르세요.",
      );
    throw e;
  }
}
export async function disconnect() {
  await instance?.clearCache();
  await setSetting("drive-config", null);
  instance = undefined;
}
async function graph(path: string, access: string, init: RequestInit = {}) {
  const url = path.startsWith("https://")
    ? path
    : "https://graph.microsoft.com/v1.0" + path;
  if (!url.startsWith("https://graph.microsoft.com/"))
    throw Error("잘못된 Microsoft API 주소입니다.");
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: "Bearer " + access, ...init.headers },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw Error(
      response.status === 401
        ? "OneDrive에 다시 로그인하세요."
        : response.status === 429
          ? "OneDrive 요청이 많습니다. 잠시 후 다시 시도하세요."
          : `OneDrive 요청 실패 (${response.status}). 권한·용량·네트워크를 확인하세요.`,
    );
  return response;
}
async function locationInfo(config: DriveConfig, access: string) {
  const root = (await (
    await graph("/me/drive/special/approot", access)
  ).json()) as Item;
  const base = "/me/drive/items/" + encodeURIComponent(root.id);
  let children = (await (
    await graph(base + "/children", access)
  ).json()) as Items;
  let folder = children.value.find(
    (v: { name: string; folder?: unknown }) =>
      v.name === config.folder && v.folder,
  );
  while (!folder && children["@odata.nextLink"]) {
    children = (await (
      await graph(children["@odata.nextLink"]!, access)
    ).json()) as Items;
    folder = children.value.find(
      (v: { name: string; folder?: unknown }) =>
        v.name === config.folder && v.folder,
    );
  }
  if (!folder) {
    try {
      folder = (await (
        await graph(base + "/children", access, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: config.folder,
            folder: {},
            "@microsoft.graph.conflictBehavior": "fail",
          }),
        })
      ).json()) as Item;
    } catch {
      folder = (await (
        await graph(base + ":/" + encodeURIComponent(config.folder), access)
      ).json()) as Item;
      if (!folder.folder)
        throw Error(
          "같은 이름의 파일이 있습니다. 다른 작업실 이름을 선택하세요.",
        );
    }
  }
  return {
    base: "/me/drive/items/" + encodeURIComponent(folder.id),
    key: (root.parentReference?.driveId ?? root.id) + ":" + folder.id,
  };
}
type Item = {
  id: string;
  name: string;
  folder?: object;
  parentReference?: { driveId: string };
  "@microsoft.graph.downloadUrl"?: string;
};
type Items = { value: Item[]; "@odata.nextLink"?: string };
async function list(base: string, access: string) {
  let path = base + "/children?$select=id,name&$top=200";
  const files: Item[] = [];
  while (path) {
    const data = (await (await graph(path, access)).json()) as Items;
    files.push(...data.value);
    path = data["@odata.nextLink"] ?? "";
    if (files.length > 5000)
      throw Error(
        "버전 파일이 5,000개를 넘었습니다. 데이터를 내보내고 새 작업실 폴더를 선택하세요.",
      );
  }
  return files;
}
async function read(item: Item, id: string, access: string) {
  // Graph /content redirects cannot be fetched with Authorization across origins.
  const meta = (await (
    await graph("/me/drive/items/" + encodeURIComponent(item.id), access)
  ).json()) as Item;
  const url = meta["@microsoft.graph.downloadUrl"];
  if (typeof url !== "string" || !url.startsWith("https://"))
    throw Error("파일 다운로드 주소를 받지 못했습니다.");
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw Error("OneDrive 파일을 읽지 못했습니다.");
  const text = await r.text();
  if (text.length > 15 * 1024 * 1024)
    throw Error("OneDrive 파일이 너무 큽니다.");
  const snapshot = parseSnapshot(JSON.parse(text), id);
  if (snapshotName(snapshot.id, snapshot.parents) !== item.name)
    throw Error("OneDrive 버전 정보와 파일 이름이 다릅니다.");
  return snapshot;
}
export async function syncDrive(
  local: Workspace,
  apply: (doc: Workspace, expected?: string) => Promise<void>,
  resolution?: "local" | string,
) {
  const config = await getSetting<DriveConfig>("drive-config");
  if (!config) throw Error("저장소 설정에서 OneDrive를 연결하세요.");
  const access = await token(config),
    target = await locationInfo(config, access);
  const files = await list(target.base, access),
    heads = findHeads(files.map((f) => f.name));
  const base = await getSetting<{ id: string; document: string }>(
    "baseline:" + target.key,
  );
  const remote = await Promise.all(
    heads.map((h) =>
      read(
        files.find((f) => f.name === snapshotName(h.id, h.parents))!,
        h.id,
        access,
      ),
    ),
  );
  const text = JSON.stringify(local),
    remoteText =
      remote.length === 1 ? JSON.stringify(remote[0].document) : undefined;
  let decision = decideSync(
    text,
    base?.document,
    base?.id,
    heads.map((h) => h.id),
    remoteText,
  );
  let chosen = local;
  if (resolution) {
    if (resolution !== "local") {
      const match = remote.find((r) => r.id === resolution);
      if (!match)
        throw Error("선택한 버전이 변경되었습니다. 다시 동기화하세요.");
      chosen = match.document;
    }
    decision = "push";
  }
  if (decision === "conflict")
    throw new SyncConflict(
      remote.map((s) => ({
        id: s.id,
        date: s.createdAt,
        document: s.document,
      })),
    );
  let id = heads[0]?.id;
  if (decision === "pull") {
    chosen = remote[0].document;
    await apply(chosen, text);
  }
  if (decision === "push") {
    id = crypto.randomUUID();
    const parents = heads.map((h) => h.id);
    const name = snapshotName(id, parents);
    const snapshot: Snapshot = {
      format: "sayu-snapshot",
      version: 1,
      id,
      parents,
      createdAt: new Date().toISOString(),
      document: chosen,
    };
    const body = JSON.stringify(snapshot);
    if (body.length > 10 * 1024 * 1024)
      throw Error("OneDrive 저장 한도(10MB)를 초과했습니다.");
    await graph(
      target.base + ":/" + encodeURIComponent(name) + ":/content",
      access,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body },
    );
    if (chosen !== local) await apply(chosen, text);
  }
  await setSetting("baseline:" + target.key, {
    id,
    document: JSON.stringify(chosen),
  });
  const after = findHeads((await list(target.base, access)).map((f) => f.name));
  if (after.length !== 1 || after[0].id !== id)
    throw Error(
      "다른 기기의 저장도 발견했습니다. 원본은 보관되었습니다. 다시 동기화해 버전을 선택하세요.",
    );
  await setSetting("last-sync", new Date().toISOString());
  return decision === "pull"
    ? "OneDrive 변경 내용을 이 기기에 가져왔습니다."
    : "OneDrive와 동기화했습니다.";
}
