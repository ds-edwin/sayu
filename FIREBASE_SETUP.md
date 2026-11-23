# Firebase 연결 설정

## 현재 배포 프로젝트

2026-11-23에 준비한 프로젝트는 `sayu-thought-map-edwin`입니다. 기본 Firestore 데이터베이스 `(default)`는 서울 `asia-northeast3`에 생성됐으며, gcloud 조회에서 `freeTier: true`, 프로젝트 결제 `billingEnabled: false`를 확인했습니다. 이메일/비밀번호 로그인을 켰고 `ds-edwin.github.io`를 허용 도메인에 등록했습니다. 본 저장소의 Firestore 보안 규칙은 REST API로 배포됐습니다. 긴 `chunks.text`의 인덱스 제외 작업도 오류 없이 완료됐습니다.

현재 프로젝트를 사용하는 이용자는 Microsoft 앱이나 Firebase 프로젝트를 따로 등록하지 않고 앱에서 이메일로 가입·로그인합니다. 같은 이메일 계정으로 로그인해야 여러 기기에서 같은 작업실을 사용합니다.

이 기기에서 처음 연결하는 Firebase 계정에만 기존 기기 작업실의 **복사본을 자동으로 가져오며 원본은 유지**합니다. 이후 다른 계정은 빈 기기 작업실로 시작하며 각 계정의 클라우드 내용을 불러옵니다. 다른 계정으로 로그인해도 앞 계정의 기기 데이터가 덮어써지지 않으며, 원격 작업실과 내용이 다르면 사용할 버전을 확인합니다. JSON 내보내기·가져오기는 별도 백업·이전 경로로 계속 사용할 수 있습니다.

변경하지 않는 클라우드 버전 기록은 관리자 복구를 위해 보존합니다. 현재 UI에는 클라우드 버전 목록 선택기가 없으므로 기록이 모두 화면에서 복원 가능한 것으로 안내하지 않습니다.

검증: 단위·회귀 테스트 67개, 실제 Auth/Firestore 에뮬레이터 규칙 검사 7개, 실제 Firebase 프로젝트의 격리된 시험 계정 검사 10개를 통과했습니다. 실제 브라우저의 서로 다른 두 저장소에서 로그인 전 자료 보존·자동 업로드·다른 기기로 불러오기·수정 내용 역방향 동기화·로그아웃 후 원본 보존을 확인했습니다. `/sayu/` 경로의 빌드 앱은 미리보기 서버를 종료한 뒤에도 캐시로 다시 열렸습니다. 배포 주소에서 기존 자료를 보존한 업데이트와 768×1024 화면의 로그인 창을 확인했습니다. iPad 실기기 Safari에서 직접 실행한 검증은 포함하지 않습니다.

아래 절차는 **별도의 새 Firebase 프로젝트를 운영하거나 구성을 바꿀 때** 사용합니다. `portable/firebase-config.json`이 `{}`이면 Firebase 로그인·동기화를 시작하지 않으며 기기 저장은 계속 사용합니다. 구성값은 빌드에 포함되므로 변경 후 다시 빌드하고 배포해야 합니다.

## 새 프로젝트 준비

