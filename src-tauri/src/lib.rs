mod engine;
mod files;

use serde::Serialize;

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
