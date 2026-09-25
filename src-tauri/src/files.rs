//! 엔진 결과 파일 읽기. 보안을 위해 `*_QuickOrtho` 결과 폴더 안의 파일만 허용한다.

use std::path::{Component, Path};

use base64::Engine as _;

/// `*_QuickOrtho` 결과 폴더(또는 그 하위)인지 확인한다. `..`는 허용하지 않는다.
pub fn ensure_result_dir(path: &Path) -> Result<(), String> {
    let in_result_dir = path.components().any(|c| match c {
        Component::Normal(s) => s.to_string_lossy().ends_with("_QuickOrtho"),
        _ => false,
    });
    if !in_result_dir || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("결과 폴더 밖의 파일은 읽을 수 없음".into());
    }
    Ok(())
}

fn ensure_result_path(path: &Path, allowed_ext: &[&str]) -> Result<(), String> {
    ensure_result_dir(path)?;
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !allowed_ext.contains(&ext.as_str()) {
        return Err(format!("허용되지 않는 파일 형식: .{ext}"));
    }
    Ok(())
}

/// PNG 결과(간이 모자이크, 중복도 지도, 정사영상 미리보기)를 data URL로 읽는다.
#[tauri::command]
pub fn read_png_data_url(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    ensure_result_path(p, &["png"])?;
    let bytes = std::fs::read(p).map_err(|e| format!("파일 읽기 실패: {e}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// JSON/GeoJSON 결과를 읽는다.
#[tauri::command]
pub fn read_result_json(path: String) -> Result<serde_json::Value, String> {
    let p = Path::new(&path);
    ensure_result_path(p, &["json", "geojson"])?;
    let text = std::fs::read_to_string(p).map_err(|e| format!("파일 읽기 실패: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("JSON 해석 실패: {e}"))
}

/// 정밀 보정 화면에서 원본 사진과 사진 조각을 볼 수 있도록 asset 프로토콜 범위에 추가한다.
/// 원본 사진 폴더는 결과 폴더의 `project/meta.json`에 기록된 경로만 허용한다.
/// 반환: 원본 사진 폴더 경로
#[tauri::command]
pub fn allow_project_images<R: tauri::Runtime>(app: tauri::AppHandle<R>, ortho_dir: String) -> Result<String, String> {
    use tauri::Manager;
    let dir = Path::new(&ortho_dir);
    ensure_result_dir(dir)?;
    let meta = std::fs::read_to_string(dir.join("project").join("meta.json"))
        .map_err(|_| "보정용 프로젝트가 없음. 정사 모자이크를 다시 생성해야 함".to_string())?;
    let meta: serde_json::Value = serde_json::from_str(&meta).map_err(|e| format!("meta.json 해석 실패: {e}"))?;
    let image_dir = meta["image_dir"].as_str().ok_or("meta.json에 image_dir가 없음")?.to_string();
    // 사진 조각 캐시는 엔진이 나중에 만들 수 있으므로 미리 만들어 두고 허용한다
    let cache = dir.join("project").join("cache");
    std::fs::create_dir_all(&cache).map_err(|e| format!("캐시 폴더 생성 실패: {e}"))?;
    let scope = app.asset_protocol_scope();
    scope
        .allow_directory(&image_dir, false)
        .and_then(|_| scope.allow_directory(&cache, false))
        .map_err(|e| format!("사진 접근 허용 실패: {e}"))?;
    Ok(image_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_result_dir() {
        assert!(ensure_result_path(Path::new("/a/imgs_QuickOrtho/preview/quicklook.png"), &["png"]).is_ok());
        assert!(ensure_result_path(Path::new("/a/imgs/quicklook.png"), &["png"]).is_err());
        assert!(ensure_result_path(Path::new("/a/x_QuickOrtho/../../etc/p.png"), &["png"]).is_err());
        assert!(ensure_result_path(Path::new("/a/x_QuickOrtho/preview/a.tif"), &["png"]).is_err());
    }
}
