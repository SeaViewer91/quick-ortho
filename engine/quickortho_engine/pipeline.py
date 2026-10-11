"""fast ortho 파이프라인: 스캔 → SfM → 좌표 정렬 → 간이 DSM → 정사투영 → COG."""

from __future__ import annotations

import json
import math
import os
import shutil
import threading
import time
from dataclasses import dataclass, field, replace
from pathlib import Path

import numpy as np
import psutil
import pycolmap
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

from . import __version__
from . import multispectral as msp
from .color import estimate_gains
from .ms_ortho import (
    band_gsd,
    build_band_sources,
    normalize_captures,
    refine_rig,
    render_ms_orthomosaic,
    write_index_preview,
    write_indices,
    write_rgb_preview,
)
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
    gsd_scale: float = 1.0  # 원본 해상도 그대로 (v0.3.0부터. 이전에는 2.0)
    keep_work: bool = False
    cache_budget_mb: int | None = None  # 원본 영상 캐시 (None: 사용 가능한 메모리의 약 30%)
    color_balance: bool = True  # 영상 간 밝기·색 차이 보정 (심라인 이음매 단차 제거). 다중분광에서는 쓰지 않음
    radiometry: str = "auto"  # 다중분광 반사율 환산: auto, dls+panel, dls, panel, radiance
    ms_normalize: bool = True  # 다중분광 캡처 간 반사율 블록 조정 (타이포인트 기준, 전체 수준은 유지)
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
        ms_ds = None
        image_dir = folder
        sfm_opts = opts.sfm
        if scan.get("multispectral"):
            # 다중분광: 기준 밴드를 8비트 영상으로 바꿔 SfM에 쓰고(project/msref), 정사 단계에서 모든 밴드를 투영함
            ms_ds = msp.scan_multispectral(folder)
            out.stage("scan", "다중분광 기준 밴드 영상 준비")
            image_dir = Project(out_dir).dir / "msref"
            caps = [c for c in ms_ds.flight_captures if ms_ds.ref(c).file in gps]
            names = msp.write_ref_proxies(ms_ds, caps, image_dir)
            gps = {msp.proxy_name(ms_ds.ref(c).file): gps[ms_ds.ref(c).file] for c in caps}
            images = [{"file": n} for n in names]
            sfm_opts = replace(
                opts.sfm,
                camera_model="FULL_OPENCV",
                camera_params=msp.camera_params_string(ms_ds.ref(caps[0])),
                fixed_intrinsics=True,
            )
            if scan["multispectral"]["incomplete_captures"]:
                warnings.append(f"밴드가 빠진 캡처 {scan['multispectral']['incomplete_captures']}개는 제외함")
        if len(images) < 3:
            raise RuntimeError("처리 가능한 영상이 3장 미만임")
        if len(gps) < 3:
            raise RuntimeError("GPS 정보가 있는 영상이 3장 미만이라 좌표를 부여할 수 없음")
        if scan["summary"]["rolling_shutter_warning"]:
            warnings.append("롤링 셔터 카메라(Mavic 2 등) 영상이 포함됨: 고속 비행 시 왜곡 가능")
        if scan["summary"]["oblique"]:
            warnings.append(f"경사 촬영 영상 {scan['summary']['oblique']}장 포함")

        try:
            rec, sfm_stats, geo = _align(
                image_dir, images, gps, work, replace(opts, sfm=sfm_opts), out, timings, warnings,
                ms_source=folder if ms_ds else None,
            )
        finally:
            # SfM 작업 폴더(특징점 DB)는 정렬 결과를 project/에 저장하면 필요 없음. 실패해도 지워 디스크를 비움
            if not opts.keep_work:
                shutil.rmtree(work, ignore_errors=True)

        # 3~5) 간이 DSM → 정사투영 → COG
        products = render_products(rec, image_dir, out_dir, geo.projector.epsg, opts, out, timings, ms_ds=ms_ds)

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


def _align(folder, images, gps, work, opts, out, timings, warnings, ms_source=None):
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
    Project(out_dir).save_meta(
        folder, gps, __version__, render={"gsd_m": opts.gsd_m, "gsd_scale": opts.gsd_scale}, ms_source=ms_source
    )
    (out_dir / "report.json").unlink(missing_ok=True)
    return rec, sfm_stats, geo


