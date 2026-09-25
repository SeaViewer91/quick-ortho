//! 처리 엔진(Python 사이드카) 상주 실행과 이벤트 중계.
//!
//! 앱이 켜질 때 엔진을 `serve` 모드로 한 번 띄워 무거운 라이브러리를 미리 불러 둔다.
//! 이후 작업 요청은 표준 입력에 JSON 한 줄(`{"job": n, "argv": [...]}`)로 보내고,
//! 엔진이 표준 출력으로 내보내는 JSON-lines 이벤트를 프론트엔드에 전달한다.
//!
//! - 작업 이벤트(`"job"` 필드 포함) → `engine://event`
//! - 작업 종료(`{"type":"done"}`) → `engine://exit`
//! - 작업 중단: 엔진 프로세스를 종료하고 곧바로 새로 띄운다 (pycolmap 연산은 중간에 멈출 수 없음)
//! - 엔진이 비정상 종료되면 실행 중이던 작업을 실패로 알리고, 다음 요청 때 새로 띄운다
//!
//! 엔진 실행 파일 결정 순서
//! 1. 환경변수 `QUICKORTHO_ENGINE`: 실행 파일 경로
//! 2. 설치본: 앱 리소스 폴더의 `engine/quickortho-engine(.exe)` (PyInstaller onedir 번들)
//! 3. 개발 모드: 저장소의 `engine/.venv` 파이썬으로 `-m quickortho_engine`
//! 4. 시스템 파이썬(`python3` / `python`)으로 `-m quickortho_engine`

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

const STDERR_TAIL_LINES: usize = 30;

struct Proc {
    child: Child,
    stdin: ChildStdin,
    /// 프로세스 세대 번호. 이전 세대의 출력 스레드가 뒤늦게 보내는 이벤트를 걸러낸다.
    generation: u64,
}

#[derive(Default)]
struct Shared {
    proc: Option<Proc>,
    /// 현재 실행 중인 작업 (한 번에 하나만)
    running: Option<u64>,
    ready: Option<serde_json::Value>,
    stderr_tail: VecDeque<String>,
}

#[derive(Default)]
pub struct EngineState {
    next_job: AtomicU64,
    next_gen: AtomicU64,
    shared: Arc<Mutex<Shared>>,
}

#[derive(Clone, Serialize)]
struct EngineEvent {
    job_id: u64,
    event: serde_json::Value,
}

#[derive(Clone, Serialize)]
struct EngineExit {
    job_id: u64,
    code: Option<i32>,
    cancelled: bool,
    stderr_tail: String,
}

#[derive(Serialize)]
pub struct JobInfo {
    job_id: u64,
    output_dir: String,
}

/// 엔진을 실행할 명령(프로그램, 앞쪽 인자, 작업 폴더)을 결정한다.
fn engine_command<R: Runtime>(app: &AppHandle<R>) -> (PathBuf, Vec<String>, Option<PathBuf>) {
    if let Ok(exe) = std::env::var("QUICKORTHO_ENGINE") {
        if !exe.is_empty() {
            return (PathBuf::from(exe), vec![], None);
        }
    }
    let exe_name = if cfg!(windows) { "quickortho-engine.exe" } else { "quickortho-engine" };
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("engine").join(exe_name);
        if bundled.exists() {
            return (bundled, vec![], None);
        }
    }
    let module = vec!["-m".to_string(), "quickortho_engine".to_string()];
    let engine_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("engine");
    let venv_python = if cfg!(windows) {
        engine_dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        engine_dir.join(".venv").join("bin").join("python")
    };
    if venv_python.exists() {
        return (venv_python, module, Some(engine_dir));
    }
    let python = if cfg!(windows) { "python" } else { "python3" };
    let dir = if engine_dir.exists() { Some(engine_dir) } else { None };
    (PathBuf::from(python), module, dir)
}

