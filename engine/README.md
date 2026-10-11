# QuickOrtho Engine

QuickOrtho 데스크톱 앱이 사이드카로 실행하는 Python 처리 엔진임.
배포 시에는 PyInstaller로 OS별 단일 실행파일로 묶어 앱에 포함할 예정임.

## 통신 규약 (JSON-lines)

- 엔진은 stdout으로 **한 줄에 JSON 객체 하나**씩 이벤트를 출력함
- 모든 이벤트는 `type` 필드를 가짐

| type | 필드 | 용도 |
|---|---|---|
| `stage` | `name`, `message` | 처리 단계 시작 알림 |
| `progress` | `stage`, `current`, `total` | 진행률 |
| `log` | `level`, `message` | 로그 |
| `result` | `command`, `data` | 명령 결과 (명령당 1회) |
| `error` | `message`, `detail` | 오류. 이후 종료 코드 1로 종료함 |

## 상주 모드 (`serve`)

앱은 엔진을 `serve` 모드로 한 번 띄워 무거운 라이브러리를 미리 불러 두고, 작업마다 재사용함.

- 요청: stdin에 한 줄 하나 `{"job": 1, "argv": ["preview", "<폴더>", "-o", "<결과>"]}`
- 시작 시 `{"type": "ready", "ok": true, "version": "...", "warmup_s": 1.0}` 출력
- 작업 이벤트에는 `"job"` 필드가 붙고, 끝나면 `{"type": "done", "job": 1, "code": 0}` 출력
- 작업은 한 번에 하나씩 처리함. 중단은 앱이 프로세스를 종료하고 새로 띄우는 방식임

## 배포용 번들 (PyInstaller)

```bash
pip install pyinstaller .
pyinstaller -y quickortho-engine.spec     # → dist/quickortho-engine/ (onedir)
```

- onefile 대신 onedir를 쓰는 이유: onefile은 실행할 때마다 임시 폴더에 압축을 풀어 기동이 느려짐
- CI에서 OS별로 번들을 만들어 앱 설치파일의 리소스(`engine/`)로 포함함 (`src-tauri/tauri.bundle.conf.json`)
- 번들 크기는 약 600 MB(압축 시 약 210 MB)임. pycolmap, OpenCV, GDAL, BLAS 라이브러리가 대부분임

## 명령

```bash
python -m quickortho_engine version
python -m quickortho_engine scan <영상 폴더> [--recursive]
python -m quickortho_engine preview <영상 폴더> -o <결과 폴더> [--max-size 2048]
python -m quickortho_engine ortho <영상 폴더> -o <결과 폴더> [옵션]

# 정밀 보정 (<결과 폴더>는 ortho 결과 폴더)
python -m quickortho_engine project-info <결과 폴더>
python -m quickortho_engine tiepoints <결과 폴더>
python -m quickortho_engine predict <결과 폴더> --spec '{"marks": [...], "world": {...}, "chips": true}'
python -m quickortho_engine gcp-parse <측량 성과 파일> [--ortho <결과 폴더>] [--encoding cp949] [--delimiter ,]
python -m quickortho_engine edits-save <결과 폴더> --edits '<JSON>'
python -m quickortho_engine refine <결과 폴더> [--reset]
python -m quickortho_engine render <결과 폴더>      # 저장된 정렬 결과로 정사 모자이크만 다시 생성 (SfM 생략)
```

엔진은 시작할 때 `PROJ_LIB`·`PROJ_DATA`·`GDAL_DATA`를 rasterio 패키지(설치본은 번들)에 들어 있는 데이터 폴더로 바꾸고
`GDAL_DRIVER_PATH`를 지움 (`geoenv.py`). Windows에 PostGIS·QGIS가 있으면 이 환경변수가 다른 버전의 데이터를 가리켜
정사 모자이크 단계가 실패하기 때문임. 바꾼 변수는 `version` 결과의 `geo_env_overridden`에 표시됨.

- `scan`: 폴더 내 JPG의 EXIF·DJI XMP를 읽어 위치·고도·짐벌 자세·카메라 정보를 수집하고,
  카메라별로 묶은 뒤 매핑용(광각) 카메라를 자동 선별함
- `preview`: SfM 없이 EXIF/XMP만으로 촬영 범위·중복도·누락 구역·간이 모자이크를 수 초 내에 생성함
- `ortho`: fast ortho 방식으로 정사 모자이크를 생성함

### `preview` 결과물