1. [Firebase Console](https://console.firebase.google.com/)에서 프로젝트와 웹앱을 만듭니다. 이 앱은 Analytics, Cloud Storage, Cloud Functions를 사용하지 않습니다.
2. Authentication의 로그인 제공업체에서 **이메일/비밀번호**를 켭니다. 같은 계정으로 여러 기기에 로그인해 사용합니다. OAuth 팝업·리디렉션은 사용하지 않습니다.
3. Cloud Firestore의 기본 데이터베이스 `(default)`를 만듭니다. 저장 위치는 생성 전에 확인하고, 공개 읽기·쓰기를 허용하는 테스트 규칙은 사용하지 않습니다.
4. Authentication의 허용 도메인에 배포 호스트를 등록합니다. GitHub Pages의 경우 `ds-edwin.github.io`이며 경로 `/sayu/`는 넣지 않습니다. 실제 계정으로 로컬 테스트할 때는 사용할 localhost 호스트도 확인합니다.
5. 웹앱의 Firebase 구성값에서 `apiKey`, `authDomain`, `projectId`, `appId`를 복사해 `portable/firebase-config.example.json` 형식으로 `portable/firebase-config.json`에 넣습니다.

Firebase 웹앱 구성값은 브라우저에 전달되는 공개 식별 정보입니다. **서비스 계정 JSON, private key, Admin SDK 인증정보, 사용자 비밀번호·토큰은 이 파일이나 저장소에 넣지 않습니다.** 사용자 데이터 접근은 Firebase Authentication과 Firestore 보안 규칙으로 제한합니다. [공식 웹 구성 안내](https://firebase.google.com/docs/web/setup), [API 키의 역할](https://firebase.google.com/docs/projects/api-keys)

## 규칙과 정적 앱 배포

Firebase CLI에 프로젝트 관리자 계정으로 로그인하고 다음 명령으로 규칙과 인덱스를 먼저 배포합니다. `YOUR_PROJECT_ID`를 실제 프로젝트 ID로 바꾸세요.

```sh
firebase deploy --only firestore:rules,firestore:indexes --project YOUR_PROJECT_ID
```

`firebase.json`은 Firestore 규칙·인덱스와 로컬 에뮬레이터만 설정합니다. GitHub Pages 배포 설정을 바꾸거나 Firebase Hosting·유료 서버를 배포하지 않습니다.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

기존 GitHub Pages 배포 절차로 `portable-dist`를 배포합니다. 이미 열린 PWA는 새 버전 안내에서 **저장 후 업데이트**를 누르거나 모든 앱 탭을 닫고 다시 엽니다. 계정의 첫 기기 작업실은 기존 내용의 복사본으로 시작합니다. JSON으로 별도 백업할 수 있으며, 첫 동기화에서 다른 내용이 발견되면 사용할 버전을 확인합니다.

## 데이터 경로와 보호 범위

- 최신 버전 포인터: `users/{uid}/workspaces/main`
- 변경하지 않는 버전 설명: `users/{uid}/workspaces/main/versions/{versionId}`
- 버전 본문 조각: `.../versions/{versionId}/chunks/{0000...0163}`

`firestore.rules`는 로그인한 본인의 UID 경로만 허용합니다. 버전과 조각은 생성 후 수정·삭제할 수 없으며, 최신 포인터는 기존 버전을 부모로 삼은 새 버전으로만 이동합니다. 본문 조각은 먼저 저장하고 완성 manifest를 마지막에 쓴 뒤, 트랜잭션으로 최신 포인터를 갱신합니다. 중간 업로드 실패나 동시 저장 충돌은 기존 최신 버전을 덮어쓰지 않습니다.

작업실 스냅샷 한도는 UTF-8 10MiB, 본문 조각은 256KiB 이하·최대 164개입니다. 클라이언트가 조각 수·본문 길이·SHA-256과 작업실 형식을 확인한 뒤 로컬에 적용합니다. 규칙은 필드 형식·크기와 포인터 연결을 검사하며, 조각 전체의 JSON·해시는 클라이언트에서 검증합니다. `firestore.indexes.json`은 검색하지 않는 긴 `chunks.text`의 인덱스를 제외합니다.

버전과 업로드 중 남은 조각은 자동 삭제하지 않습니다. 누적 저장량·읽기·쓰기는 Firebase 할당량을 사용하므로 콘솔에서 확인합니다. 요금제와 무료 할당량은 [공식 요금표](https://firebase.google.com/pricing)를 기준으로 확인하며, 이 설정은 요금제 업그레이드를 실행하지 않습니다.

로그인 상태는 사용 가능한 IndexedDB, localStorage, 메모리 순서로 유지합니다. 브라우저의 데이터 삭제·비공개 모드·저장소 제한에 따라 재로그인이 필요할 수 있습니다. iPad에서 앱을 닫은 동안의 백그라운드 동기화는 보장하지 않습니다. [공식 로그인 유지 안내](https://firebase.google.com/docs/auth/web/auth-state-persistence)

## 실제 프로젝트와 분리한 에뮬레이터

Firebase CLI의 요구사항에 맞는 Java·Node 환경에서 실행합니다.

```sh
firebase emulators:start --only auth,firestore --project demo-sayu
node node_modules/vite/bin/vite.js --config portable/vite.config.ts --host 127.0.0.1 --port 4190 --strictPort
```

`http://127.0.0.1:4190/?firebaseEmulator=1`로 접속합니다. **Vite 개발 모드 + localhost/127.0.0.1/[::1] + 명시적 쿼리**가 모두 맞을 때만 `demo-sayu`와 Auth 9099·Firestore 8080에 연결됩니다. 배포 빌드와 일반 접속은 이 쿼리로 에뮬레이터에 연결되지 않습니다. 개발용 계정과 데이터는 에뮬레이터에서만 만들고 실제 사용자 이메일·비밀번호를 넣지 않습니다. [공식 에뮬레이터 연결 안내](https://firebase.google.com/docs/emulator-suite/connect_auth)

에뮬레이터를 켠 상태에서 다음 PowerShell 명령으로 실제 Auth 토큰·Firestore 규칙 검증을 실행합니다. 일반 단위 테스트와 분리된 테스트이며 실제 프로젝트 ID나 외부 주소를 받지 않습니다.

```powershell
$env:GCLOUD_PROJECT = 'demo-sayu'
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
$env:FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
node --test tests/firebase-rules.test.mjs
```

이 검사는 비로그인·다른 UID 접근 거부, 본인 저장·조회, 버전·조각 수정/삭제 거부, 잘못된 최신 포인터, 동시 저장의 오래된 부모, 필드·UTF-8 크기 제한을 실제 에뮬레이터에서 확인합니다. 테스트용 계정·문서는 에뮬레이터 안에만 생성하며 종료 시점까지 보존합니다.
