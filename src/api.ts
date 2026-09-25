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
  georef: { epsg: number; gps_residual_rms_m: number };
  ortho: { width: number; height: number; gsd_m: number };
  outputs: { orthomosaic: string; dsm: string; preview: string };
  preview_corners_lonlat: Corners;
  timings_s: { total_s: number };
  peak_memory_mb: number;
  warnings: string[];
};

export type AppInfo = { name: string; version: string; os: string; arch: string };

export const appInfo = () => invoke<AppInfo>("app_info");
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
};
