//! 엔진 결과 파일 읽기. 보안을 위해 `*_QuickOrtho` 결과 폴더 안의 파일만 허용한다.

use std::path::{Component, Path};

use base64::Engine as _;

fn ensure_result_path(path: &Path, allowed_ext: &[&str]) -> Result<(), String> {
    let in_result_dir = path.components().any(|c| match c {
        Component::Normal(s) => s.to_string_lossy().ends_with("_QuickOrtho"),
        _ => false,
    });
    if !in_result_dir || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("결과 폴더 밖의 파일은 읽을 수 없음".into());
    }
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
