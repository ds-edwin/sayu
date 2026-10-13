# 사유 · Thought Map

v0.4 기반 정적 PWA. Mac, Windows, iPad의 브라우저에서 사용하며 Docker나 운영 서버가 필요하지 않습니다.

## 저장과 이전

- 편집 내용은 기기 브라우저의 IndexedDB `sayu-local-v1`에 자동 저장됩니다. 기존 저장소와 JSON v1 형식을 유지합니다.
- Microsoft 등록 없이 사용: **저장소 · 설치 → 파일로 저장 / 공유**로 JSON을 OneDrive에 저장한 뒤 다른 기기에서 **JSON 파일 열기**로 가져옵니다. 수동 방식입니다.
- 가져오기 전 내용을 미리 확인합니다. 교체된 작업실은 기기의 복원 기록에 최대 20개 보관됩니다.
- 기존 사이트와 GitHub Pages는 주소가 달라 브라우저 저장소가 공유되지 않습니다. **기존 사이트에서 JSON을 내보낸 뒤 새 주소에서 가져오세요.** 기존 사이트 데이터나 OneDrive 파일을 삭제하지 않습니다.
- 브라우저 데이터 삭제나 앱 제거 전 JSON을 내보내세요. 개인정보와 백업 JSON은 GitHub에 올리지 마세요.

## 배포

`npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
GitHub 저장소 Settings → Pages → Source를 **GitHub Actions**로 지정합니다. main에 push하면 `.github/workflows/pages.yml`이 `portable-dist`를 배포합니다.
배포 주소: https://ds-edwin.github.io/sayu/

첫 방문은 온라인으로 진행하고 ‘오프라인 실행 준비됨’을 확인하세요. 업데이트는 열린 앱 탭을 모두 닫은 뒤 다시 열 때 적용됩니다. 캐시는 앱 경로별로 분리하며 다른 앱 캐시나 작업 데이터는 삭제하지 않습니다.

## 선택 사항: 개인 OneDrive 자동 동기화

Microsoft Entra 앱 등록에서 개인 Microsoft 계정을 허용하고 SPA 리디렉션 URI를 정확히 `https://ds-edwin.github.io/sayu/`로 등록합니다. Microsoft Graph 위임 권한은 `Files.ReadWrite.AppFolder`입니다. Client Secret은 필요하지 않습니다. 앱의 저장소 설정에서 Client ID와 모든 기기에 동일한 작업실 이름을 입력합니다.

기존 스냅샷과 충돌 원본을 유지합니다. Microsoft 앱 등록과 실제 계정 로그인 전에는 실계정 동기화를 검증할 수 없습니다.

## 설치

iPad: Safari → 공유 → 홈 화면에 추가. Mac: Safari → 파일 → Dock에 추가. Windows: Edge/Chrome → 앱 설치. JSON 파일 전달은 각 기기의 OneDrive 앱 또는 파일 선택기를 이용합니다.
