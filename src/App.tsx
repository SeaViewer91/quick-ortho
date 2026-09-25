import type { FeatureCollection } from "geojson";
import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  appInfo,
  cancelEngine,
  readJson,
  readPng,
  runJob,
  startOrtho,
  startPreview,
  STAGE_LABELS,
  type AppInfo,
  type EngineEvent,
  type OrthoResult,
  type PreviewResult,
} from "./api";
import MapView, { type Layers, type Overlay } from "./MapView";
import "./App.css";

type Progress = { stage: string; message: string; current: number; total: number };
type Busy = "load" | "quicklook" | "ortho" | null;

const BUSY_TITLE = { load: "데이터 불러오기", quicklook: "간이 모자이크 생성", ortho: "정사 모자이크 생성" };

const fmtArea = (m2: number) => (m2 >= 10000 ? `${(m2 / 10000).toFixed(2)} ha` : `${Math.round(m2)} m²`);
const fmtRange = (a: number, b: number) =>
  Math.round(a) === Math.round(b) ? `${Math.round(a)}` : `${Math.round(a)}~${Math.round(b)}`;
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [ortho, setOrtho] = useState<OrthoResult | null>(null);
  const [overlays, setOverlays] = useState<{ quicklook?: Overlay; coverage?: Overlay; ortho?: Overlay }>({});
  const [geojson, setGeojson] = useState<FeatureCollection>();
  const [layers, setLayers] = useState<Layers>({
    quicklook: true,
    coverage: false,
    footprints: true,
    gaps: true,
    ortho: true,
  });
  const jobRef = useRef<number | null>(null);

  useEffect(() => {
    appInfo().then(setInfo).catch(() => undefined);
  }, []);

  const onEvent = (e: EngineEvent) => {
    if (e.type === "stage") {
      setProgress({ stage: e.name, message: e.message, current: 0, total: 0 });
    } else if (e.type === "progress") {
      setProgress((p) => ({
        stage: e.stage,
        message: p?.stage === e.stage ? p.message : STAGE_LABELS[e.stage] ?? e.stage,
        current: e.current,
        total: e.total,
      }));
    }
  };

  /** 데이터 불러오기: 영상 디코딩 없이 EXIF로 촬영 위치·범위·중복도만 계산한다. */
  async function loadData(dir: string) {
    setBusy("load");
    setError(null);
    setPreview(null);
    setOrtho(null);
    setOverlays({});
    setGeojson(undefined);
    setLayers((l) => ({ ...l, footprints: true, quicklook: true, coverage: false }));
    try {
      const res = await runJob<PreviewResult>(
        () => startPreview(dir, false),
        onEvent,
        (j) => (jobRef.current = j.job_id),
      );
      const [c, g] = await Promise.all([readPng(res.outputs.coverage), readJson<FeatureCollection>(res.outputs.geojson)]);
      setPreview(res);
      setOverlays({ coverage: { url: c, corners: res.corners_lonlat } });
      setGeojson(g);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
      setProgress(null);
      jobRef.current = null;
    }
  }

  /** 간이 모자이크: 사용자가 버튼으로 실행한다. */
  async function makeQuicklook() {
    if (!folder) return;
    setBusy("quicklook");
    setError(null);
    try {
      const res = await runJob<PreviewResult>(
        () => startPreview(folder, true),
        onEvent,
        (j) => (jobRef.current = j.job_id),
      );
      if (!res.outputs.quicklook) throw new Error("간이 모자이크 결과가 없음");
      const q = await readPng(res.outputs.quicklook);
      setPreview(res);
      setOverlays((o) => ({ ...o, quicklook: { url: q, corners: res.corners_lonlat } }));
      setLayers((l) => ({ ...l, quicklook: true, footprints: false }));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
      setProgress(null);
      jobRef.current = null;
    }
  }

  async function chooseFolder() {
    const dir = await open({ directory: true, multiple: false, title: "드론 영상 폴더 선택" });
    if (typeof dir === "string") {
      setFolder(dir);
      await loadData(dir);
    }
  }

  async function runOrtho() {
    if (!folder) return;
    setBusy("ortho");
    setError(null);
    try {
      const res = await runJob<OrthoResult>(() => startOrtho(folder), onEvent, (j) => (jobRef.current = j.job_id));
      const url = await readPng(res.outputs.preview);
      setOrtho(res);
      setOverlays((o) => ({ ...o, ortho: { url, corners: res.preview_corners_lonlat } }));
      setLayers((l) => ({ ...l, ortho: true, quicklook: false, coverage: false }));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
      setProgress(null);
      jobRef.current = null;
    }
  }

  async function cancel() {
    if (jobRef.current !== null) await cancelEngine(jobRef.current);
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : null;
  const toggle = (k: keyof Layers) => setLayers((l) => ({ ...l, [k]: !l[k] }));

  return (
    <div className="app">
      <header className="app-header">
        <h1>QuickOrtho</h1>
        <span className="subtitle">드론 영상 정사 모자이크</span>
      </header>

      <main className="app-main">
        <aside className="side">
          <section className="panel">
            <button type="button" onClick={chooseFolder} disabled={busy !== null}>
              영상 폴더 선택
            </button>
            {folder && (
              <p className="folder" title={folder}>
                {baseName(folder)}
              </p>
            )}
          </section>

          {busy && (
            <section className="panel">
              <h2>{BUSY_TITLE[busy]}</h2>
              <p className="muted">{progress?.message ?? "시작하는 중"}</p>
              <div className="bar">
                <div className={`bar-fill ${pct === null ? "indeterminate" : ""}`} style={{ width: `${pct ?? 30}%` }} />
              </div>
              {pct !== null && (
                <p className="muted small">
                  {progress!.current}/{progress!.total} ({pct}%)
                </p>
              )}
              <button type="button" className="secondary" onClick={cancel}>
                중단
              </button>
            </section>
          )}

          {error && (
            <section className="panel error-panel">
              <h2>오류</h2>
              <pre>{error}</pre>
            </section>
          )}

          {preview && (
            <section className="panel">
              <h2>촬영 상태</h2>
              {preview.gaps > 0 ? (
                <p className="badge bad">
                  누락 구역 {preview.gaps}곳 · {fmtArea(preview.coverage.gap_area_m2)}
                </p>
              ) : (
                <p className="badge good">누락 구역 없음</p>
              )}
              <dl className="stats">
                <dt>영상</dt>
                <dd>{preview.num_images}장</dd>
                <dt>비행고도</dt>
                <dd>{fmtRange(preview.flight_height_m.min, preview.flight_height_m.max)} m</dd>
                <dt>조사 면적</dt>
                <dd>{fmtArea(preview.coverage.survey_area_m2)}</dd>
                <dt>중복 매수(중앙값)</dt>
                <dd>{preview.coverage.overlap_median}장</dd>
                <dt>전방 중복률</dt>
                <dd>
                  {preview.forward_overlap_median === null ? "-" : `${Math.round(preview.forward_overlap_median * 100)}%`}
                </dd>
                <dt>저중복 면적</dt>
                <dd>{fmtArea(preview.coverage.low_overlap_area_m2)}</dd>
                <dt>계산 시간</dt>
                <dd>{preview.time_s.toFixed(1)}초</dd>
              </dl>
              <Warnings items={preview.warnings} />
              <div className="actions">
                <button type="button" className="secondary" onClick={makeQuicklook} disabled={busy !== null}>
                  {overlays.quicklook ? "간이 모자이크 다시 생성" : "간이 모자이크 생성"}
                </button>
                <button type="button" onClick={runOrtho} disabled={busy !== null}>
                  {ortho ? "정사 모자이크 다시 생성" : "정사 모자이크 생성"}
                </button>
              </div>
              <p className="muted small">간이 모자이크는 수 초, 정사 모자이크는 수 분이 걸림</p>
            </section>
          )}

          {ortho && (
            <section className="panel">
              <h2>정사 모자이크</h2>
              <dl className="stats">
                <dt>정합</dt>
                <dd>
                  {ortho.sfm.num_registered}/{ortho.sfm.num_input_images}장
                </dd>
                <dt>GSD</dt>
                <dd>{(ortho.ortho.gsd_m * 100).toFixed(1)} cm</dd>
                <dt>재투영 오차</dt>
                <dd>{ortho.sfm.mean_reprojection_error_px.toFixed(2)} px</dd>
                <dt>GPS 잔차</dt>
                <dd>{ortho.georef.gps_residual_rms_m.toFixed(2)} m</dd>
                <dt>처리 시간</dt>
                <dd>{Math.round(ortho.timings_s.total_s)}초</dd>
                <dt>최대 메모리</dt>
                <dd>{(ortho.peak_memory_mb / 1024).toFixed(2)} GB</dd>
              </dl>
              <Warnings items={ortho.warnings} />
              <button type="button" className="secondary" onClick={() => revealItemInDir(ortho.outputs.orthomosaic)}>
                결과 폴더 열기
              </button>
            </section>
          )}

          {(preview || ortho) && (
            <section className="panel">
              <h2>레이어</h2>
              {overlays.quicklook && (
                <label>
                  <input type="checkbox" checked={layers.quicklook} onChange={() => toggle("quicklook")} /> 간이 모자이크
                </label>
              )}
              {ortho && (
                <label>
                  <input type="checkbox" checked={layers.ortho} onChange={() => toggle("ortho")} /> 정사 모자이크
                </label>
              )}
              <label>
                <input type="checkbox" checked={layers.coverage} onChange={() => toggle("coverage")} /> 중복도
              </label>
              <label>
                <input type="checkbox" checked={layers.footprints} onChange={() => toggle("footprints")} /> 촬영 범위·위치
              </label>
              <label>
                <input type="checkbox" checked={layers.gaps} onChange={() => toggle("gaps")} /> 누락 구역
              </label>
              {layers.coverage && (
                <div className="legend">
                  <span style={{ background: "#dc322f" }} />1장
                  <span style={{ background: "#f08c1e" }} />2장
                  <span style={{ background: "#e6c828" }} />3~4장
                  <span style={{ background: "#3caa5a" }} />5장 이상
                </div>
              )}
            </section>
          )}
        </aside>

        <section className="map-wrap">
          <MapView {...overlays} geojson={geojson} layers={layers} />
          {!preview && !busy && <div className="map-hint">영상 폴더를 선택하면 촬영 위치와 범위가 표시됨</div>}
        </section>
      </main>

      <footer className="app-footer">
        {info && (
          <span>
            {info.name} v{info.version} · {info.os}/{info.arch}
          </span>
        )}
      </footer>
    </div>
  );
}

function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="warnings">
      {items.map((w) => (
        <li key={w}>{w}</li>
      ))}
    </ul>
  );
}

export default App;
