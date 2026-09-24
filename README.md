# QuickOrtho

현장 노트북에서 인터넷 없이 드론 영상으로 **정사 모자이크(GeoTIFF)**를 만드는 데스크톱 앱입니다.

> 🚧 개발 초기 단계입니다. 아직 사용할 수 있는 릴리스가 없습니다.

## 주요 기능 (계획)

- **빠른 미리보기**: 사진의 GPS·자세 정보만으로 몇 초 안에 촬영 범위와 누락 구역을 확인
- **정사 모자이크 생성**: 수십~수백 장의 드론 영상을 GeoTIFF(COG)로 생성
- **완전 오프라인**: 설치 후 인터넷 없이 동작, Docker 등 별도 설치 불필요
- **가벼운 요구 사양**: 맥북 에어 M1(8GB)에서도 동작하도록 설계

## 지원 환경 (계획)

| OS | 비고 |
|---|---|
| Windows 10 / 11 (x64) | NVIDIA GPU 가속은 추후 선택 기능으로 제공 |
| macOS (Apple Silicon) | M1 8GB 이상 |

지원 예정 기종: DJI Mavic 2, Mavic 3E, Matrice 4E, Phantom 4 Pro V2.0

## 기술 스택

- 데스크톱: [Tauri 2](https://tauri.app/) + React + TypeScript
- 처리 엔진: Python ([pycolmap](https://github.com/colmap/colmap)) 기반 사이드카

## 라이선스

[MIT](LICENSE)
