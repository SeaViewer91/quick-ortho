import type { Feature, FeatureCollection, Point } from "geojson";
import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  allowProjectImages,
  cancelEngine,
  parseGcpFile,
  projectInfo,
  queued,
  runJob,
  saveEdits,
  startProjectTask,
  STAGE_LABELS,
  tiepointStats,
  type EngineEvent,
  type Edits,
  type Gcp,
  type GcpParse,
  type GcpRow,
  type GcpSummary,
  type Mark,
  type OrthoResult,
  type ProjectInfo,
  type TiepointStats,
} from "../api";
import MapView, { type Layers, type MapHit, type MapLabel, type Overlay } from "../MapView";
import GcpImport, { type ImportedGcp } from "./GcpImport";
import MarkingPanel, { type MarkTarget } from "./MarkingPanel";
import "./refine.css";

type Props = {
  orthoDir: string;
  ortho: OrthoResult;
  overlay?: Overlay;
  onClose: () => void;
  onRefined: (r: OrthoResult) => void;
};

type Tab = "gcp" | "tie" | "clean";
type Progress = { message: string; current: number; total: number };

const LAYERS: Layers = { quicklook: false, coverage: false, footprints: false, gaps: false, ortho: true };
const THRESHOLDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0];
const MODE_LABEL = { gps: "GPS 정렬", gcp: "GCP 보정", gcp_shift: "GCP 평행 이동" } as const;

const f2 = (v: number | null | undefined, d = 3) => (v == null ? "-" : v.toFixed(d));
const errText = (e: unknown) => String(e instanceof Error ? e.message : e);