| 파일 | 내용 |
|---|---|
| `quicklook.png` | 간이 모자이크 (1/8 축소 디코딩 영상을 평면 가정 호모그래피로 배치) |
| `coverage.png` | 중복도 지도 (1장 빨강, 2장 주황, 3~4장 노랑, 5장 이상 초록, 누락 보라) |
| `preview.geojson` | 영상별 촬영 범위, 누락 구역, 저중복 구역, 촬영 위치 (WGS84) |
| `preview.json` | 요약 (두 PNG의 네 모서리 경위도, 중복도 통계, 누락 수, 전방 중복률, 경고) |

- 지면을 이륙 지점 높이의 평면으로 가정하므로 위치 오차는 수 m 수준임. 누락 확인용이며 측량용이 아님
- 촬영 자세는 DJI XMP의 짐벌 yaw·pitch를 사용함. 짐벌 yaw가 기체 yaw와 일정하게 어긋난 경우(Mavic 2 샘플에서 약 31° 사례 확인) 자동 보정함
- XMP가 없으면 비행 방향으로 yaw를 추정하고 35mm 환산 24mm 화각을 가정함 (정확도 낮음, 경고 표시)
- 누락 구역은 촬영 범위 내부 구멍과, 서로 떨어진 촬영 범위 사이의 틈(영상 한 장 폭 이하)으로 판정함.
  외곽의 계단 모양 오목부는 누락으로 보지 않음
- 성능: Mavic 2 Pro 18장 약 2초, 77장 약 4초 (2코어 VM)

### `ortho` 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--gsd` | 없음 | 출력 GSD(m). 지정하면 `--gsd-scale`보다 우선함 |
| `--gsd-scale` | 1.0 | 원본 GSD 대비 출력 배율 (1은 원본 해상도) |
| `--no-color-balance` | 끔 | 영상 간 밝기·색 차이 보정을 하지 않음 |
| `--radiometry` | auto | 다중분광 반사율 환산: `auto`, `dls+panel`, `dls`, `panel`, `radiance` |
| `--no-ms-normalize` | 끔 | 다중분광 캡처 간 반사율 블록 조정을 하지 않음 |
| `--max-image-size` | 2000 | 특징점 추출용 영상 긴 변(px) |
| `--max-features` | 4096 | 영상당 최대 특징점 수 |
| `--threads` | -1 | 스레드 수 (-1은 전체 코어) |
| `--keep-work` | 끔 | 중간 산출물(SfM DB 등) 보존 |

### 정밀 보정

`ortho`는 결과 폴더의 `project/`에 GPS 정렬 직후의 정합 결과(base, 지역 좌표계)를 저장함.
`refine`은 항상 base에서 시작해 `edits.json`을 처음부터 적용하므로 여러 번 실행해도 결과가 누적되지 않음.

1. 사용자가 삭제한 3D 점 제거, 재투영 오차가 기준보다 큰 관측 제거
2. 수동 타이포인트(사진 2장 이상 표시)를 삼각측량해 추가
3. 좌표 기준
   - 기준점 GCP 3점 이상: 삼각측량한 GCP와 측량 좌표로 닮음변환(Umeyama)을 구해 GCP 좌표계로 옮긴 뒤, GCP를 고정점으로 번들 조정함.
     기준점 4점 이상이고 GCP 높이 차가 촬영고도의 2% 이상이면 초점거리·왜곡도 조정함 (평탄지에서는 초점거리-고도 상관으로 높이가 흔들리므로 고정)
   - 1~2점: 번들 조정 → GPS 정렬 → GCP 평균 차이만큼 평행 이동
   - 0점: 번들 조정(카메라 내부표정 고정) → GPS 정렬
4. 검사점 오차 계산, DSM·정사 모자이크 재생성, `report.json`에 `refine` 항목 추가

| 명령 | 내용 |
|---|---|
| `project-info` | 영상 목록, 현재 좌표계, 수정 사항, GCP 경위도 |
| `tiepoints` | 점별·영상별 재투영 오차, 오차 분포, 자동 제거 기준별 제거량 미리보기, 권장 기준 |
| `predict` | 표시한 점(2장 이상: 삼각측량, 1장: DSM 교차) 또는 측량 좌표로 다른 사진에서의 위치 예측, 사진 조각(원본 해상도 512 px) 생성 |
| `gcp-parse` | CSV·TXT 읽기 (UTF-8/CP949, 쉼표·탭·세미콜론·공백 자동 판단), 열 추정, 촬영 위치와 비교해 좌표계와 X/Y 순서 추정 |
| `edits-save` | `edits.json` 검증·저장 |
| `refine` | 보정 실행. `--reset`은 최초 결과로 되돌림 |

검증 (합성 GCP: 정합 결과에 회전 0.5°, 축척 2%, 이동 수 m를 준 좌표를 측량값으로 사용, 표시 오차 0.3 px)

