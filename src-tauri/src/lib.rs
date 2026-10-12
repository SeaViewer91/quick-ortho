mod engine;
mod files;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

const MANUAL_URL: &str = "https://github.com/SeaViewer91/quick-ortho/blob/main/docs/MANUAL.md";

/// 앱·실행 환경 정보. 프론트엔드와 Rust 간 IPC 동작 확인 및 진단용.
#[derive(Serialize)]
struct AppInfo {
    name: &'static str,
    version: &'static str,
    os: &'static str,
    arch: &'static str,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: "QuickOrtho",
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

/// 앱에 포함된 HTML 매뉴얼 경로. 설치본은 리소스 폴더, 개발 실행은 `scripts/build_manual.py`로 만든 build/manual.
fn manual_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("manual").join("manual.html");
        if bundled.is_file() {
            return Some(bundled);
        }
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../build/manual/manual.html");
    dev.is_file().then_some(dev)
}

/// 사용 매뉴얼을 기본 브라우저로 연다. 포함된 HTML이 없으면 GitHub 매뉴얼을 연다 ("local" | "web").
#[tauri::command]
fn open_manual<R: Runtime>(app: AppHandle<R>) -> Result<&'static str, String> {
    match manual_path(&app) {
        Some(path) => app
            .opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map(|_| "local")
            .map_err(|e| e.to_string()),
        None => app
            .opener()
            .open_url(MANUAL_URL, None::<&str>)
            .map(|_| "web")
            .map_err(|e| e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(engine::EngineState::default())
        .setup(|app| {
            // 엔진을 미리 띄워 라이브러리 로딩을 앱 시작과 동시에 끝내 둔다
            let handle = app.handle().clone();
            std::thread::spawn(move || engine::warm_up(&handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            open_manual,
            engine::engine_status,
            engine::start_preview,
            engine::start_ortho,
            engine::cancel_engine,
            engine::start_project_task,
            engine::start_gcp_parse,
            files::allow_project_images,
            files::read_png_data_url,
            files::read_result_json,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                engine::shutdown(app);
            }
        });
}
