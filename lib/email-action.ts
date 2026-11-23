export type EmailActionMode = "resetPassword" | "verifyEmail" | "recoverEmail" | "verifyAndChangeEmail";
export type EmailAction = { mode: EmailActionMode; code: string };
const modes: readonly string[] = ["resetPassword", "verifyEmail", "recoverEmail", "verifyAndChangeEmail"];

/** Parse only the action and its opaque code. Firebase configuration and navigation never come from the link. */
export function parseEmailAction(search: string): EmailAction {
  if (typeof search !== "string" || search.length > 65536 || search.includes("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(search))
    throw Error("이메일 확인 링크의 형식이 올바르지 않습니다. 이메일의 전체 링크를 다시 열어 주세요.");
  const query = search.startsWith("?") ? search.slice(1) : search;
  try {
    // URLSearchParams alone accepts malformed percent escapes and replaces invalid UTF-8.
    decodeURIComponent(query.replace(/\+/g, " "));
  } catch {
    throw Error("이메일 확인 링크의 주소가 손상되었습니다. 새 이메일을 요청해 주세요.");
  }
  const parameters = new URLSearchParams(query);
  const selectedModes = parameters.getAll("mode");
  if (selectedModes.length > 1)
    throw Error("이메일 확인 링크에 작업 정보가 중복되어 있습니다. 새 이메일을 요청해 주세요.");
  if (selectedModes.length === 0 || !selectedModes[0])
    throw Error("이메일 확인 링크에 작업 정보가 없습니다. 새 이메일을 요청해 주세요.");
  if (!modes.includes(selectedModes[0]))
    throw Error("지원하지 않는 이메일 확인 작업입니다. 최신 이메일의 링크를 열어 주세요.");
  const codes = parameters.getAll("oobCode");
  if (codes.length > 1)
    throw Error("이메일 확인 링크에 확인 코드가 중복되어 있습니다. 새 이메일을 요청해 주세요.");
  if (codes.length === 0 || !codes[0].trim())
    throw Error("이메일 확인 링크에 확인 코드가 없습니다. 새 이메일을 요청해 주세요.");
  if (codes[0].length > 8192 || /[\u0000-\u001f\u007f]/.test(codes[0]))
    throw Error("이메일 확인 링크의 확인 코드가 올바르지 않습니다. 새 이메일을 요청해 주세요.");
  return { mode: selectedModes[0] as EmailActionMode, code: codes[0] };
}
