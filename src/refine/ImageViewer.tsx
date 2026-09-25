import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Pt = { x: number; y: number };

type Props = {
  src: string;
  width: number;
  height: number;
  /** 처음 보여줄 위치 (사진 좌표). 없으면 사진 전체를 맞춰 보여준다 */
  focus?: Pt;
  predicted?: Pt;
  mark?: Pt;
  onMark: (p: Pt) => void;
};

const MIN_SCALE_FACTOR = 0.5;
const MAX_SCALE = 8;

/**
 * 원본 해상도 사진 보기: 휠로 확대·축소, 끌어서 이동, 클릭으로 점 표시.
 * EXIF 회전은 적용하지 않는다 (SfM이 쓰는 원본 화소 좌표와 맞추기 위해).
 */
export default function ImageViewer({ src, width, height, focus, predicted, mark, onMark }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ s: 1, tx: 0, ty: 0 });
  const [loaded, setLoaded] = useState(false);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);

  const fitScale = () => {
    const el = box.current;
    if (!el) return 1;
    return Math.min(el.clientWidth / width, el.clientHeight / height);
  };

  // 사진이 바뀌면 초점 위치를 1:1로 가운데에 둔다
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (focus) {
      const s = 1;
      setView({ s, tx: el.clientWidth / 2 - focus.x * s, ty: el.clientHeight / 2 - focus.y * s });
    } else {
      const s = fitScale();
      setView({ s, tx: (el.clientWidth - width * s) / 2, ty: (el.clientHeight - height * s) / 2 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => setLoaded(false), [src]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      setView((v) => {
        const k = Math.exp(-e.deltaY * 0.0015);
        const s = Math.min(MAX_SCALE, Math.max(fitScale() * MIN_SCALE_FACTOR, v.s * k));
        const f = s / v.s;
        return { s, tx: cx - (cx - v.tx) * f, ty: cy - (cy - v.ty) * f };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  const toImage = (clientX: number, clientY: number): Pt => {
    const r = box.current!.getBoundingClientRect();
    return { x: (clientX - r.left - view.tx) / view.s, y: (clientY - r.top - view.ty) / view.s };
  };

  const onDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.moved) setView((v) => ({ ...v, tx: d.tx + dx, ty: d.ty + dy }));
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const p = toImage(e.clientX, e.clientY);
    if (p.x >= 0 && p.y >= 0 && p.x < width && p.y < height) onMark(p);
  };

  const zoomTo = (s: number) => {
    const el = box.current;
    if (!el) return;
    const c = mark ?? predicted ?? { x: width / 2, y: height / 2 };
    setView({ s, tx: el.clientWidth / 2 - c.x * s, ty: el.clientHeight / 2 - c.y * s });
  };

  const scr = (p: Pt) => ({ left: p.x * view.s + view.tx, top: p.y * view.s + view.ty });

  return (
    <div className="viewer">
      <div
        ref={box}
        className="viewer-box"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => (drag.current = null)}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={() => setLoaded(true)}
          style={{
            width,
            height,
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`,
            imageRendering: view.s >= 2 ? "pixelated" : "auto",
          }}
        />
        {predicted && <div className="cross predicted" style={scr(predicted)} title="예측 위치" />}
        {mark && <div className="cross marked" style={scr(mark)} title="표시한 위치" />}
        {!loaded && <div className="viewer-loading">사진 불러오는 중</div>}
      </div>
      <div className="viewer-tools">
        <button type="button" className="secondary small-btn" onClick={() => zoomTo(fitScale())}>
          전체
        </button>
        <button type="button" className="secondary small-btn" onClick={() => zoomTo(1)}>
          1:1
        </button>
        <button type="button" className="secondary small-btn" onClick={() => zoomTo(3)}>
          3배
        </button>
        <span className="muted small">휠: 확대·축소 · 끌기: 이동 · 클릭: 점 표시 · 배율 {view.s.toFixed(2)}</span>
      </div>
    </div>
  );
}
