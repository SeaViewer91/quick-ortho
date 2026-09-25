import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { joinPath, predictPoint, type Candidate, type Mark, type Prediction, type PredictSpec } from "../api";
import ImageViewer from "./ImageViewer";

export type MarkTarget = {
  kind: "gcp" | "tie";
  key: string; // GCP 이름 또는 타이포인트 ID
  title: string;
  obs: Mark[];
  world?: PredictSpec["world"];
};

type Props = {
  orthoDir: string;
  imageDir: string;
  images: Record<string, { width: number; height: number; registered: boolean }>;
  target: MarkTarget;
  onChange: (obs: Mark[]) => void;
  onClose: () => void;
};

const METHOD_LABEL: Record<string, string> = {
  triangulated: "표시한 점들로 계산한 위치로 예측함",
  survey: "측량 좌표로 예측함",
  survey_dsm: "측량 좌표(높이는 DSM)로 예측함. GPS 오차만큼 어긋날 수 있음",
  dsm: "표시한 점 1개와 DSM으로 예측함",
};

export default function MarkingPanel({ orthoDir, imageDir, images, target, onChange, onClose }: Props) {
  const [pred, setPred] = useState<Prediction | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const seq = useRef(0);

  // 표시가 바뀔 때마다 다른 사진에서의 위치를 다시 예측한다
  useEffect(() => {
    const n = ++seq.current;
    setLoading(true);
    predictPoint(orthoDir, { marks: target.obs, world: target.obs.length ? undefined : target.world, chips: true })
      .then((p) => {
        if (n !== seq.current) return;
        setPred(p);
        setError(null);
        setSelected((cur) => cur ?? p.candidates.find((c) => !c.marked)?.image ?? p.candidates[0]?.image ?? null);
      })
      .catch((e) => n === seq.current && setError(String(e instanceof Error ? e.message : e)))
      .finally(() => n === seq.current && setLoading(false));
  }, [orthoDir, target.key, target.obs, target.world]);

  useEffect(() => setSelected(null), [target.key]);

  const markOf = (name: string) => target.obs.find((o) => o.image === name);

  // 예측 목록에 없는(예: 예측 밖) 표시 사진도 목록에 넣는다
  const list: Candidate[] = useMemo(() => {
    const c = pred?.candidates ?? [];
    const extra = target.obs
      .filter((o) => !c.some((x) => x.image === o.image))
      .map((o) => ({
        image: o.image,
        x: o.x,
        y: o.y,
        center_dist: 0,
        marked: true,
        width: images[o.image]?.width ?? 0,
        height: images[o.image]?.height ?? 0,
      }));
    return [...extra, ...c];
  }, [pred, target.obs, images]);

  const cur = list.find((c) => c.image === selected) ?? null;
  const curPred = pred?.candidates.find((c) => c.image === selected);
  const curMark = selected ? markOf(selected) : undefined;
  const size = selected ? images[selected] : undefined;

  const setMark = (p: { x: number; y: number }) => {
    if (!selected) return;
    const obs = target.obs.filter((o) => o.image !== selected);
    onChange([...obs, { image: selected, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }]);
  };
  const removeMark = () => selected && onChange(target.obs.filter((o) => o.image !== selected));
  const next = () => {
    const rest = list.filter((c) => !markOf(c.image) && c.image !== selected);
    if (rest.length) setSelected(rest[0].image);
  };

  const resid = (name: string) => pred?.residuals_px?.[name];

  return (
    <div className="marking">
      <div className="marking-head">
        <div>
          <strong>{target.title}</strong>
          <span className="muted small">
            {" "}
            · 표시 {target.obs.length}장{target.obs.length < 2 ? " (2장 이상 필요, 3장 이상 권장)" : ""}
          </span>
          <div className="muted small">
            {loading ? "위치 예측 중" : pred?.method ? METHOD_LABEL[pred.method] : "예측할 수 없음. 사진을 골라 직접 표시함"}
          </div>
        </div>
        <button type="button" className="secondary" onClick={onClose}>
          지도로 돌아가기
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="marking-body">
        <div className="chips">
          {list.length === 0 && !loading && <p className="muted small">이 점이 보이는 사진을 찾지 못함</p>}
          {list.map((c) => {
            const m = markOf(c.image);
            const r = resid(c.image);
            return (
              <button
                type="button"
                key={c.image}
                className={`chip ${c.image === selected ? "active" : ""} ${m ? "done" : ""}`}
                onClick={() => setSelected(c.image)}
              >
                <div className="chip-img">
                  {c.chip ? (
                    <>
                      <img src={convertFileSrc(c.chip.path)} alt="" draggable={false} />
                      <span
                        className="cross predicted"
                        style={{
                          left: `${((c.x - c.chip.x0) / c.chip.size) * 100}%`,
                          top: `${((c.y - c.chip.y0) / c.chip.size) * 100}%`,
                        }}
                      />
                      {m && (
                        <span
                          className="cross marked"
                          style={{
                            left: `${((m.x - c.chip.x0) / c.chip.size) * 100}%`,
                            top: `${((m.y - c.chip.y0) / c.chip.size) * 100}%`,
                          }}
                        />
                      )}
                    </>
                  ) : (
                    <span className="muted small">미리보기 없음</span>
                  )}
                </div>
                <div className="chip-name">
                  {m ? "✓ " : ""}
                  {c.image}
                  {m && r != null && <span className="muted"> · {r.toFixed(1)} px</span>}
                </div>
              </button>
            );
          })}
        </div>
        <div className="marking-viewer">
          {cur && size ? (
            <>
              <ImageViewer
                src={convertFileSrc(joinPath(imageDir, cur.image))}
                width={size.width}
                height={size.height}
                focus={curMark ?? { x: cur.x, y: cur.y }}
                predicted={curPred ? { x: curPred.x, y: curPred.y } : undefined}
                mark={curMark}
                onMark={setMark}
              />
              <div className="viewer-actions">
                <span className="small">
                  <strong>{cur.image}</strong>
                  {curMark ? ` · 표시 (${curMark.x.toFixed(1)}, ${curMark.y.toFixed(1)})` : " · 표시 안 함"}
                </span>
                <span className="spacer" />
                <button type="button" className="secondary" onClick={removeMark} disabled={!curMark}>
                  이 사진 표시 삭제
                </button>
                <button type="button" onClick={next}>
                  다음 사진
                </button>
              </div>
            </>
          ) : (
            <p className="muted marking-hint">왼쪽 목록에서 사진을 고름</p>
          )}
        </div>
      </div>
    </div>
  );
}
