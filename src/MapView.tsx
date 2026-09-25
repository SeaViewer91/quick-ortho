import type { FeatureCollection } from "geojson";
import { useEffect, useRef } from "react";
import maplibregl, { type GeoJSONSource, type ImageSource, type Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Corners } from "./api";

export type Overlay = { url: string; corners: Corners };

export type Layers = {
  quicklook: boolean;
  coverage: boolean;
  footprints: boolean;
  gaps: boolean;
  ortho: boolean;
};

type Props = {
  quicklook?: Overlay;
  coverage?: Overlay;
  ortho?: Overlay;
  geojson?: FeatureCollection;
  layers: Layers;
};

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

// 오프라인 동작이 기본이므로 배경지도 타일 없이 단색 배경만 사용한다
const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#dfe3e8" } }],
};

const IMAGE_LAYERS = [
  ["quicklook", "quicklook"],
  ["ortho", "ortho"],
  ["coverage", "coverage"],
] as const;

export default function MapView({ quicklook, coverage, ortho, geojson, layers }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const ready = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      center: [127.8, 36.0],
      zoom: 6,
      attributionControl: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    m.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    ready.current = new Promise((resolve) => m.on("load", () => resolve()));
    ready.current.then(() => {
      m.addSource("vectors", { type: "geojson", data: EMPTY });
      m.addLayer({
        id: "footprints",
        type: "line",
        source: "vectors",
        filter: ["==", ["get", "kind"], "footprint"],
        paint: { "line-color": "#1f6feb", "line-width": 1, "line-opacity": 0.7 },
      });
      m.addLayer({
        id: "cameras",
        type: "circle",
        source: "vectors",
        filter: ["==", ["get", "kind"], "camera"],
        paint: { "circle-radius": 3, "circle-color": "#1f6feb", "circle-stroke-color": "#fff", "circle-stroke-width": 1 },
      });
      m.addLayer({
        id: "gaps-fill",
        type: "fill",
        source: "vectors",
        filter: ["==", ["get", "kind"], "gap"],
        paint: { "fill-color": "#8c3cc8", "fill-opacity": 0.55 },
      });
      m.addLayer({
        id: "gaps-line",
        type: "line",
        source: "vectors",
        filter: ["==", ["get", "kind"], "gap"],
        paint: { "line-color": "#5a1e8c", "line-width": 2 },
      });
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // 영상 오버레이 (간이 모자이크, 정사 모자이크, 중복도)
  useEffect(() => {
    const overlays = { quicklook, ortho, coverage };
    ready.current?.then(() => {
      const m = map.current;
      if (!m) return;
      for (const [key, id] of IMAGE_LAYERS) {
        const ov = overlays[key];
        const src = m.getSource(id) as ImageSource | undefined;
        if (!ov) {
          if (m.getLayer(id)) m.removeLayer(id);
          if (src) m.removeSource(id);
          continue;
        }
        if (src) {
          src.updateImage({ url: ov.url, coordinates: ov.corners });
        } else {
          m.addSource(id, { type: "image", url: ov.url, coordinates: ov.corners });
          // 벡터 레이어 아래에 영상을 둔다
          m.addLayer(
            { id, type: "raster", source: id, paint: { "raster-fade-duration": 0, "raster-opacity": key === "coverage" ? 0.75 : 1 } },
            "footprints",
          );
        }
      }
      const fit = ortho ?? quicklook ?? coverage;
      if (fit) {
        const lons = fit.corners.map((c) => c[0]);
        const lats = fit.corners.map((c) => c[1]);
        m.fitBounds(
          [
            [Math.min(...lons), Math.min(...lats)],
            [Math.max(...lons), Math.max(...lats)],
          ],
          { padding: 40, duration: 0 },
        );
      }
    });
  }, [quicklook, ortho, coverage]);

  useEffect(() => {
    ready.current?.then(() => {
      (map.current?.getSource("vectors") as GeoJSONSource | undefined)?.setData(geojson ?? EMPTY);
    });
  }, [geojson]);

  useEffect(() => {
    ready.current?.then(() => {
      const m = map.current;
      if (!m) return;
      const vis = (on: boolean) => (on ? "visible" : "none");
      const set = (id: string, on: boolean) => m.getLayer(id) && m.setLayoutProperty(id, "visibility", vis(on));
      set("quicklook", layers.quicklook);
      set("ortho", layers.ortho);
      set("coverage", layers.coverage);
      set("footprints", layers.footprints);
      set("cameras", layers.footprints);
      set("gaps-fill", layers.gaps);
      set("gaps-line", layers.gaps);
    });
  }, [layers, quicklook, ortho, coverage]);

  return <div ref={container} className="map" />;
}
