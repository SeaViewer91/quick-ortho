//! 처리 엔진(Python 사이드카) 실행과 이벤트 중계.
//!
//! 엔진은 stdout으로 JSON-lines 이벤트를 출력한다. 각 줄을 파싱해 프론트엔드에
//! `engine://event` 이벤트로 전달하고, 종료 시 `engine://exit` 이벤트를 보낸다.
//!
//! 엔진 실행 파일 결정 순서
//! 1. 환경변수 `QUICKORTHO_ENGINE`: 실행 파일 경로 (배포용 사이드카 또는 임의 경로)
//! 2. 개발 모드: 저장소의 `engine/.venv` 파이썬으로 `-m quickortho_engine` 실행
//! 3. 시스템 파이썬(`python3` / `python`)으로 `-m quickortho_engine` 실행

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct EngineState {
    next_id: AtomicU64,
    jobs: Arc<Mutex<HashMap<u64, Child>>>,
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
fn engine_command() -> (PathBuf, Vec<String>, Option<PathBuf>) {
    if let Ok(exe) = std::env::var("QUICKORTHO_ENGINE") {
        if !exe.is_empty() {
            return (PathBuf::from(exe), vec![], None);
        }
    }
    let module = vec!["-m".to_string(), "quickortho_engine".to_string()];
    // 개발 모드: src-tauri/../engine
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

fn spawn_job(
    app: AppHandle,
    state: &EngineState,
    args: Vec<String>,
) -> Result<u64, String> {
    let (program, mut full_args, cwd) = engine_command();
    full_args.extend(args);

    let mut cmd = Command::new(&program);
    cmd.args(&full_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("엔진 실행 실패 ({}): {e}", program.display()))?;
    let stdout = child.stdout.take().ok_or("엔진 stdout을 열 수 없음")?;
    let stderr = child.stderr.take().ok_or("엔진 stderr를 열 수 없음")?;

    let job_id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    state.jobs.lock().unwrap().insert(job_id, child);

    // stderr는 오류 진단용으로 마지막 부분만 보관
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    let stderr_buf2 = stderr_buf.clone();
    let stderr_thread = thread::spawn(move || {
        let mut s = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut s);
        let tail: String = s.lines().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        *stderr_buf2.lock().unwrap() = tail;
    });

    let jobs = state.jobs.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let event = serde_json::from_str::<serde_json::Value>(line)
                .unwrap_or_else(|_| serde_json::json!({"type": "log", "level": "debug", "message": line}));
            let _ = app.emit("engine://event", EngineEvent { job_id, event });
        }
        let _ = stderr_thread.join();
        // 취소된 작업은 cancel_engine에서 이미 목록에서 제거됨
        let child = jobs.lock().unwrap().remove(&job_id);
        let (code, cancelled) = match child {
            Some(mut c) => (c.wait().ok().and_then(|s| s.code()), false),
            None => (None, true),
        };
        let stderr_tail = stderr_buf.lock().unwrap().clone();
        let _ = app.emit("engine://exit", EngineExit { job_id, code, cancelled, stderr_tail });
    });
    Ok(job_id)
}

/// 빠른 미리보기 실행. 결과는 `<폴더명>_QuickOrtho/preview`에 저장된다.
/// `quicklook`이 false면 영상 디코딩 없이 촬영 범위·중복도만 계산한다 (데이터 불러오기).
#[tauri::command]
pub fn start_preview(
    app: AppHandle,
    state: State<EngineState>,
    folder: String,
    quicklook: Option<bool>,
) -> Result<JobInfo, String> {
    let folder = PathBuf::from(folder);
    let out = default_output_dir(&folder, "preview")?;
    let mut args = vec![
        "preview".into(),
        folder.to_string_lossy().into(),
        "-o".into(),
        out.to_string_lossy().into(),
    ];
    if !quicklook.unwrap_or(true) {
        args.push("--skip-quicklook".into());
    }
    let job_id = spawn_job(app, &state, args)?;
    Ok(JobInfo { job_id, output_dir: out.to_string_lossy().into() })
}

/// 정사 모자이크 생성. 결과는 `<폴더명>_QuickOrtho/ortho`에 저장된다.
#[tauri::command]
pub fn start_ortho(
    app: AppHandle,
    state: State<EngineState>,
    folder: String,
    gsd_scale: Option<f64>,
) -> Result<JobInfo, String> {
    let folder = PathBuf::from(folder);
    let out = default_output_dir(&folder, "ortho")?;
    let mut args = vec![
        "ortho".into(),
        folder.to_string_lossy().into(),
        "-o".into(),
        out.to_string_lossy().into(),
    ];
    if let Some(s) = gsd_scale {
        args.push("--gsd-scale".into());
        args.push(format!("{s}"));
    }
    let job_id = spawn_job(app, &state, args)?;
    Ok(JobInfo { job_id, output_dir: out.to_string_lossy().into() })
}

/// 실행 중인 작업을 중단한다.
#[tauri::command]
pub fn cancel_engine(state: State<EngineState>, job_id: u64) -> Result<(), String> {
    if let Some(mut child) = state.jobs.lock().unwrap().remove(&job_id) {
        child.kill().map_err(|e| format!("작업 중단 실패: {e}"))?;
        let _ = child.wait();
    }
    Ok(())
}

/// 엔진 버전과 실행 환경 확인 (설정·진단용).
#[tauri::command]
pub fn engine_info() -> Result<serde_json::Value, String> {
    let (program, mut args, cwd) = engine_command();
    args.push("version".into());
    let mut cmd = Command::new(&program);
    cmd.args(&args).env("PYTHONIOENCODING", "utf-8");
    if let Some(dir) = &cwd {
        cmd.current_dir(dir).env("PYTHONPATH", dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("엔진 실행 실패 ({}): {e}", program.display()))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let last = text.lines().last().unwrap_or("");
    let mut v: serde_json::Value =
        serde_json::from_str(last).map_err(|_| format!("엔진 응답을 해석할 수 없음: {text}"))?;
    v["command"] = serde_json::json!(program.to_string_lossy());
    Ok(v)
}