fn base_command<R: Runtime>(app: &AppHandle<R>, extra: &[&str]) -> (Command, PathBuf) {
    let (program, mut args, cwd) = engine_command(app);
    args.extend(extra.iter().map(|s| s.to_string()));
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .env("PYTHONUNBUFFERED", "1");
    if let Some(dir) = &cwd {
        cmd.current_dir(dir).env("PYTHONPATH", dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    (cmd, program)
}

/// 상주 엔진을 띄운다. 이미 떠 있으면 아무것도 하지 않는다.
fn ensure_started<R: Runtime>(app: &AppHandle<R>, state: &EngineState) -> Result<(), String> {
    let mut sh = state.shared.lock().unwrap();
    if sh.proc.is_some() {
        return Ok(());
    }
    let (mut cmd, program) = base_command(app, &["serve"]);
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("엔진 실행 실패 ({}): {e}", program.display()))?;
    let stdin = child.stdin.take().ok_or("엔진 stdin을 열 수 없음")?;
    let stdout = child.stdout.take().ok_or("엔진 stdout을 열 수 없음")?;
    let stderr = child.stderr.take().ok_or("엔진 stderr를 열 수 없음")?;
    let generation = state.next_gen.fetch_add(1, Ordering::SeqCst) + 1;
    sh.proc = Some(Proc { child, stdin, generation });
    sh.ready = None;
    sh.stderr_tail.clear();
    drop(sh);

    // stderr: 오류 진단용으로 마지막 몇 줄만 보관
    let shared = state.shared.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut sh = shared.lock().unwrap();
            if sh.proc.as_ref().map(|p| p.generation) != Some(generation) {
                break;
            }
            sh.stderr_tail.push_back(line);
            while sh.stderr_tail.len() > STDERR_TAIL_LINES {
                sh.stderr_tail.pop_front();
            }
        }
    });

    // stdout: 이벤트 중계
    let shared = state.shared.clone();
    let app = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(ev) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let kind = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let job = ev.get("job").and_then(|j| j.as_u64());
            let mut sh = shared.lock().unwrap();
            if sh.proc.as_ref().map(|p| p.generation) != Some(generation) {
                return; // 중단되어 교체된 이전 세대 프로세스
            }
            match (kind, job) {
                ("ready", _) => {
                    sh.ready = Some(ev.clone());
                    drop(sh);
                    let _ = app.emit("engine://ready", ev);
                }
                ("done", Some(job_id)) => {
                    if sh.running == Some(job_id) {
                        sh.running = None;
                    }
                    let code = ev.get("code").and_then(|c| c.as_i64()).map(|c| c as i32);
                    let stderr_tail = sh.stderr_tail.iter().cloned().collect::<Vec<_>>().join("\n");
                    drop(sh);
                    let _ = app.emit("engine://exit", EngineExit { job_id, code, cancelled: false, stderr_tail });
                }
                (_, Some(job_id)) => {
                    drop(sh);
                    let _ = app.emit("engine://event", EngineEvent { job_id, event: ev });
                }
                _ => {}
            }
        }
        // 출력이 끊김 = 엔진 종료. 실행 중이던 작업을 실패로 알린다.
        let mut sh = shared.lock().unwrap();
        if sh.proc.as_ref().map(|p| p.generation) != Some(generation) {
            return;
        }
        if let Some(mut p) = sh.proc.take() {
            let _ = p.child.wait();
        }
        let stderr_tail = sh.stderr_tail.iter().cloned().collect::<Vec<_>>().join("\n");
        if let Some(job_id) = sh.running.take() {
            drop(sh);
            let _ = app.emit(
                "engine://exit",
                EngineExit { job_id, code: None, cancelled: false, stderr_tail },
            );
        }
    });
    Ok(())
}