export default function RefineView({ orthoDir, ortho, overlay, onClose, onRefined }: Props) {
  const [info, setInfo] = useState<Extract<ProjectInfo, { exists: true }> | null>(null);
  const [missing, setMissing] = useState(false);
  const [edits, setEdits] = useState<Edits | null>(null);
  const [imageDir, setImageDir] = useState("");
  const [tab, setTab] = useState<Tab>("gcp");
  const [target, setTarget] = useState<MarkTarget | null>(null);
  const [stats, setStats] = useState<TiepointStats | null>(null);
  const [selPts, setSelPts] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState<{ file: string; parsed: GcpParse } | null>(null);
  const [picking, setPicking] = useState(false);
  const [running, setRunning] = useState<{ job: number | null; progress: Progress | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshInfo = useCallback(async () => {
    const i = await projectInfo(orthoDir);
    if (!i.exists) {
      setMissing(true);
      return;
    }
    setInfo(i);
    setEdits(i.edits);
  }, [orthoDir]);

  useEffect(() => {
    refreshInfo().catch((e) => setError(errText(e)));
    allowProjectImages(orthoDir)
      .then(setImageDir)
      .catch((e) => setError(errText(e)));
  }, [orthoDir, refreshInfo]);

  const loadStats = useCallback(() => {
    tiepointStats(orthoDir)
      .then(setStats)
      .catch((e) => setError(errText(e)));
  }, [orthoDir]);

  useEffect(() => {
    if (tab === "clean" && !stats && info) loadStats();
  }, [tab, stats, info, loadStats]);

  /** 수정 사항을 화면에 반영하고 곧바로 저장한다 */
  const update = (next: Edits, refreshMap = false) => {
    setEdits(next);
    saveEdits(orthoDir, next)
      .then(() => (refreshMap ? refreshInfo() : undefined))
      .catch((e) => setError(errText(e)));
  };

  const images = useMemo(() => {
    const m: Record<string, { width: number; height: number; registered: boolean }> = {};
    info?.images.forEach((im) => (m[im.name] = im));
    return m;
  }, [info]);

  // ── GCP ──
  async function importGcp() {
    const file = await open({
      multiple: false,
      title: "GCP 측량 성과 파일",
      filters: [{ name: "측량 성과", extensions: ["csv", "txt", "dat", "xyz", "tsv"] }],
    });
    if (typeof file !== "string") return;
    try {
      const parsed = await parseGcpFile(file, orthoDir);
      setImporting({ file, parsed });
    } catch (e) {
      setError(errText(e));
    }
  }

  function applyImport(list: ImportedGcp[]) {
    if (!edits) return;
    const byName = new Map(edits.gcps.map((g) => [g.name, g]));
    for (const g of list) {
      const old = byName.get(g.name);
      byName.set(g.name, { ...g, role: old?.role ?? "control", obs: old?.obs ?? [] });
    }
    update({ ...edits, gcps: [...byName.values()] }, true);
    setImporting(null);
  }

  const setGcp = (name: string, patch: Partial<Gcp>, refreshMap = false) =>
    edits && update({ ...edits, gcps: edits.gcps.map((g) => (g.name === name ? { ...g, ...patch } : g)) }, refreshMap);
  const removeGcp = (name: string) =>
    edits && update({ ...edits, gcps: edits.gcps.filter((g) => g.name !== name) }, true);

  // ── 표시 작업 ──
  const openGcp = (g: Gcp) =>
    setTarget({
      kind: "gcp",
      key: `gcp:${g.name}`,
      title: `GCP ${g.name} (${g.role === "control" ? "기준점" : "검사점"})`,
      obs: g.obs,
      world: { x: g.x, y: g.y, z: g.z, epsg: g.epsg },
    });

  const onMarks = (obs: Mark[]) => {
    if (!edits || !target) return;
    setTarget({ ...target, obs });
    const id = target.key.slice(4);
    if (target.kind === "gcp") {
      update({ ...edits, gcps: edits.gcps.map((g) => (g.name === id ? { ...g, obs } : g)) });
    } else {
      const exists = edits.tiepoints.some((t) => t.id === id);
      const tps = exists
        ? edits.tiepoints.map((t) => (t.id === id ? { ...t, obs } : t))
        : [...edits.tiepoints, { id, obs }];
      update({ ...edits, tiepoints: tps });
    }
  };

  const nextTieId = () => {
    const used = new Set(edits?.tiepoints.map((t) => t.id));
    let k = 1;
    while (used.has(`T${k}`)) k++;
    return `T${k}`;
  };

  const onMapClick = (ll: [number, number], hit: MapHit) => {
    if (picking) {
      setPicking(false);
      const id = nextTieId();
      setTarget({
        kind: "tie",
        key: `tie:${id}`,
        title: `타이포인트 ${id}`,
        obs: [],
        world: { x: ll[0], y: ll[1], z: 0, epsg: 4326, z_from_dsm: true },
      });
      return;
    }
    if (tab === "clean" && hit?.kind === "err" && hit.id !== undefined) togglePt(hit.id);
  };

  // ── 오차 정리 ──
  const togglePt = (id: number) =>
    setSelPts((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const deleteSelected = () => {
    if (!edits || !selPts.size) return;
    update({ ...edits, deleted_points: [...new Set([...edits.deleted_points, ...selPts])] });
    setSelPts(new Set());
  };

  // ── 보정 실행 ──
  async function runRefine(reset = false) {
    setError(null);
    setRunning({ job: null, progress: null });
    const onEvent = (e: EngineEvent) => {
      if (e.type === "stage") setRunning((r) => r && { ...r, progress: { message: e.message, current: 0, total: 0 } });
      else if (e.type === "progress")
        setRunning(
          (r) =>
            r && {
              ...r,
              progress: {
                message: r.progress?.message ?? STAGE_LABELS[e.stage] ?? e.stage,
                current: e.current,
                total: e.total,
              },
            },
        );
    };
    try {
      const res = await queued(() =>
        runJob<OrthoResult>(
          () => startProjectTask("refine", orthoDir, reset ? ["--reset"] : []),
          onEvent,
          (j) => setRunning((r) => r && { ...r, job: j.job_id }),
        ),
      );
      onRefined(res);
      setStats(null);
      setSelPts(new Set());
      await refreshInfo();
      if (tab === "clean") loadStats();
    } catch (e) {
      setError(errText(e));
    } finally {
      setRunning(null);
    }
  }

  // ── 지도 ──
  const labels: MapLabel[] = useMemo(() => {
    if (!info || !edits) return [];
    const ll = info.gcp_lonlat;
    return info.edits.gcps
      .map((g, i) => {
        const cur = edits.gcps.find((x) => x.name === g.name);
        if (!cur || !ll[i]) return null;
        const active = target?.key === `gcp:${g.name}`;
        return {
          lon: ll[i][0],
          lat: ll[i][1],
          text: `${g.name}${cur.obs.length ? ` (${cur.obs.length})` : ""}`,
          kind: active ? "active" : cur.role,
        } as MapLabel;
      })
      .filter((x): x is MapLabel => x !== null);
  }, [info, edits, target]);

  const points: FeatureCollection | undefined = useMemo(() => {
    if (tab !== "clean" || !stats) return undefined;
    const deleted = new Set(edits?.deleted_points);
    const features: Feature<Point>[] = stats.map_points
      .filter((p) => !deleted.has(p[3]))
      .map(([lon, lat, err, id]) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: { err, id, sel: selPts.has(id) },
      }));
    return { type: "FeatureCollection", features };
  }, [tab, stats, selPts, edits?.deleted_points]);

  const report = ortho.refine;
  const reportRows = new Map<string, GcpRow>((report?.gcps ?? []).map((r) => [r.name, r]));
  const busy = running !== null;
  const pct = running?.progress && running.progress.total > 0 ? Math.round((running.progress.current / running.progress.total) * 100) : null;

  if (missing) {
    return (
      <div className="refine-missing">
        <div className="panel">
          <h2>정밀 보정</h2>
          <p>이 결과에는 보정용 프로젝트가 없음. 이전 버전에서 만든 결과이면 정사 모자이크를 다시 생성해야 함.</p>
          <button type="button" onClick={onClose}>
            돌아가기
          </button>
        </div>
      </div>
    );
  }

  const gcps = edits?.gcps ?? [];
  const nControl = gcps.filter((g) => g.role === "control" && g.obs.length >= 2).length;
  const nCheck = gcps.filter((g) => g.role === "check" && g.obs.length >= 2).length;

  return (
    <div className="refine">
      <aside className="side refine-side">
        <section className="panel">
          <div className="row-between">
            <h2>정밀 보정</h2>
            <button type="button" className="secondary small-btn" onClick={onClose} disabled={busy}>
              닫기
            </button>
          </div>
          {info && (
            <p className="muted small">
              {info.source === "refined" ? "보정 결과" : "최초 결과"} · {info.frame.name} (EPSG:{info.frame.epsg})
            </p>
          )}
          <div className="tabs">
            {(
              [
                ["gcp", `GCP ${gcps.length || ""}`],
                ["tie", `타이포인트 ${edits?.tiepoints.length || ""}`],
                ["clean", "오차 정리"],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                className={`tab ${tab === k ? "active" : ""}`}
                onClick={() => {
                  setTab(k);
                  setPicking(false);
                }}
              >
                {l}
              </button>
            ))}
          </div>
        </section>

        {error && (
          <section className="panel error-panel">
            <div className="row-between">
              <h2>오류</h2>
              <button type="button" className="secondary small-btn" onClick={() => setError(null)}>
                닫기
              </button>
            </div>
            <pre>{error}</pre>
          </section>
        )}

        {tab === "gcp" && edits && (
          <section className="panel">
            <button type="button" onClick={importGcp} disabled={busy}>
              측량 성과 파일 불러오기
            </button>
            <p className="muted small">
              기준점 3점 이상, 점마다 사진 2장 이상(3장 이상 권장)에 표시함. 검사점은 보정에 쓰지 않고 정확도 확인에만 씀.
            </p>
            {gcps.length > 0 && (
              <table className="grid compact">
                <thead>
                  <tr>
                    <th>점명</th>
                    <th>역할</th>
                    <th>표시</th>
                    <th title="마지막 보정의 수평·수직 오차">오차 XY/Z (m)</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {gcps.map((g) => {
                    const r = reportRows.get(g.name);
                    return (
                      <tr key={g.name} className={target?.key === `gcp:${g.name}` ? "sel" : ""}>
                        <td>
                          <button type="button" className="link" onClick={() => openGcp(g)} title={`${g.x}, ${g.y}, ${g.z} (EPSG:${g.epsg})`}>
                            {g.name}
                          </button>
                        </td>
                        <td>
                          <select
                            value={g.role}
                            onChange={(e) => setGcp(g.name, { role: e.target.value as Gcp["role"] }, true)}
                            disabled={busy}
                          >
                            <option value="control">기준</option>
                            <option value="check">검사</option>
                          </select>
                        </td>
                        <td className={g.obs.length >= 2 ? "" : "warn-text"}>{g.obs.length}</td>
                        <td>{r && r.dxy != null ? `${f2(r.dxy, 3)} / ${f2(r.dz, 3)}` : "-"}</td>
                        <td>
                          <button type="button" className="link danger" onClick={() => removeGcp(g.name)} disabled={busy}>
                            삭제
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {gcps.length > 0 && (
              <p className="muted small">점명을 누르면 사진에서 위치를 표시함. EPSG:{[...new Set(gcps.map((g) => g.epsg))].join(", ")}</p>
            )}
          </section>
        )}

        {tab === "tie" && edits && (
          <section className="panel">
            <button type="button" onClick={() => setPicking((p) => !p)} disabled={busy} className={picking ? "secondary" : ""}>
              {picking ? "위치 고르기 취소" : "새 타이포인트"}
            </button>
            <p className="muted small">
              {picking
                ? "지도에서 타이포인트를 찍을 위치를 클릭함"
                : "정합이 약한 곳(사진 경계, 어긋난 곳)의 같은 지점을 사진 2장 이상에 표시해 연결을 보강함"}
            </p>
            {edits.tiepoints.length > 0 && (
              <table className="grid compact">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>표시</th>
                    <th>오차(px)</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {edits.tiepoints.map((t) => {
                    const r = report?.manual_tiepoints?.find((m) => m.id === t.id);
                    return (
                      <tr key={t.id} className={target?.key === `tie:${t.id}` ? "sel" : ""}>
                        <td>
                          <button
                            type="button"
                            className="link"
                            onClick={() =>
                              setTarget({ kind: "tie", key: `tie:${t.id}`, title: `타이포인트 ${t.id}`, obs: t.obs })
                            }
                          >
                            {t.id}
                          </button>
                        </td>
                        <td className={t.obs.length >= 2 ? "" : "warn-text"}>{t.obs.length}</td>
                        <td>{r ? f2(r.error_px, 2) : "-"}</td>
                        <td>
                          <button
                            type="button"
                            className="link danger"
                            disabled={busy}
                            onClick={() => {
                              update({ ...edits, tiepoints: edits.tiepoints.filter((x) => x.id !== t.id) });
                              if (target?.key === `tie:${t.id}`) setTarget(null);
                            }}
                          >
                            삭제
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        )}

        {tab === "clean" && edits && (
          <CleanPanel
            stats={stats}
            edits={edits}
            selPts={selPts}
            busy={busy}
            onThreshold={(v) => update({ ...edits, max_reproj_error_px: v })}
            onToggle={togglePt}
            onDelete={deleteSelected}
            onClearDeleted={() => update({ ...edits, deleted_points: [] })}
            onReload={loadStats}
          />
        )}

        <section className="panel">
          <h2>보정 실행</h2>
          <p className="muted small">
            기준점 {nControl}점 · 검사점 {nCheck}점 · 타이포인트 {edits?.tiepoints.filter((t) => t.obs.length >= 2).length ?? 0}점 ·
            삭제 {edits?.deleted_points.length ?? 0}점 · 자동 제거{" "}
            {edits?.max_reproj_error_px ? `${edits.max_reproj_error_px} px 초과` : "안 함"}
          </p>
          <p className="muted small">
            {nControl >= 3
              ? "GCP로 좌표를 맞춘 뒤 번들 조정함"
              : nControl > 0
                ? "기준점이 3점 미만이라 GPS 정렬 후 평행 이동만 적용함"
                : "번들 조정 후 GPS로 다시 정렬함"}
          </p>
          {busy ? (
            <>
              <p className="muted small">{running?.progress?.message ?? "시작하는 중"}</p>
              <div className="bar">
                <div className={`bar-fill ${pct === null ? "indeterminate" : ""}`} style={{ width: `${pct ?? 30}%` }} />
              </div>
              <button
                type="button"
                className="secondary"
                onClick={() => running?.job != null && cancelEngine(running.job)}
                disabled={running?.job == null}
              >
                중단
              </button>
            </>
          ) : (
            <div className="actions">
              <button type="button" onClick={() => runRefine(false)} disabled={!edits}>
                보정 실행
              </button>
              {info?.source === "refined" && (
                <button type="button" className="secondary" onClick={() => runRefine(true)}>
                  최초 결과로 되돌리기
                </button>
              )}
            </div>
          )}
        </section>

        {report && <ReportPanel ortho={ortho} />}
      </aside>

      <section className="map-wrap">
        <MapView ortho={overlay} layers={LAYERS} labels={labels} points={points} onClick={onMapClick} crosshair={picking} />
        {picking && <div className="map-hint">타이포인트를 찍을 위치를 클릭함</div>}
        {target && info && imageDir && (
          <div className="marking-overlay">
            <MarkingPanel
              orthoDir={orthoDir}
              imageDir={imageDir}
              images={images}
              target={target}
              onChange={onMarks}
              onClose={() => {
                setTarget(null);
                refreshInfo().catch(() => undefined);
              }}
            />
          </div>
        )}
      </section>

      {importing && (
        <GcpImport
          file={importing.file}
          orthoDir={orthoDir}
          initial={importing.parsed}
          onCancel={() => setImporting(null)}
          onImport={applyImport}
        />
      )}
    </div>
  );
}

function CleanPanel({
  stats,
  edits,
  selPts,
  busy,
  onThreshold,
  onToggle,
  onDelete,
  onClearDeleted,
  onReload,
}: {
  stats: TiepointStats | null;
  edits: Edits;
  selPts: Set<number>;
  busy: boolean;
  onThreshold: (v: number | null) => void;
  onToggle: (id: number) => void;
  onDelete: () => void;
  onClearDeleted: () => void;
  onReload: () => void;
}) {
  if (!stats) {
    return (
      <section className="panel">
        <p className="muted">타이포인트 오차 계산 중</p>
      </section>
    );
  }
  const s = stats.summary;
  const maxCount = Math.max(1, ...stats.histogram.counts);
  const deleted = new Set(edits.deleted_points);
  const thr = edits.max_reproj_error_px;
  const pv = stats.threshold_preview.find((p) => p.threshold_px === thr);
  return (
    <>
      <section className="panel">
        <div className="row-between">
          <h2>현재 타이포인트</h2>
          <button type="button" className="secondary small-btn" onClick={onReload} disabled={busy}>
            새로 계산
          </button>
        </div>
        <dl className="stats">
          <dt>3D 점 / 관측</dt>
          <dd>
            {s.num_points.toLocaleString()} / {s.num_observations.toLocaleString()}
          </dd>
          <dt>재투영 오차 RMSE</dt>
          <dd>{s.rmse_px.toFixed(3)} px</dd>
          <dt>평균 / 95%</dt>
          <dd>
            {s.mean_px.toFixed(3)} / {s.p95_px.toFixed(2)} px
          </dd>
        </dl>
        <div className="hist" title="관측별 재투영 오차 분포 (0~5 px, 0.25 px 간격)">
          {stats.histogram.counts.map((c, i) => (
            <span
              key={i}
              style={{ height: `${Math.max(2, (c / maxCount) * 100)}%` }}
              className={thr !== null && stats.histogram.edges[i] >= thr ? "over" : ""}
              title={`${stats.histogram.edges[i]}~${stats.histogram.edges[i + 1] ?? "∞"} px: ${c}`}
            />
          ))}
        </div>
        <div className="hist-axis muted small">
          <span>0</span>
          <span>2.5</span>
          <span>5 px+</span>
        </div>
      </section>

      <section className="panel">
        <h2>오차 큰 관측 자동 제거</h2>
        <label className="field">
          <span>기준 (재투영 오차)</span>
          <select
            value={thr ?? ""}
            onChange={(e) => onThreshold(e.target.value === "" ? null : Number(e.target.value))}
            disabled={busy}
          >
            <option value="">사용 안 함</option>
            {THRESHOLDS.map((t) => {
              const p = stats.threshold_preview.find((x) => x.threshold_px === t);
              return (
                <option key={t} value={t}>
                  {t} px 초과 제거{p ? ` (관측 ${(p.removed_ratio * 100).toFixed(1)}%)` : ""}
                </option>
              );
            })}
          </select>
        </label>
        {pv && (
          <p className="muted small">
            최초 결과 기준 관측 {pv.removed_obs.toLocaleString()}개({(pv.removed_ratio * 100).toFixed(1)}%) 제거, 남은 관측 RMSE{" "}
            {pv.rmse_px_after.toFixed(3)} px. 제거 후 번들 조정으로 더 낮아짐
          </p>
        )}
        <p className="muted small">
          권장 기준 {stats.recommended_px} px (관측 10% 이하 제거). 관측을 너무 많이 지우면 사진 간 연결이 약해져 정합이 오히려
          나빠질 수 있음
        </p>
      </section>

      <section className="panel">
        <div className="row-between">
          <h2>오차 큰 점</h2>
          <span className="muted small">지도에서 점을 눌러도 선택됨</span>
        </div>
        <div className="table-wrap tall">
          <table className="grid compact">
            <thead>
              <tr>
                <th />
                <th>ID</th>
                <th>RMS(px)</th>
                <th>최대</th>
                <th>관측</th>
              </tr>
            </thead>
            <tbody>
              {stats.worst.slice(0, 200).map((w) => (
                <tr key={w.id} className={`${selPts.has(w.id) ? "sel" : ""} ${deleted.has(w.id) ? "deleted" : ""}`}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selPts.has(w.id)}
                      disabled={deleted.has(w.id) || !!w.manual}
                      onChange={() => onToggle(w.id)}
                    />
                  </td>
                  <td>{w.manual ?? w.id}</td>
                  <td>{w.error_px.toFixed(2)}</td>
                  <td>{w.max_px.toFixed(2)}</td>
                  <td>{w.track}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="actions">
          <button type="button" onClick={onDelete} disabled={busy || !selPts.size}>
            선택한 점 삭제 ({selPts.size})
          </button>
          {edits.deleted_points.length > 0 && (
            <button type="button" className="secondary" onClick={onClearDeleted} disabled={busy}>
              삭제 목록 비우기 ({edits.deleted_points.length})
            </button>
          )}
        </div>
        <p className="muted small">삭제는 보정 실행 때 적용됨</p>
      </section>

      <section className="panel">
        <h2>사진별 오차</h2>
        <table className="grid compact">
          <thead>
            <tr>
              <th>사진</th>
              <th>관측</th>
              <th>RMSE(px)</th>
            </tr>
          </thead>
          <tbody>
            {stats.per_image.slice(0, 8).map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td>{r.num_obs.toLocaleString()}</td>
                <td>{f2(r.rmse_px, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function SummaryRows({ label, s }: { label: string; s: GcpSummary }) {
  if (!s) return null;
  return (
    <tr>
      <td>
        {label} {s.count}점
      </td>
      <td>{f2(s.rmse_x)}</td>
      <td>{f2(s.rmse_y)}</td>
      <td>{f2(s.rmse_z)}</td>
      <td>{f2(s.rmse_3d)}</td>
    </tr>
  );
}

function ReportPanel({ ortho }: { ortho: OrthoResult }) {
  const r = ortho.refine!;
  return (
    <section className="panel">
      <h2>마지막 보정 결과</h2>
      <dl className="stats">
        <dt>방식</dt>
        <dd>
          {MODE_LABEL[r.mode]}
          {r.intrinsics_refined ? " + 카메라 보정" : ""}
        </dd>
        <dt>좌표계</dt>
        <dd>EPSG:{r.epsg}</dd>
        <dt>재투영 RMSE</dt>
        <dd>
          {r.before.rmse_px.toFixed(3)} → {r.after.rmse_px.toFixed(3)} px
        </dd>
        <dt>3D 점</dt>
        <dd>
          {r.before.num_points.toLocaleString()} → {r.after.num_points.toLocaleString()}
        </dd>
        {r.gps_residual_rms_m !== undefined && (
          <>
            <dt>GPS 잔차</dt>
            <dd>{r.gps_residual_rms_m.toFixed(2)} m</dd>
          </>
        )}
      </dl>
      {(r.gcp_summary?.control || r.gcp_summary?.check) && (
        <table className="grid compact">
          <thead>
            <tr>
              <th>RMSE (m)</th>
              <th>X</th>
              <th>Y</th>
              <th>Z</th>
              <th>3D</th>
            </tr>
          </thead>
          <tbody>
            <SummaryRows label="기준점" s={r.gcp_summary.control} />
            <SummaryRows label="검사점" s={r.gcp_summary.check} />
          </tbody>
        </table>
      )}
      {r.gcps.length > 0 && (
        <details>
          <summary className="small">점별 오차</summary>
          <table className="grid compact">
            <thead>
              <tr>
                <th>점명</th>
                <th>dX</th>
                <th>dY</th>
                <th>dZ</th>
                <th>px</th>
              </tr>
            </thead>
            <tbody>
              {r.gcps.map((g) => (
                <tr key={g.name}>
                  <td>
                    {g.name}
                    {g.role === "check" ? " (검)" : ""}
                  </td>
                  <td>{f2(g.dx)}</td>
                  <td>{f2(g.dy)}</td>
                  <td>{f2(g.dz)}</td>
                  <td>{f2(g.reproj_px, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <ul className="warnings">
        {r.warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </section>
  );
}