| 데이터 | 기준/검사 | 검사점 RMSE 수평 / 수직 | 재투영 RMSE (자동 제거) | 보정 시간 |
|---|---|---|---|---|
| Mavic 2 Pro 13장 | 4 / 2 | 0.025 / 0.017 m | 1.22 → 0.77 px (2 px) | 약 19초 |
| Aukerman 77장 | 5 / 3 | 0.050 / 0.141 m | 1.59 → 1.33 px (3 px) | 약 96초 |

### `ortho` 결과물

| 파일 | 내용 |
|---|---|
| `orthomosaic.tif` | 정사 모자이크 (RGBA, Cloud Optimized GeoTIFF, UTM 좌표계) |
| `dsm.tif` | 정사투영에 사용한 간이 DSM (float32) |
| `preview.png` | 긴 변 2048px 미리보기 |
| `report.json` | 처리 보고서 (정합 수, 재투영 오차, GPS 잔차, 단계별 시간, 피크 메모리, 경고) |

## 처리 파이프라인

1. **스캔**: EXIF/XMP 수집, 광각 카메라 선별, GPS 없는 영상·경사 촬영·롤링 셔터 표시
2. **특징점 추출**: SIFT(pycolmap). 긴 변 2000px로 축소하고 업샘플 없이(`first_octave=0`) 추출함
3. **매칭**: GPS가 가까운 15장과만 매칭함. 40장 이하이거나 GPS가 없으면 전수 매칭
4. **SfM**: 전역 SfM(GLOMAP 방식)을 먼저 시도하고, 정합률이 80% 미만이면 증분 SfM으로 재시도함
5. **좌표 정렬**: 카메라 중심과 GPS 위치(UTM)의 닮음변환을 RANSAC으로 추정함
6. **간이 DSM**: 희소 점군에서 날아간 점을 제거하고 격자로 보간함.
   격자 간격은 평균 점 간격의 0.5배(최소 0.5m), 3×3 중앙값과 σ=0.5 가우시안으로 약하게 다듬음.
   점군 밖은 가우시안 정규화 합성곱으로 부드럽게 외삽함(최근접 채움은 번짐을 유발함)
7. **정사투영**: 출력 GSD는 원본 GSD와 같음. 512px 출력 타일 단위로 DSM에 역투영하고,
   화소마다 투영 위치가 영상 중심에 가장 가까운 영상 하나를 골라 씀(심라인 합성).
   경계 부근 몇 화소만 가까운 정도에 따라 지수 가중으로 섞어 이음매를 감춤.
   여러 영상을 평균하지 않으므로 DSM 높이 오차가 있어도 상이 겹치지(고스팅) 않음.
   선택 규칙이 화소 단위로 결정적이므로 타일 경계에서도 이음매가 어긋나지 않음.
   33×33 거친 격자로 타일마다 기여 영상을 미리 고르고, 타일을 4×4 묶음 순서로 처리해 영상 캐시 적중률을 높임
   **밝기·색 보정**: 심라인은 영상 간 노출·반사 차이를 그대로 드러내므로, 정사투영 전에 영상별 이득 곡면을 구해
   읽은 색에 곱함(다중 대역 블렌딩의 저주파 대역에 해당). 거친 지면 격자(셀 200만 개 이하, 최소 원본 16화소)에서
   각 영상의 저주파 밝기를 샘플링하고, 심라인 점수로 넓게(온도 = 영상 대각선 × 0.06) 로그 공간에서 섞어 목표 밝기를 만듦.
   영상마다 목표/자기 밝기 비를 영상 좌표의 2차 다항식으로 Tukey 반복 재가중 최소제곱으로 맞춤.
   노출·주변 감광·완만한 반사 차이만 담고, 건물 시차·파도처럼 영상마다 내용이 다른 국소 차이는 이상값으로 빠짐.
   이음매 근처 표본에 가중을 더 줌. 영상 하나만 덮는 곳의 이득은 1에 가까워 전체 톤은 유지됨. `--no-color-balance`로 끔
8. **마무리**: 오버뷰 생성, COG 변환, 미리보기 생성

## 다중분광 처리 (MicaSense RedEdge·Altum 계열)

폴더의 TIFF 중 Pix4D 카메라 XMP(`Camera:BandName`, `Camera:RigCameraIndex`)가 있는 파일을 밴드 영상으로 보고,
`MicaSense:CaptureId`로 캡처를 묶음. 패널 촬영(`Camera:CalibrationPicture=2`, `Albedo`, `ReflectArea`)은 정렬에서 뺌.