def ms_dataset_from_meta(meta: dict) -> "msp.MsDataset | None":
    """보정용 프로젝트가 다중분광이면 원본 밴드 폴더를 다시 읽는다 (정사 단계에서 모든 밴드가 필요)."""
    info = meta.get("multispectral")
    if not info:
        return None
    src = Path(info["source_dir"])
    if not src.is_dir():
        raise RuntimeError(f"다중분광 원본 영상 폴더를 찾을 수 없음: {src}")
    ds = msp.scan_multispectral(src)
    if ds is None:
        raise RuntimeError(f"다중분광 영상을 찾지 못함: {src}")
    return ds


def render_options(meta: dict) -> OrthoOptions:
    """저장된 정사 모자이크 옵션. v0.3.0 이전 프로젝트는 당시 기본값(GSD 2배)이 저장돼 있으므로 원본 해상도(1배)로 바꾼다."""
    render = meta.get("render") or {}
    try:
        ver = tuple(int(x) for x in str(meta.get("engine_version", "0")).split(".")[:3])
    except ValueError:
        ver = (0,)
    scale = render.get("gsd_scale", 1.0) if ver >= (0, 3, 0) else 1.0
    return OrthoOptions(gsd_m=render.get("gsd_m"), gsd_scale=scale)


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
    opts = render_options(meta)
    timings: dict[str, float] = {}
    old_path = proj.ortho_dir / "report.json"
    old = json.loads(old_path.read_text(encoding="utf-8")) if old_path.exists() else {}
    with PeakMemory() as mem:
        products = render_products(
            to_absolute(rec, frame), image_dir, proj.ortho_dir, frame.epsg, opts, out, timings,
            ms_ds=ms_dataset_from_meta(meta),
        )
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
    ms_ds: "msp.MsDataset | None" = None,
) -> dict:
    """투영 좌표(절대값) 재구성으로 간이 DSM, 정사 모자이크(COG), 미리보기를 만든다.

    ms_ds가 있으면 다중분광: 정사 모자이크는 밴드별 반사율(float32), 식생지수 GeoTIFF를 함께 만든다.

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
    if ms_ds is not None:
        factors, radiometry = msp.reflectance_factors(ms_ds, opts.radiometry)
        sources = build_band_sources(views, ms_ds, factors)
        if len(sources) < len(views):
            views = [v for v in views if v.name in sources]
        bgsd = band_gsd(sources, ground_z)
        gsd = opts.gsd_m or bgsd * opts.gsd_scale  # 출력은 다중분광 밴드의 원본 해상도 기준
    vb = np.array([v.bbox for v in views])
    bounds = _snap_bounds((vb[:, 0].min(), vb[:, 1].min(), vb[:, 2].max(), vb[:, 3].max()), gsd)
    area = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1])
    # 점 간격의 절반 격자 (예전 1.5배 격자 + 강한 평활화는 갈대·관목·작은 기복의 높이를 지워 영상 간 어긋남을 키웠음)
    dsm_res = max(0.5, 0.5 * math.sqrt(area / len(pts)))
    dsm = build_dsm(pts, bounds, dsm_res)
    _write_dsm(dsm, out_dir / "dsm.tif", crs)
    timings["dsm_s"] = time.perf_counter() - t0

    if ms_ds is not None:
        t0 = time.perf_counter()
        out.stage("bands", "밴드 정합 미세 조정·캡처 간 반사율 보정")
        # rig 미세 조정은 두 번 반복 (첫 추정이 약간 과하게 나오는 경향이 있어 두 번째에 0.1화소 이내로 수렴)
        rig_corr: dict = {}
        rig_stats: dict = {}
        for it in range(2):
            corr, st = refine_rig(views, sources, ms_ds, dsm, ground_z)
            rig_corr = {i: corr[i] @ rig_corr[i] if i in rig_corr else corr[i] for i in corr}
            sources = build_band_sources(views, ms_ds, factors, rig_corr=rig_corr)
            if it == 0:
                rig_stats = {"captures": st["captures"], "initial": st["bands"]}
        _, st = refine_rig(views, sources, ms_ds, dsm, ground_z, max_captures=4)
        rig_stats["residual"] = st["bands"]
        radiometry["band_alignment"] = rig_stats
        if opts.ms_normalize and radiometry["mode"] != "radiance":
            gains, norm_stats = normalize_captures(rec, views, sources, ms_ds)
            for n, srcs in sources.items():
                for k, src in enumerate(srcs):
                    src.factor *= gains[n][k]
            radiometry["capture_normalization"] = norm_stats
        timings["bands_s"] = time.perf_counter() - t0
        return _render_ms(views, sources, ms_ds, radiometry, dsm, dsm_res, bounds, crs, gsd, src_gsd, bgsd,
                          out_dir, opts, out, timings)

    gains, color_stats = None, None
    if opts.color_balance and len(views) > 1:
        t0 = time.perf_counter()
        out.stage("color", "영상 간 밝기·색 차이 보정")
        gains, color_stats = estimate_gains(views, dsm, image_dir, bounds, src_gsd, out)
        timings["color_s"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    out.stage("ortho", f"정사 모자이크 생성 (GSD {gsd * 100:.1f} cm)")
    tmp = out_dir / "orthomosaic.tmp.tif"
    ortho_stats = render_orthomosaic(
        views, dsm, image_dir, tmp, crs, gsd, src_gsd, bounds, out,
        cache_budget_mb=opts.cache_budget_mb, gains=gains,
    )
    if color_stats:
        ortho_stats["color"] = color_stats
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


def _render_ms(views, sources, ds, radiometry, dsm, dsm_res, bounds, crs, gsd, src_gsd, bgsd, out_dir, opts, out, timings):
    t0 = time.perf_counter()
    names = ds.band_names()
    out.stage("ortho", f"다중분광 정사 모자이크 생성 ({len(names)}밴드, GSD {gsd * 100:.1f} cm)")
    tmp = out_dir / "orthomosaic.tmp.tif"
    ortho_stats = render_ms_orthomosaic(
        views, sources, names, dsm, ds.root, tmp, crs, gsd, src_gsd, bgsd, bounds, out,
        cache_budget_mb=opts.cache_budget_mb,
    )
    timings["ortho_s"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    out.stage("finalize", "COG 변환·식생지수·미리보기 생성")
    final = out_dir / "orthomosaic.tif"
    finalize_cog(tmp, final)
    tmp.unlink(missing_ok=True)
    preview = write_rgb_preview(final, out_dir / "preview.png", names)
    outputs = {"orthomosaic": str(final), "dsm": str(out_dir / "dsm.tif"), "preview": str(out_dir / "preview.png")}
    itmp = out_dir / "indices.tmp.tif"
    index_names = write_indices(final, itmp, names)
    if index_names:
        finalize_cog(itmp, out_dir / "indices.tif")
        write_index_preview(out_dir / "indices.tif", out_dir / "ndvi.png", band=1)
        outputs["indices"] = str(out_dir / "indices.tif")
        outputs["index_preview"] = str(out_dir / "ndvi.png")
    else:
        for p in (out_dir / "indices.tif", out_dir / "ndvi.png"):
            p.unlink(missing_ok=True)
    itmp.unlink(missing_ok=True)
    corners = _corners_lonlat(final)
    timings["finalize_s"] = time.perf_counter() - t0
    any_cap = next(iter(ds.captures.values()))
    return {
        "dsm": {"resolution_m": dsm_res, "num_points": dsm.num_points},
        "ortho": {**ortho_stats, "source_gsd_m": bgsd, "reference_gsd_m": src_gsd},
        "multispectral": {
            "model": ds.model,
            "bands": [{"name": any_cap[i].band, "wavelength_nm": any_cap[i].wavelength} for i in ds.out_indices],
            "reference_band": any_cap[ds.ref_index].band,
            "values": "radiance" if radiometry["mode"] == "radiance" else "reflectance",
            "radiometry": radiometry,
            "indices": index_names,
            **preview,
        },
        "outputs": outputs,
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