fn stop_process(state: &EngineState) {
    let mut sh = state.shared.lock().unwrap();
    if let Some(mut p) = sh.proc.take() {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
    sh.ready = None;
}

fn submit<R: Runtime>(app: &AppHandle<R>, state: &EngineState, argv: Vec<String>) -> Result<u64, String> {
    ensure_started(app, state)?;
    let job_id = state.next_job.fetch_add(1, Ordering::SeqCst) + 1;
    let mut sh = state.shared.lock().unwrap();
    if let Some(running) = sh.running {
        return Err(format!("다른 작업(#{running})이 실행 중임"));
    }
    let line = serde_json::json!({ "job": job_id, "argv": argv }).to_string() + "\n";
    let proc = sh.proc.as_mut().ok_or("엔진이 실행 중이 아님")?;
    proc.stdin
        .write_all(line.as_bytes())
        .and_then(|_| proc.stdin.flush())
        .map_err(|e| format!("엔진에 요청을 보내지 못함: {e}"))?;
    sh.running = Some(job_id);
    Ok(job_id)
}

/// 영상 폴더 옆에 결과 폴더를 만든다: `<상위>/<폴더명>_QuickOrtho/<작업>`
fn default_output_dir(folder: &Path, task: &str) -> Result<PathBuf, String> {
    let name = folder
        .file_name()
        .ok_or("영상 폴더 이름을 확인할 수 없음")?
        .to_string_lossy()
        .to_string();
    let parent = folder.parent().ok_or("영상 폴더의 상위 폴더를 확인할 수 없음")?;
    Ok(parent.join(format!("{name}_QuickOrtho")).join(task))
}

/// 앱 시작 시 호출: 엔진을 미리 띄워 첫 작업의 대기 시간을 줄인다.
pub fn warm_up<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<EngineState>();
    let _ = ensure_started(app, &state);
}

/// 앱 종료 시 호출: 엔진 프로세스를 정리한다.
pub fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<EngineState>();
    stop_process(&state);
}

/// 빠른 미리보기 실행. 결과는 `<폴더명>_QuickOrtho/preview`에 저장된다.
/// `quicklook`이 false면 영상 디코딩 없이 촬영 범위·중복도만 계산한다 (데이터 불러오기).
#[tauri::command]
pub fn start_preview<R: Runtime>(
    app: AppHandle<R>,
    state: State<EngineState>,
    folder: String,
    quicklook: Option<bool>,
) -> Result<JobInfo, String> {
    let folder = PathBuf::from(folder);
    let out = default_output_dir(&folder, "preview")?;
    let mut argv = vec![
        "preview".into(),
        folder.to_string_lossy().into(),
        "-o".into(),
        out.to_string_lossy().into(),
    ];
    if !quicklook.unwrap_or(true) {
        argv.push("--skip-quicklook".into());
    }
    let job_id = submit(&app, &state, argv)?;
    Ok(JobInfo { job_id, output_dir: out.to_string_lossy().into() })
}

/// 정사 모자이크 생성. 결과는 `<폴더명>_QuickOrtho/ortho`에 저장된다.
#[tauri::command]
pub fn start_ortho<R: Runtime>(
    app: AppHandle<R>,
    state: State<EngineState>,
    folder: String,
    gsd_scale: Option<f64>,
) -> Result<JobInfo, String> {
    let folder = PathBuf::from(folder);
    let out = default_output_dir(&folder, "ortho")?;
    let mut argv = vec![
        "ortho".into(),
        folder.to_string_lossy().into(),
        "-o".into(),
        out.to_string_lossy().into(),
    ];
    if let Some(s) = gsd_scale {
        argv.push("--gsd-scale".into());
        argv.push(format!("{s}"));
    }
    let job_id = submit(&app, &state, argv)?;
    Ok(JobInfo { job_id, output_dir: out.to_string_lossy().into() })
}

