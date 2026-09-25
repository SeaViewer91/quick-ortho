# QuickOrtho

현장 노트북에서 인터넷 없이 드론 영상으로 정사 모자이크(GeoTIFF)를 생성하는 데스크톱 앱임.

> 🚧 개발 초기 단계임. 아직 사용 가능한 릴리스는 없음.

## 주요 기능 (계획)

- **빠른 미리보기**: 사진의 GPS·자세 정보만으로 수 초 내에 촬영 범위와 누락 구역을 확인함
- **정사 모자이크 생성**: 수십~수백 장의 드론 영상으로 GeoTIFF(COG)를 생성함
- **완전 오프라인 동작**: 설치 후 인터넷 없이 동작하며, Docker 등 별도 설치가 필요 없음
- **낮은 요구 사양**: 맥북 에어 M1(8GB)에서도 동작하도록 설계함

## 지원 환경 (계획)

| OS | 비고 |
|---|---|
| Windows 10 / 11 (x64) | NVIDIA GPU 가속은 추후 선택 기능으로 제공 예정 |
| macOS (Apple Silicon) | M1 8GB 이상 |

지원 예정 기종: DJI Mavic 2, Mavic 3E, Matrice 4E, Phantom 4 Pro V2.0

## 기술 스택

- 데스크톱: [Tauri 2](https://tauri.app/) + React + TypeScript
- 처리 엔진: Python([pycolmap](https://github.com/colmap/colmap)) 기반 사이드카

## 개발 환경 구성

필요 도구: Node.js LTS, Rust(stable), Python 3.10~3.13
([Tauri 사전 요구사항](https://tauri.app/start/prerequisites/) 참고)

```bash
# 1) 처리 엔진 가상환경 (앱이 개발 모드에서 engine/.venv의 파이썬을 자동으로 사용함)
cd engine
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"          # Windows: .venv\Scripts\pip install -e ".[dev]"
.venv/bin/pytest                           # 엔진 테스트
cd ..

# 2) 데스크톱 앱 실행 (개발 모드)
npm install
npm run tauri dev
```

- 엔진 실행 파일을 직접 지정하려면 환경변수 `QUICKORTHO_ENGINE`에 경로를 설정함
- 결과는 영상 폴더 옆의 `<폴더명>_QuickOrtho/` 아래에 저장됨 (`preview/`, `ortho/`)

## 사용 방법 (개발 버전)

1. **영상 폴더 선택**: 폴더를 고르면 빠른 미리보기가 자동 실행되어 수 초 내에 촬영 범위, 간이 모자이크, 누락 구역이 지도에 표시됨
2. **촬영 상태 확인**: 누락 구역, 중복 매수, 전방 중복률을 확인하고 필요하면 재촬영함
3. **정사 모자이크 생성**: SfM 기반 정사 모자이크(GeoTIFF)를 생성하고 지도에 겹쳐 표시함

## 저장소 구조

```
src/          프론트엔드 (React + TypeScript)
src-tauri/    데스크톱 셸 (Tauri 2, Rust)
engine/       처리 엔진 사이드카 (Python)
.github/      빌드 워크플로 (macOS arm64, Windows x64 설치파일 생성)
```

## 라이선스

[MIT](LICENSE)
