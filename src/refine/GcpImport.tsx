import { useEffect, useMemo, useState } from "react";
import { parseGcpFile, type GcpParse } from "../api";

export type ImportedGcp = { name: string; x: number; y: number; z: number; epsg: number };

type Props = {
  file: string;
  orthoDir: string;
  initial: GcpParse;
  onCancel: () => void;
  onImport: (gcps: ImportedGcp[]) => void;
};

type Col = number | null;

const ENCODINGS = [
  ["", "자동"],
  ["utf-8-sig", "UTF-8"],
  ["cp949", "CP949 (한글 윈도우)"],
  ["latin-1", "Latin-1"],
] as const;
const DELIMS = [
  ["", "자동"],
  [",", "쉼표 (,)"],
  ["tab", "탭"],
  [";", "세미콜론 (;)"],
  ["whitespace", "공백"],
] as const;

const num = (s: string | undefined) => (s === undefined || s === "" ? NaN : Number(s.replace(/,/g, "")));

export default function GcpImport({ file, orthoDir, initial, onCancel, onImport }: Props) {
  const [parsed, setParsed] = useState(initial);
  const [encoding, setEncoding] = useState("");
  const [delimiter, setDelimiter] = useState("");
  const [cols, setCols] = useState<{ name: Col; x: Col; y: Col; z: Col }>(pickCols(initial));
  const [epsg, setEpsg] = useState<number>(initial.guess.epsg ?? 5186);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 인코딩·구분자를 바꾸면 다시 읽는다
  useEffect(() => {
    if (!encoding && !delimiter) return;
    parseGcpFile(file, orthoDir, encoding || undefined, delimiter || undefined)
      .then((p) => {
        setParsed(p);
        setCols(pickCols(p));
        setError(null);
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, [file, orthoDir, encoding, delimiter]);

  const headers = useMemo(
    () => Array.from({ length: parsed.num_columns }, (_, i) => parsed.header?.[i] || `열 ${i + 1}`),
    [parsed],
  );

  const gcps: ImportedGcp[] = useMemo(() => {
    if (cols.x === null || cols.y === null) return [];
    const out: ImportedGcp[] = [];
    parsed.rows.forEach((r, k) => {
      const x = num(r[cols.x!]);
      const y = num(r[cols.y!]);
      const z = cols.z === null ? 0 : num(r[cols.z]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      const name = cols.name === null ? `GCP${k + 1}` : (r[cols.name] ?? "").trim() || `GCP${k + 1}`;
      out.push({ name, x, y, z, epsg });
    });
    return out;
  }, [parsed, cols, epsg]);

  const dupNames = gcps.length - new Set(gcps.map((g) => g.name)).size;
  const presetIds = parsed.epsg_presets.map((p) => p.epsg);
  const colSelect = (key: keyof typeof cols, label: string, optional = false) => (
    <label className="field">
      <span>{label}</span>
      <select
        value={cols[key] ?? ""}
        onChange={(e) => setCols((c) => ({ ...c, [key]: e.target.value === "" ? null : Number(e.target.value) }))}
      >
        {optional && <option value="">(없음)</option>}
        {headers.map((h, i) => (
          <option key={i} value={i}>
            {h}
          </option>
        ))}
      </select>
    </label>
  );
  const roleOf = (i: number) =>
    i === cols.name ? "점명" : i === cols.x ? "동(E)·경도" : i === cols.y ? "북(N)·위도" : i === cols.z ? "표고" : "";

  return (
    <div className="modal-back">
      <div className="modal">
        <h2>GCP 측량 성과 불러오기</h2>
        <p className="muted small" title={file}>
          {file.split(/[\\/]/).pop()} · {parsed.num_rows}행 · 인코딩 {parsed.encoding} · 구분자{" "}
          {parsed.delimiter === "whitespace" ? "공백" : parsed.delimiter === "\t" ? "탭" : parsed.delimiter}
        </p>

        <div className="field-row">
          <label className="field">
            <span>인코딩</span>
            <select value={encoding} onChange={(e) => setEncoding(e.target.value)}>
              {ENCODINGS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>구분자</span>
            <select value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
              {DELIMS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="field-row">
          {colSelect("name", "점명", true)}
          {colSelect("x", "동(E)·경도")}
          {colSelect("y", "북(N)·위도")}
          {colSelect("z", "표고", true)}
        </div>
        <p className="muted small">
          국내 측량 성과는 보통 X가 북(N), Y가 동(E)임. 프로젝트 위치와 비교해 순서를 자동으로 골랐으니 확인함.
        </p>

        <div className="field-row">
          <label className="field wide">
            <span>좌표계</span>
            <select
              value={presetIds.includes(epsg) ? epsg : "custom"}
              onChange={(e) => e.target.value !== "custom" && setEpsg(Number(e.target.value))}
            >
              {parsed.epsg_presets.map((p) => (
                <option key={p.epsg} value={p.epsg}>
                  {p.label}
                </option>
              ))}
              <option value="custom">직접 입력</option>
            </select>
          </label>
          <label className="field">
            <span>EPSG 직접 입력</span>
            <input
              value={custom}
              placeholder={String(epsg)}
              onChange={(e) => {
                setCustom(e.target.value);
                const v = Number(e.target.value);
                if (Number.isInteger(v) && v > 1000) setEpsg(v);
              }}
            />
          </label>
        </div>
        {parsed.guess.epsg ? (
          <p className="muted small">
            자동 판단: EPSG:{parsed.guess.epsg} (촬영 지역과 {parsed.guess.distance_km} km)
          </p>
        ) : (
          <p className="warn-text small">좌표계를 자동으로 판단하지 못함. 측량 성과의 좌표계를 직접 고름</p>
        )}

        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                {headers.map((h, i) => (
                  <th key={i}>
                    {h}
                    {roleOf(i) && <div className="role-tag">{roleOf(i)}</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parsed.rows.slice(0, 8).map((r, k) => (
                <tr key={k}>
                  {r.map((c, i) => (
                    <td key={i}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {error && <p className="error-text">{error}</p>}
        {dupNames > 0 && <p className="warn-text small">점명이 중복된 행이 {dupNames}개 있음. 뒤쪽 행이 앞의 값을 덮어씀</p>}
        <div className="modal-actions">
          <span className="muted small">불러올 점 {gcps.length}개 (같은 이름의 기존 GCP는 좌표만 바뀜)</span>
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onCancel}>
            취소
          </button>
          <button type="button" disabled={!gcps.length} onClick={() => onImport(gcps)}>
            불러오기
          </button>
        </div>
      </div>
    </div>
  );
}

function pickCols(p: GcpParse) {
  return { name: p.guess.name, x: p.guess.x, y: p.guess.y, z: p.guess.z };
}