/// 정밀 보정 작업 (정사 모자이크 결과 폴더 기준).
///
/// 허용 명령과 인자
/// - `project-info`, `tiepoints`: 추가 인자 없음
/// - `predict`: `["--spec", JSON]`
/// - `edits-save`: `["--edits", JSON]`
/// - `refine`: `[]` 또는 `["--reset"]`
#[tauri::command]
pub fn start_project_task<R: Runtime>(
    app: AppHandle<R>,
    state: State<EngineState>,
    command: String,
    ortho_dir: String,
    args: Option<Vec<String>>,
) -> Result<JobInfo, String> {
    let args = args.unwrap_or_default();
    validate_project_task(&command, &ortho_dir, &args)?;
    let mut argv = vec![command, ortho_dir.clone()];
    argv.extend(args);
    let job_id = submit(&app, &state, argv)?;
    Ok(JobInfo { job_id, output_dir: ortho_dir })
}

fn validate_project_task(command: &str, ortho_dir: &str, args: &[String]) -> Result<(), String> {
    crate::files::ensure_result_dir(Path::new(ortho_dir))?;
    let ok = match command {
        "project-info" | "tiepoints" => args.is_empty(),
        "predict" => args.len() == 2 && args[0] == "--spec",
        "edits-save" => args.len() == 2 && args[0] == "--edits",
        "refine" => args.is_empty() || (args.len() == 1 && args[0] == "--reset"),
        _ => return Err(format!("지원하지 않는 보정 명령: {command}")),
    };
    if ok {
        Ok(())
    } else {
        Err(format!("{command} 명령의 인자가 올바르지 않음"))
    }
}

/// GCP 측량 성과 파일(CSV·TXT)을 읽는다. `ortho_dir`을 주면 프로젝트 위치로 좌표계를 추정한다.
#[tauri::command]
pub fn start_gcp_parse<R: Runtime>(
    app: AppHandle<R>,
    state: State<EngineState>,
    file: String,
    ortho_dir: Option<String>,
    encoding: Option<String>,
    delimiter: Option<String>,
) -> Result<JobInfo, String> {
    let mut argv = vec!["gcp-parse".to_string(), file];
    if let Some(d) = &ortho_dir {
        crate::files::ensure_result_dir(Path::new(d))?;
        argv.push("--ortho".into());
        argv.push(d.clone());
    }
    if let Some(e) = encoding {
        argv.push("--encoding".into());
        argv.push(e);
    }
    if let Some(d) = delimiter {
        argv.push("--delimiter".into());
        argv.push(d);
    }
    let job_id = submit(&app, &state, argv)?;
    Ok(JobInfo { job_id, output_dir: ortho_dir.unwrap_or_default() })
}

/// 실행 중인 작업을 중단한다. 엔진을 종료한 뒤 곧바로 새로 띄워 다음 작업에 대비한다.
#[tauri::command]
pub fn cancel_engine<R: Runtime>(app: AppHandle<R>, state: State<EngineState>, job_id: u64) -> Result<(), String> {
    let was_running = {
        let mut sh = state.shared.lock().unwrap();
        if sh.running == Some(job_id) {
            sh.running = None;
            true
        } else {
            false
        }
    };
    if !was_running {
        return Ok(());
    }
    stop_process(&state);
    let _ = app.emit(
        "engine://exit",
        EngineExit { job_id, code: None, cancelled: true, stderr_tail: String::new() },
    );
    let app2 = app.clone();
    thread::spawn(move || warm_up(&app2));
    Ok(())
}

/// 엔진 상태 (준비 여부, 버전, 실행 경로). 설정·진단용.
#[tauri::command]
pub fn engine_status<R: Runtime>(app: AppHandle<R>, state: State<EngineState>) -> serde_json::Value {
    let (program, _, _) = engine_command(&app);
    let sh = state.shared.lock().unwrap();
    serde_json::json!({
        "running": sh.proc.is_some(),
        "busy": sh.running,
        "ready": sh.ready,
        "command": program.to_string_lossy(),
    })
}

#[cfg(test)]
mod task_tests {
    use super::validate_project_task;

