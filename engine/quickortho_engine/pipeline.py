"""fast ortho 파이프라인: 스캔 → SfM → 좌표 정렬 → 간이 DSM → 정사투영 → COG."""

from __future__ import annotations

import json
import math
import os
import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import psutil
import pycolmap
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

from . import __version__
from .ortho import build_views, finalize_cog, native_gsd, render_orthomosaic
from .geo import Projector
from .project import Project, to_absolute
from .protocol import Emitter
from .scan import scan_folder
from .sfm import SfmOptions, run_sfm
from .surface import build_dsm, georeference, remove_z_outliers, sparse_points


@dataclass
class OrthoOptions:
    gsd_m: float | None = None  # 지정하지 않으면 원본 GSD × gsd_scale
    gsd_scale: float = 2.0
    keep_work: bool = False
    cache_budget_mb: int = 600
    sfm: SfmOptions = field(default_factory=SfmOptions)


class PeakMemory:
    """프로세스 RSS를 주기적으로 측정해 최대값을 기록한다 (OS 공통)."""

    def __init__(self, interval: float = 0.5) -> None:
        self._proc = psutil.Process(os.getpid())
        self._interval = interval
        self._stop = threading.Event()
        self.peak = 0
        self._th = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.is_set():
            self.peak = max(self.peak, self._proc.memory_info().rss)
            self._stop.wait(self._interval)

    def __enter__(self) -> "PeakMemory":
        self._th.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._th.join()
        self.peak = max(self.peak, self._proc.memory_info().rss)


