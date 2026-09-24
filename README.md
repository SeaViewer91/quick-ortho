# QuickOrtho

현장 노트북에서 인터넷 없이 드론 영상으로 **정사 모자이크(GeoTIFF)**를 생성하는 데스크톱 앱임.

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

## 라이선스

[MIT](LICENSE)