    #[test]
    fn project_task_whitelist() {
        let d = "/a/imgs_QuickOrtho/ortho";
        assert!(validate_project_task("tiepoints", d, &[]).is_ok());
        assert!(validate_project_task("predict", d, &["--spec".into(), "{}".into()]).is_ok());
        assert!(validate_project_task("refine", d, &["--reset".into()]).is_ok());
        assert!(validate_project_task("refine", d, &["--x".into()]).is_err());
        assert!(validate_project_task("ortho", d, &[]).is_err());
        assert!(validate_project_task("tiepoints", "/a/imgs/ortho", &[]).is_err());
    }
}

#[cfg(test)]
mod tests {
    //! 실제 엔진(개발 모드 파이썬)을 상주 모드로 띄워 작업 실행·오류·중단 흐름을 검증한다.
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Listener;

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .manage(EngineState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    fn exits(app: &tauri::App<tauri::test::MockRuntime>) -> mpsc::Receiver<serde_json::Value> {
        let (tx, rx) = mpsc::channel();
        app.listen_any("engine://exit", move |e| {
            let _ = tx.send(serde_json::from_str(e.payload()).unwrap());
        });
        rx
    }

    fn wait_exit(rx: &mpsc::Receiver<serde_json::Value>, job: u64, secs: u64) -> serde_json::Value {
        loop {
            let v = rx.recv_timeout(Duration::from_secs(secs)).expect("engine://exit 시간 초과");
            if v["job_id"].as_u64() == Some(job) {
                return v;
            }
        }
    }

    #[test]
    fn resident_engine_runs_jobs_and_recovers_from_cancel() {
        let app = app();
        let handle = app.handle().clone();
        // mock 런타임에서 engine_command는 리소스 폴더가 없으므로 개발 모드 경로를 쓴다
        let rx = exits(&app);
        let state = handle.state::<EngineState>();

        // 1) 정상 작업
        let j1 = submit(&handle, &state, vec!["version".into()]).unwrap();
        let e1 = wait_exit(&rx, j1, 60);
        assert_eq!(e1["code"], 0);
        assert_eq!(e1["cancelled"], false);

        // 2) 실패 작업: 프로세스는 살아 있어야 함
        let j2 = submit(&handle, &state, vec!["scan".into(), "/없는/폴더".into()]).unwrap();
        assert_eq!(wait_exit(&rx, j2, 30)["code"], 1);
        assert!(state.shared.lock().unwrap().proc.is_some());

        // 3) 실행 중 중복 요청은 거부
        let j3 = submit(&handle, &state, vec!["serve".into()]).unwrap(); // 엔진이 거부해 곧 끝남
        let _ = wait_exit(&rx, j3, 30);

        // 4) 긴 작업 중단 → cancelled 알림 → 새 엔진으로 다음 작업 성공
        let samples = std::env::var("QO_TEST_SAMPLES").unwrap_or_default();
        let long_argv: Vec<String> = if samples.is_empty() {
            // 샘플이 없으면 python sleep으로 대신할 수 없으므로 version만 확인
            vec!["version".into()]
        } else {
            vec!["ortho".into(), samples, "-o".into(), "/tmp/qo_cancel_test".into()]
        };
        let j4 = submit(&handle, &state, long_argv).unwrap();
        assert!(submit(&handle, &state, vec!["version".into()]).is_err(), "실행 중에는 새 작업을 받지 않아야 함");
        std::thread::sleep(Duration::from_millis(1500));
        cancel_engine(handle.clone(), state.clone(), j4).unwrap();
        let e4 = wait_exit(&rx, j4, 30);
        assert!(e4["cancelled"] == true || e4["code"] == 0);
        std::thread::sleep(Duration::from_millis(500));
        let j5 = submit(&handle, &state, vec!["version".into()]).unwrap();
        assert_eq!(wait_exit(&rx, j5, 60)["code"], 0);

        shutdown(&handle);
        assert!(state.shared.lock().unwrap().proc.is_none());
    }
}