1. **기준 밴드**: 팬크로매틱이 있으면 그것, 없으면 560nm에 가장 가까운 밴드. 열적외·팬크로매틱은 출력 밴드에서 뺌
2. **SfM 입력**: 기준 밴드를 흑색 수준·주변 감광·노출 보정 후 비행 전체 공통 배율로 늘이고(감마 0.5, CLAHE) 8비트 JPEG로 저장
   (`project/msref/`). 내부표정은 메타데이터(초점거리·주점 mm × 초점면 해상도, 왜곡 k1·k2·k3·p1·p2 → COLMAP FULL_OPENCV)로 고정
3. **방사보정**: 제조사 공개 모델 L = V·R(y)·(p − p_BL)·a1 / (g·t_e·2^N), R(y) = 1/(1 + a2·y/t_e − a3·y).
   주변 감광은 방사형 다항식 또는 2차원 다항식. 반사율 ρ = π·L/E (E: DLS 수평 입사광, 시간 순 5캡처 이동 중앙값).
   패널이 있으면 밴드별 배율 k = albedo / ρ_panel(DLS)를 곱함. 음수(잡음)는 자르지 않음
4. **밴드 카메라**: 기준 밴드 자세에 rig 회전(`Camera:RigRelatives`, Rx·Ry·Rz 도)을 더함. `RigTranslations`는 시험 데이터(고도 21m)에서
   적용하면 3~4화소 어긋나 기본으로 쓰지 않음
5. **rig 미세 조정**: 캡처 10개에서 기준 밴드 영상을 현재 모델(rig + DSM)로 각 밴드 영상 좌표에 옮기고, 로그 경사도 크기를 ECC로 맞춰
   남은 이동량을 잼. 중앙값을 밴드 카메라의 작은 회전으로 바꿔 적용하고 한 번 더 반복 (잔차 0.1화소 이내)
6. **방사 블록 조정**: SfM 타이포인트(최대 2만 개)에서 캡처별 밴드 반사율(로그)을 읽고, 점 평균과의 차이를 캡처·밴드 이득으로 설명.
   Tukey 반복 재가중, 관측이 적은 캡처는 이득 1 쪽으로, 캡처 이득 평균은 1로 고정(전체 반사율 수준 유지)
7. **정사투영**: 심라인은 기준 밴드 카메라로 화소마다 한 번 고르고, 모든 밴드를 그 영상에서 각자 카메라로 DSM에 투영해 읽음.
   모든 밴드가 있는 화소만 유효(나머지 NaN). 출력 GSD는 출력 밴드의 원본 GSD
8. **산출물**: 반사율 COG(float32, 예측자 3), `indices.tif`(NDVI·NDRE·GNDVI), `preview.png`(반사율 컬러), `ndvi.png`

공개 시험 데이터(OpenDroneMap Bürgewald 부분집합, RedEdge-P 24캡처, CC0, 고도 약 21m) 결과

| 항목 | 값 |
|---|---|
| 정렬 | 24/24, 재투영 오차 0.65px (내부표정 고정) |
| 밴드 정합 | 조정 전 0.2~0.9화소 → 잔차 0.11화소 이하, 정사영상에서 밴드 간 0.06화소 이하 |
| 캡처 간 반사율 불일치 (타이포인트 RMS) | 방사휘도만 15~23%, DLS 9~14%, 블록 조정 후 6~9% |
| 처리 시간 (2코어 VM) | 246초 (특징점 55, 매칭 23, 매핑 42, 밴드 조정 71, 정사 24, 마무리 24), 피크 1.3GB |

## 성능 참고치

공개 데이터셋 [Aukerman](https://github.com/OpenDroneMap/odm_data_aukerman)(CC0, 77장, 18MP) 기준,
2코어·RAM 7GB 리눅스 VM에서 측정함.

| 단계 | 시간 |
|---|---|
| 특징점 추출 | 109초 |
| 매칭 | 45초 |
| SfM (전역) | 71초 |
| 밝기·색 보정 | 14초 |
| 정사투영 (GSD 2.8cm, 16510×13758px) | 187초 |
| COG 변환·미리보기 | 54초 |
| **합계** | **약 480초** |

- 피크 메모리: 약 2.6GB (영상 캐시가 가용 메모리의 30%, 600~3072MB 범위에서 자동 결정됨)
- 결과 파일: 약 318MB
- v0.2.x(GSD 2배, 8254×6880px)에서는 정사투영 73초, 피크 메모리 1.1GB였음
- 결과: 77/77장 정합, 재투영 오차 1.26px, GPS 잔차(RMS) 0.96m

## 개발

```bash
cd engine
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
pytest
```
