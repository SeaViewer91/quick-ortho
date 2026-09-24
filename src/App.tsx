import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type AppInfo = {
  name: string;
  version: string;
  os: string;
  arch: string;
};

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<AppInfo>("app_info")
      .then(setInfo)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>QuickOrtho</h1>
        <span className="subtitle">드론 영상 정사 모자이크</span>
      </header>

      <main className="app-main">
        <section className="panel">
          <h2>작업</h2>
          <p className="muted">
            영상 폴더 선택, 빠른 미리보기, 모자이크 생성 기능은 다음 단계(M2~M3)에서 추가 예정임.
          </p>
          <button type="button" disabled>
            영상 폴더 선택
          </button>
        </section>

        <section className="panel map-placeholder">
          <p className="muted">지도 뷰어 영역</p>
        </section>
      </main>

      <footer className="app-footer">
        {info && (
          <span>
            {info.name} v{info.version} · {info.os}/{info.arch}
          </span>
        )}
        {error && <span className="error">IPC 오류: {error}</span>}
      </footer>
    </div>
  );
}

export default App;
