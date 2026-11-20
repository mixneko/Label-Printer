# Label Printer

[繁體中文](README.md) · [English](README.en.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · **한국어**

BarTender Designer를 대신하는 가벼운 라벨 디자인·인쇄 소프트웨어입니다. 대상 프린터는 TSC TTP-244 Pro(203 dpi, TSPL2)이며, Windows에 설치된 프린터(RAW)를 통하거나 프린트 서버를 거쳐 Raw TCP로 직접 인쇄합니다.

기술: Tauri 2(Rust 백엔드) + TypeScript + Konva.js(캔버스 편집기).

## 개발 환경(Windows)

1. [Node.js LTS](https://nodejs.org/)
2. [Rust](https://rustup.rs/) (MSVC 필요: Visual Studio Build Tools의 'C++를 사용한 데스크톱 개발' 설치)
3. WebView2 Runtime(Windows 11에 기본 포함)

```powershell
npm install
npm run tauri icon app-icon.png   # 처음 한 번만: src-tauri/icons 생성
npm run tauri dev                 # 개발 모드
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 단위 테스트
```

## 빌드 및 배포

```powershell
npm run tauri build
```

결과물:

- `src-tauri/target/release/Label Printer.exe`: 단일 실행 파일로, 복사만 하면 바로 사용할 수 있습니다(WebView2 필요, Win11에는 기본 포함).
- `src-tauri/target/release/bundle/nsis/*-setup.exe`: WebView2 부트스트래퍼가 내장된 설치 파일이라 Win10에서도 설치할 수 있습니다. 현재 사용자용으로 설치되며 관리자 권한이 필요 없습니다.

## 자동 업데이트

설치 버전은 시작할 때 백그라운드에서 GitHub에 새 버전이 있는지 한 번 확인합니다(공개된 릴리스 정보만 읽으며 어떤 데이터도 보내지 않습니다). 새 버전이 있으면 대화상자가 나타나고, "지금 업데이트"를 누르면 프로그램 안에서 내려받아 서명을 검증하고 설치한 뒤 자동으로 다시 시작합니다. "도움말 → 시작할 때 업데이트 확인"에서 끌 수 있고, "도움말 → 새 버전 확인"으로 언제든 직접 확인할 수 있습니다. 포터블 버전은 제자리에서 업데이트할 수 없어 다운로드 페이지를 엽니다.

유지 관리자: 릴리스 워크플로(`.github/workflows/release.yml`)에는 저장소 Secret `TAURI_SIGNING_PRIVATE_KEY`(업데이트 서명용 개인 키, `tauri signer generate`로 생성, 공개 키는 `src-tauri/tauri.conf.json`)가 필요합니다. 개인 키를 잃으면 기존 사용자에게 업데이트를 보낼 수 없습니다.

## 구조

- 프런트엔드가 라벨을 1비트 비트맵으로 렌더링하고, 백엔드가 이를 TSPL(`SIZE/GAP/BITMAP/PRINT`)로 변환합니다.
- 기본적으로 Windows 스풀러를 통해 **RAW** 데이터로 설치된 프린터에 보냅니다(드라이버가 변환하지 않고 TSPL을 그대로 전송). Raw TCP 직접 연결(예: `192.168.1.100:9103`)로 전환할 수도 있습니다.
- 글꼴은 Windows에 설치된 글꼴을 사용합니다(WebView2가 `C:\Windows\Fonts`와 사용자 글꼴을 읽습니다). 다른 컴퓨터에서는 그 컴퓨터에도 같은 글꼴이 설치되어 있어야 합니다.
- 용지는 62.5×30 mm, 라벨은 60×30 mm이며 둘 다 화면에서 바꿀 수 있습니다. 라벨은 용지 가운데에 배치됩니다.
- 라벨 텍스트에는 `{{필드}}` 변수(Excel의 열 제목)를 쓸 수 있습니다. 인쇄 매수 = 데이터 표에서 선택한 행의 수입니다.

## 샘플 파일(`samples/`)

- `範例標籤.lpxl` + `範例貨品清單.csv`: 가상의 60×30 mm 상품 라벨과 해당 데이터(필드: 품명, 코드, 로트, 유효기간). 변수, QR 코드, 바코드, 날짜 형식, 텍스트 '최대 범위'(품명이 길면 자동으로 축소)를 보여 줍니다.
- `商品清單.xlsx`(시트 2개), `商品清單-big5.csv`: 가져오기 테스트용.
- xlsx / csv 샘플 다시 만들기: `cargo run --manifest-path src-tauri/Cargo.toml --example make_samples`

## 로드맵

- [x] 프로젝트 골격, 텍스트 개체, 인쇄
- [x] 바코드 / QR 코드 / 이미지 / 선 / 사각형 개체, 글꼴 드롭다운(시스템에 설치된 글꼴)
- [x] 라벨 저장 및 불러오기
- [x] 로컬 Excel / CSV 데이터 원본(도구 모음의 '데이터 원본 선택'), 일괄 인쇄, 미리 보기(첫 행은 필드 이름이고 그 뒤의 각 행이 한 건의 데이터입니다. 인쇄할 행을 선택하면 라벨의 `{{필드}}`가 해당 행의 값으로 채워집니다. Excel에는 '매수' 열이 필요 없으며, .xlsx/.xlsm/.xls와 .csv를 지원하고 CSV는 UTF-8 / Big5와 구분 기호를 자동으로 판별합니다)
- [x] 인쇄 보정: 농도, 속도, 글자 굵게, 절취 위치, 추가 이송, 위치 좌우/상하 미세 조정, 그리고 '도구 → 보정 라벨 만들기'(테두리와 mm 눈금)
- [x] 프린터 기본 명령(`BARCODE` / `QRCODE`): 선택 사항(기본값은 꺼짐). 바코드 또는 QR 코드의 속성에서 '프린터 기본 명령으로 인쇄'를 선택합니다. 내용에 한자 등이 있거나 개체가 회전된 경우에는 자동으로 비트맵으로 인쇄합니다
- [ ] 애플리케이션 신뢰성: 코드 서명(Authenticode)으로 Windows SmartScreen 및 백신 프로그램의 경고 줄이기
- [x] 다국어: UI는 영어, 스페인어, 독일어, 일본어, 한국어, 중국어 간체, 중국어 번체를 지원합니다. 처음 실행할 때 시스템 언어에 따라 선택되며 메뉴 모음 오른쪽의 지구본 버튼으로 바꿀 수 있습니다. 이 README도 7개 언어로 제공됩니다. 번역은 아직 원어민의 검수를 받지 않았습니다

> 참고: TSPL `BITMAP`의 흑백 비트 정의(0 = 인쇄)는 프로그램에서 반전해 처리하므로 실제 프린터로 결과를 확인해야 합니다.

## 라이선스

[MIT 라이선스](LICENSE)로 공개합니다. 서드파티 패키지의 라이선스 고지는 프로그램 안의 '도움말 → 서드파티 라이선스 고지'에서 볼 수 있습니다.
