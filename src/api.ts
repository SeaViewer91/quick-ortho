import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type LonLat = [number, number];
/** 좌상, 우상, 우하, 좌하 순서의 경위도 */
export type Corners = [LonLat, LonLat, LonLat, LonLat];

export type EngineEvent =
  | { type: "stage"; name: string; message: string }
  | { type: "progress"; stage: string; current: number; total: number }
  | { type: "log"; level: string; message: string }
  | { type: "result"; command: string; data: unknown }
  | { type: "error"; message: string; detail?: string };

export type JobInfo = { job_id: number; output_dir: string };

export type PreviewResult = {
  folder: string;
  num_images: number;
  epsg: number;
  corners_lonlat: Corners;
  cell_m: number;
  coverage: {
    survey_area_m2: number;
    gap_area_m2: number;
    low_overlap_area_m2: number;
    overlap_median: number;
    overlap_p10: number;
  };
  forward_overlap_median: number | null;
  flight_height_m: { min: number; max: number };
  gaps: number;
  outputs: { quicklook: string | null; coverage: string; geojson: string };
  warnings: string[];
  time_s: number;
};

export type OrthoResult = {
  input: { selected: number; with_gps: number };
  sfm: {
    num_registered: number;
    num_input_images: number;
    mean_reprojection_error_px: number;
    mapper: string;
  };
  georef: { epsg: number; gps_residual_rms_m?: number; mode?: "gps" | "gcp" | "gcp_shift"; note?: string };
  ortho: { width: number; height: number; gsd_m: number };
  outputs: { orthomosaic: string; dsm: string; preview: string };
  preview_corners_lonlat: Corners;
  timings_s: { total_s: number };
  peak_memory_mb: number;
  warnings: string[];
  refine?: RefineInfo;
};

export type AppInfo = { name: string; version: string; os: string; arch: string };

export const appInfo = () => invoke<AppInfo>("app_info");

export type EngineReady = { ok: boolean; version?: string; warmup_s?: number; error?: string };
export type EngineStatus = { running: boolean; busy: number | null; ready: EngineReady | null; command: string };
export const engineStatus = () => invoke<EngineStatus>("engine_status");
export const onEngineReady = (cb: (r: EngineReady) => void) =>
  listen<EngineReady>("engine://ready", (e) => cb(e.payload));
export const startPreview = (folder: string, quicklook: boolean) =>
  invoke<JobInfo>("start_preview", { folder, quicklook });
export const startOrtho = (folder: string, gsdScale?: number) =>
  invoke<JobInfo>("start_ortho", { folder, gsdScale });
export const cancelEngine = (jobId: number) => invoke<void>("cancel_engine", { jobId });
export const readPng = (path: string) => invoke<string>("read_png_data_url", { path });
export const readJson = <T>(path: string) => invoke<T>("read_result_json", { path });

type ExitPayload = { job_id: number; code: number | null; cancelled: boolean; stderr_tail: string };

/**
 * 엔진 작업 하나를 실행하고 이벤트를 콜백으로 전달한다. 결과(result 이벤트의 data)로 resolve 된다.
 */