def run_ortho(folder: Path, out_dir: Path, opts: OrthoOptions, out: Emitter) -> dict:
    t_start = time.perf_counter()
    folder = Path(folder)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / "work"
    timings: dict[str, float] = {}
    warnings: list[str] = []

    with PeakMemory() as mem:
        # 0) 스캔
        t0 = time.perf_counter()
        scan = scan_folder(folder, emitter=out)
        timings["scan_s"] = time.perf_counter() - t0
        images = [im for im in scan["images"] if im["selected"]]
        gps = {
            im["file"]: (im["lon"], im["lat"], _alt(im))
            for im in images
            if im["lat"] is not None and im["lon"] is not None
        }
        if len(images) < 3:
            raise RuntimeError("처리 가능한 영상이 3장 미만임")
        if len(gps) < 3:
            raise RuntimeError("GPS 정보가 있는 영상이 3장 미만이라 좌표를 부여할 수 없음")
        if scan["summary"]["rolling_shutter_warning"]:
            warnings.append("롤링 셔터 카메라(Mavic 2 등) 영상이 포함됨: 고속 비행 시 왜곡 가능")
        if scan["summary"]["oblique"]:
            warnings.append(f"경사 촬영 영상 {scan['summary']['oblique']}장 포함")

        try:
            rec, sfm_stats, geo = _align(folder, images, gps, work, opts, out, timings, warnings)
        finally:
            # SfM 작업 폴더(특징점 DB)는 정렬 결과를 project/에 저장하면 필요 없음. 실패해도 지워 디스크를 비움
            if not opts.keep_work:
                shutil.rmtree(work, ignore_errors=True)

        # 3~5) 간이 DSM → 정사투영 → COG
        products = render_products(rec, folder, out_dir, geo.projector.epsg, opts, out, timings)

    timings["total_s"] = time.perf_counter() - t_start
    report = {
        "engine_version": __version__,
        "input": {
            "folder": str(folder),
            "total_files": scan["summary"]["total_files"],
            "selected": len(images),
            "with_gps": len(gps),
            "cameras": scan["cameras"],
        },
        "sfm": {k: v for k, v in sfm_stats.items() if not k.startswith("time_")},
        "georef": {
            "epsg": geo.projector.epsg,
            "gps_residual_rms_m": geo.gps_residual_m,
            "num_aligned": geo.num_aligned,
            "note": "절대 위치 정확도는 GNSS 수준(수 m)임. 정밀 위치가 필요하면 GCP 필요",
        },
        **products,
        "timings_s": {k: round(v, 2) for k, v in timings.items()},
        "peak_memory_mb": round(mem.peak / 1024 / 1024, 1),
        "warnings": warnings,
    }
    (out_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    Project(out_dir).save_base_report(report)
    return report


def _align(folder, images, gps, work, opts, out, timings, warnings):
    """SfM → GPS 좌표 정렬 → 보정용 프로젝트 저장. 반환: (재구성(투영 좌표 절대값), SfM 통계, 좌표 정렬 결과)"""
    out_dir = work.parent
    # 1) SfM
    rec, sfm_stats = run_sfm(
        folder, [im["file"] for im in images], work, has_gps=len(gps) >= 3, opts=opts.sfm, out=out
    )
    timings.update(
        features_s=sfm_stats["time_features_s"],
        matching_s=sfm_stats["time_matching_s"],
        mapping_s=sfm_stats["time_mapping_s"],
    )
    if sfm_stats["num_registered"] < len(images):
        warnings.append(
            f"{len(images) - sfm_stats['num_registered']}장은 정합되지 않아 모자이크에서 제외됨"
        )

    # 2) 좌표 정렬
    t0 = time.perf_counter()
    out.stage("georef", "GPS로 좌표 정렬 (UTM)")
    geo = georeference(rec, gps)
    out.log(f"좌표계 EPSG:{geo.projector.epsg}, GPS 잔차(RMS, 수평) {geo.gps_residual_m:.2f} m")
    timings["georef_s"] = time.perf_counter() - t0

    # 보정용 프로젝트 저장 (지역 좌표계). 이전 결과의 보고서는 새 정렬과 맞지 않으므로 지운다.
    # 이후 정사 모자이크 단계에서 실패하면 이 상태(정렬 결과만 있음)에서 run_render로 이어서 만들 수 있다.
    Project(out_dir).save_base(rec, geo.projector.epsg, geo.origin)
    Project(out_dir).save_meta(folder, gps, __version__, render={"gsd_m": opts.gsd_m, "gsd_scale": opts.gsd_scale})
    (out_dir / "report.json").unlink(missing_ok=True)
    return rec, sfm_stats, geo


def align_report_from_project(proj: Project) -> dict:
    """정렬 보고서가 없는 프로젝트(정렬 뒤 정사 모자이크 단계에서 실패한 경우)의 보고서를 재구성에서 다시 만든다.

    정렬 단계의 처리 시간·메모리 등 다시 알 수 없는 값은 비워 두고 경고로 알린다.
    """
    rec, frame = proj.load_base()
    meta = proj.meta()
    gps = {k: tuple(v) for k, v in meta.get("gps", {}).items()}
    names = [im.name for im in rec.images.values() if im.has_pose and im.name in gps]
    residual = None
    if names:
        e, n = Projector(frame.epsg).forward([gps[k][0] for k in names], [gps[k][1] for k in names])
        c = np.array([rec.find_image_with_name(k).projection_center() for k in names]) + frame.origin
        residual = float(np.sqrt(np.mean((c[:, 0] - e) ** 2 + (c[:, 1] - n) ** 2)))
    n_input = max(len(gps), rec.num_images())
    return {
        "engine_version": meta.get("engine_version", __version__),
        "input": {"folder": meta.get("image_dir"), "selected": n_input, "with_gps": len(gps)},
        "sfm": {
            "num_input_images": n_input,
            "num_registered": rec.num_reg_images(),
            "num_points3D": rec.num_points3D(),
            "mean_reprojection_error_px": float(rec.compute_mean_reprojection_error()),
            "mapper": "unknown",
        },
        "georef": {
            "epsg": frame.epsg,
            "gps_residual_rms_m": residual,
            "num_aligned": len(names),
            "note": "절대 위치 정확도는 GNSS 수준(수 m)임. 정밀 위치가 필요하면 GCP 필요",
        },
        "timings_s": {},
        "peak_memory_mb": 0.0,
        "warnings": ["정렬 결과는 이전 실행에서 가져옴 (정사 모자이크 단계에서 중단된 작업). 정렬 단계 처리 시간은 기록되지 않음"],
    }


def run_render(ortho_dir: Path, out: Emitter) -> dict:
    """저장된 정렬 결과(보정했으면 보정 결과)로 DSM·정사 모자이크만 다시 만든다. SfM을 다시 하지 않는다.

    정사 모자이크 단계에서 실패·중단된 작업을 이어서 끝낼 때 쓴다.
    """
    t_start = time.perf_counter()
    proj = Project(ortho_dir)
    proj.require()
    meta = proj.meta()
    image_dir = Path(meta["image_dir"])
    if not image_dir.is_dir():
        raise RuntimeError(f"원본 영상 폴더를 찾을 수 없음: {image_dir}")
    # 실패한 이전 실행(v0.2.0 이하)이 남긴 SfM 작업 폴더. 정렬 결과는 project/에 있으므로 필요 없음 (영상 수백 장이면 수 GB)
    shutil.rmtree(proj.ortho_dir / "work", ignore_errors=True)
    base = proj.base_report()
    if not base:
        base = align_report_from_project(proj)
        proj.save_base_report(base)
    rec, frame, source = proj.load_current()
    render = meta.get("render", {})
    opts = OrthoOptions(gsd_m=render.get("gsd_m"), gsd_scale=render.get("gsd_scale", 2.0))
    timings: dict[str, float] = {}
    old_path = proj.ortho_dir / "report.json"
    old = json.loads(old_path.read_text(encoding="utf-8")) if old_path.exists() else {}
    with PeakMemory() as mem:
        products = render_products(to_absolute(rec, frame), image_dir, proj.ortho_dir, frame.epsg, opts, out, timings)
    timings["total_s"] = time.perf_counter() - t_start
    report = dict(base)
    report.update(products)
    report["engine_version"] = __version__
    report["timings_s"] = {k: round(v, 2) for k, v in timings.items()}
    report["peak_memory_mb"] = round(mem.peak / 1024 / 1024, 1)
    report.pop("refine", None)
    if source == "refined" and "refine" in old:
        report["refine"] = old["refine"]
        report["georef"] = old.get("georef", report.get("georef"))
        report["warnings"] = list(base.get("warnings", [])) + list(old["refine"].get("warnings", []))
    else:
        report["georef"] = {**base.get("georef", {}), "epsg": frame.epsg}
    old_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def render_products(
    rec: pycolmap.Reconstruction,
    image_dir: Path,
    out_dir: Path,
    epsg: int,
    opts: OrthoOptions,
    out: Emitter,
    timings: dict[str, float],
) -> dict:
    """투영 좌표(절대값) 재구성으로 간이 DSM, 정사 모자이크(COG), 미리보기를 만든다.

    반환: 보고서의 dsm, ortho, outputs, preview_corners_lonlat 항목.
    """
    crs = CRS.from_epsg(epsg)
    t0 = time.perf_counter()
    out.stage("dsm", "희소 점군으로 간이 DSM 생성")
    pts = remove_z_outliers(sparse_points(rec))
    if len(pts) < 10:
        raise RuntimeError("DSM 생성 실패: 유효한 3D 점이 너무 적음")
    ground_z = float(np.median(pts[:, 2]))
    views = build_views(rec, ground_z)
    src_gsd = native_gsd(views, ground_z)
    gsd = opts.gsd_m or src_gsd * opts.gsd_scale
    vb = np.array([v.bbox for v in views])
    bounds = _snap_bounds((vb[:, 0].min(), vb[:, 1].min(), vb[:, 2].max(), vb[:, 3].max()), gsd)
    area = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1])
    dsm_res = max(0.5, 1.5 * math.sqrt(area / len(pts)))
    dsm = build_dsm(pts, bounds, dsm_res)
    _write_dsm(dsm, out_dir / "dsm.tif", crs)
    timings["dsm_s"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    out.stage("ortho", f"정사 모자이크 생성 (GSD {gsd * 100:.1f} cm)")
    tmp = out_dir / "orthomosaic.tmp.tif"
    ortho_stats = render_orthomosaic(
        views, dsm, image_dir, tmp, crs, gsd, src_gsd, bounds, out,
        cache_budget_mb=opts.cache_budget_mb,
    )
    timings["ortho_s"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    out.stage("finalize", "COG 변환·미리보기 생성")
    final = out_dir / "orthomosaic.tif"
    finalize_cog(tmp, final)
    tmp.unlink(missing_ok=True)
    _write_preview(final, out_dir / "preview.png")
    corners = _corners_lonlat(final)
    timings["finalize_s"] = time.perf_counter() - t0
    return {
        "dsm": {"resolution_m": dsm_res, "num_points": dsm.num_points},
        "ortho": {**ortho_stats, "source_gsd_m": src_gsd},
        "outputs": {
            "orthomosaic": str(final),
            "dsm": str(out_dir / "dsm.tif"),
            "preview": str(out_dir / "preview.png"),
        },
        "preview_corners_lonlat": corners,
    }


def _alt(im: dict) -> float:
    for key in ("abs_alt", "rel_alt"):
        if im.get(key) is not None:
            return float(im[key])
    return 0.0


def _snap_bounds(b: tuple[float, float, float, float], gsd: float) -> tuple[float, float, float, float]:
    x0 = math.floor(b[0] / gsd) * gsd
    y0 = math.floor(b[1] / gsd) * gsd
    x1 = math.ceil(b[2] / gsd) * gsd
    y1 = math.ceil(b[3] / gsd) * gsd
    return (x0, y0, x1, y1)


def _write_dsm(dsm, path: Path, crs) -> None:
    rows, cols = dsm.z.shape
    # 격자점이 화소 중심이 되도록 반 칸 이동
    transform = from_origin(dsm.x0 - dsm.res / 2, dsm.y0 + dsm.res / 2, dsm.res, dsm.res)
    with rasterio.open(
        path, "w", driver="GTiff", width=cols, height=rows, count=1, dtype="float32",
        crs=crs, transform=transform, compress="deflate",
    ) as ds:
        ds.write(dsm.z, 1)


def _corners_lonlat(path: Path) -> list[list[float]]:
    """래스터 네 모서리(좌상, 우상, 우하, 좌하)의 경위도. 앱 지도 오버레이용."""
    from pyproj import Transformer

    with rasterio.open(path) as ds:
        b = ds.bounds
        tr = Transformer.from_crs(ds.crs.to_epsg(), 4326, always_xy=True)
    xs = [b.left, b.right, b.right, b.left]
    ys = [b.top, b.top, b.bottom, b.bottom]
    lon, lat = tr.transform(xs, ys)
    return [[float(a), float(c)] for a, c in zip(lon, lat)]


def _write_preview(path: Path, png_path: Path, max_size: int = 2048) -> None:
    with rasterio.open(path) as ds:
        scale = min(1.0, max_size / max(ds.width, ds.height))
        w, h = max(1, int(ds.width * scale)), max(1, int(ds.height * scale))
        data = ds.read(out_shape=(4, h, w), resampling=rasterio.enums.Resampling.average)
    from PIL import Image

    Image.fromarray(np.moveaxis(data, 0, -1), "RGBA").save(png_path)