export async function runJob<T>(
  start: () => Promise<JobInfo>,
  onEvent: (e: EngineEvent) => void,
  onStarted?: (job: JobInfo) => void,
): Promise<T> {
  let jobId = -1;
  let result: T | undefined;
  let error: string | undefined;
  const unlisten: UnlistenFn[] = [];
  const pending: { job_id: number; event: EngineEvent }[] = [];

  const earlyExits: ExitPayload[] = [];
  let resolveExit: (p: ExitPayload) => void = () => {};
  const done = new Promise<ExitPayload>((resolve) => (resolveExit = resolve));
  // 리스너를 모두 등록한 뒤 작업을 시작해야 짧은 작업의 이벤트를 놓치지 않는다
  unlisten.push(
    await listen<ExitPayload>("engine://exit", (e) => {
      if (jobId < 0) earlyExits.push(e.payload);
      else if (e.payload.job_id === jobId) resolveExit(e.payload);
    }),
  );
  const handle = (ev: EngineEvent) => {
    if (ev.type === "result") result = ev.data as T;
    if (ev.type === "error") error = ev.message;
    onEvent(ev);
  };
  unlisten.push(
    await listen<{ job_id: number; event: EngineEvent }>("engine://event", (e) => {
      if (jobId < 0) pending.push(e.payload);
      else if (e.payload.job_id === jobId) handle(e.payload.event);
    }),
  );

  try {
    const job = await start();
    jobId = job.job_id;
    onStarted?.(job);
    for (const p of pending) if (p.job_id === jobId) handle(p.event);
    const early = earlyExits.find((x) => x.job_id === jobId);
    if (early) resolveExit(early);
    const exit = await done;
    if (exit.cancelled) throw new Error("사용자가 작업을 중단함");
    if (error) throw new Error(error);
    if (exit.code !== 0 || result === undefined) {
      throw new Error(`엔진이 비정상 종료됨 (코드 ${exit.code})\n${exit.stderr_tail}`);
    }
    return result;
  } finally {
    unlisten.forEach((u) => u());
  }
}

// ───────────────────────── 정밀 보정 ─────────────────────────

export type Mark = { image: string; x: number; y: number };
export type GcpRole = "control" | "check";
export type Gcp = { name: string; x: number; y: number; z: number; epsg: number; role: GcpRole; obs: Mark[] };
export type TiePoint = { id: string; obs: Mark[] };
export type Edits = {
  version: number;
  deleted_points: number[];
  max_reproj_error_px: number | null;
  tiepoints: TiePoint[];
  gcps: Gcp[];
};
export type EpsgPreset = { epsg: number; label: string };

export type ProjectInfo =
  | { exists: false; epsg_presets: EpsgPreset[] }
  | {
      exists: true;
      image_dir: string;
      source: "base" | "refined";
      frame: { epsg: number; origin: number[]; name: string };
      vertical: "gps" | "gcp";
      images: { name: string; registered: boolean; width: number; height: number }[];
      edits: Edits;
      gcp_lonlat: [number, number][];
      epsg_presets: EpsgPreset[];
    };

export type Chip = { path: string; x0: number; y0: number; size: number };
export type Candidate = {
  image: string;
  x: number;
  y: number;
  center_dist: number;
  marked: boolean;
  width: number;
  height: number;
  chip?: Chip;
};
export type Prediction = {
  method: "triangulated" | "survey" | "survey_dsm" | "dsm" | null;
  point?: { x: number; y: number; z: number; epsg: number; lon: number; lat: number };
  residuals_px?: Record<string, number | null>;
  candidates: Candidate[];
};
export type PredictSpec = {
  marks: Mark[];
  world?: { x: number; y: number; z: number; epsg: number; z_from_dsm?: boolean };
  chips?: boolean;
};

export type ReprojStats = {
  num_points: number;
  num_observations: number;
  mean_px: number;
  rmse_px: number;
  p95_px: number;
  max_px?: number;
};
export type TiepointStats = {
  source: "base" | "refined";
  summary: ReprojStats;
  histogram: { edges: number[]; counts: number[] };
  threshold_preview: { threshold_px: number; removed_obs: number; removed_ratio: number; rmse_px_after: number }[];
  recommended_px: number;
  worst: {
    id: number;
    error_px: number;
    max_px: number;
    track: number;
    lon: number;
    lat: number;
    z: number;
    manual: string | null;
  }[];
  per_image: { name: string; num_obs: number; rmse_px: number | null }[];
  map_points: [number, number, number, number][];
  deleted_points: number[];
};

export type GcpParse = {
  encoding: string;
  delimiter: string;
  header: string[] | null;
  num_columns: number;
  numeric: boolean[];
  rows: string[][];
  num_rows: number;
  guess: { name: number | null; x: number | null; y: number | null; z: number | null; epsg?: number | null; distance_km?: number | null };
  epsg_presets: EpsgPreset[];
};

export type GcpRow = {
  name: string;
  role: GcpRole;
  num_marks: number;
  num_used: number;
  dx: number | null;
  dy: number | null;
  dz: number | null;
  dxy: number | null;
  d3: number | null;
  reproj_px: number | null;
  marks?: { image: string; reproj_px: number | null }[];
};
export type GcpSummary = {
  count: number;
  rmse_x: number;
  rmse_y: number;
  rmse_z: number;
  rmse_xy: number;
  rmse_3d: number;
} | null;
export type RefineInfo = {
  mode: "gps" | "gcp" | "gcp_shift";
  epsg: number;
  crs_name: string;
  num_control?: number;
  intrinsics_refined?: boolean;
  gps_residual_rms_m?: number;
  shift_m?: number[];
  deleted_points: number;
  filtered_observations: number;
  max_reproj_error_px: number | null;
  manual_tiepoints: { id: string; point_id: number; error_px: number; marks: { image: string; reproj_px: number | null }[] }[];
  before: ReprojStats;
  after: ReprojStats;
  gcps: GcpRow[];
  gcp_summary: { control: GcpSummary; check: GcpSummary };
  timings_s: Record<string, number>;
  warnings: string[];
};

export const startProjectTask = (command: string, orthoDir: string, args?: string[]) =>
  invoke<JobInfo>("start_project_task", { command, orthoDir, args });
export const startGcpParse = (file: string, orthoDir?: string, encoding?: string, delimiter?: string) =>
  invoke<JobInfo>("start_gcp_parse", { file, orthoDir, encoding, delimiter });
export const allowProjectImages = (orthoDir: string) => invoke<string>("allow_project_images", { orthoDir });

// 엔진은 한 번에 작업 하나만 받으므로 짧은 조회 작업은 순서대로 보낸다
let chain: Promise<unknown> = Promise.resolve();
export function queued<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

const quick = <T>(start: () => Promise<JobInfo>) => queued(() => runJob<T>(start, () => undefined));

export const projectInfo = (orthoDir: string) => quick<ProjectInfo>(() => startProjectTask("project-info", orthoDir));
export const tiepointStats = (orthoDir: string) => quick<TiepointStats>(() => startProjectTask("tiepoints", orthoDir));
export const predictPoint = (orthoDir: string, spec: PredictSpec) =>
  quick<Prediction>(() => startProjectTask("predict", orthoDir, ["--spec", JSON.stringify(spec)]));
export const saveEdits = (orthoDir: string, edits: Edits) =>
  quick<Edits>(() => startProjectTask("edits-save", orthoDir, ["--edits", JSON.stringify(edits)]));
export const parseGcpFile = (file: string, orthoDir?: string, encoding?: string, delimiter?: string) =>
  quick<GcpParse>(() => startGcpParse(file, orthoDir, encoding, delimiter));

/** 영상 폴더에 대응하는 결과 폴더: `<상위>/<폴더명>_QuickOrtho/<작업>` (Rust default_output_dir과 같은 규칙) */
export function resultDir(folder: string, task: "preview" | "ortho"): string {
  const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  const trimmed = folder.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const parent = trimmed.slice(0, i);
  const name = trimmed.slice(i + 1);
  return [parent, `${name}_QuickOrtho`, task].join(sep);
}

export const joinPath = (dir: string, name: string) => {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
};

export const STAGE_LABELS: Record<string, string> = {
  scan: "영상 스캔",
  footprints: "촬영 범위 계산",
  quicklook: "간이 모자이크",
  features: "특징점 추출",
  matching: "영상 매칭",
  mapping: "카메라 위치·자세 추정",
  georef: "좌표 정렬",
  dsm: "간이 DSM",
  ortho: "정사투영",
  finalize: "마무리",
  refine: "정밀 보정",
};
