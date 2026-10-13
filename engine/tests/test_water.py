"""수면 처리 단위 테스트 (합성 데이터): 판별, 특징점 마스크, DSM 수면 평면, 설정."""

from pathlib import Path

import cv2
import numpy as np
import pycolmap
import pytest

from quickortho_engine import water
from quickortho_engine.ortho import View, _footprint
from quickortho_engine.surface import Dsm


def _scene(seed=0) -> np.ndarray:
    """1200×800: 왼쪽 60%는 잔잔한 청록 수면, 오른쪽은 풀(노란 기, 거친 질감), 작은 파란 지붕, 질감 있는 그늘."""
    rng = np.random.default_rng(seed)
    h, w = 800, 1200
    img = np.zeros((h, w, 3), np.float32)
    img[:, :720] = (30, 140, 150)
    img[:, :720] += rng.normal(0, 0.6, (h, 720, 1))  # 잔물결 정도의 약한 잡음
    grass = np.array([150, 140, 60], np.float32) + rng.normal(0, 25, (h, 480, 1))
    img[:, 720:] = grass
    img[100:140, 900:940] = (40, 90, 200)  # 작은 파란 지붕 (매끈함)
    img[500:700, 800:1100] = np.array([60, 70, 95], np.float32) + rng.normal(0, 20, (200, 300, 1))  # 그늘진 풀
    return np.clip(img, 0, 255).astype(np.uint8)


def test_classify_finds_smooth_water_not_textured_land():
    m = water.classify(_scene())
    h, w = m.shape
    assert max(h, w) == water.MASK_PX
    left = m[:, : int(w * 0.55)]
    right = m[:, int(w * 0.65):]
    assert (left == water.CONFIDENT).mean() > 0.9
    assert (right > 0).mean() < 0.02  # 풀·그늘·작은 지붕은 수면이 아님


def test_classify_ignores_textured_blue_area():
    """파랗더라도 세밀한 질감이 있으면(예: 파란 방수포 위 물건, 질감 있는 그늘) 수면이 아님."""
    rng = np.random.default_rng(1)
    img = np.clip(np.array([40, 90, 200], np.float32) + rng.normal(0, 20, (600, 900, 1)), 0, 255).astype(np.uint8)
    assert (water.classify(img) > 0).mean() < 0.02


def test_mode_and_auto_decision():
    assert water.normalize_mode(None) == "auto" and water.normalize_mode(" ON ") == "on"
    with pytest.raises(ValueError):
        water.normalize_mode("sea")
    det = water.Detection(masks={}, fraction=0.03, images_with_water=1)
    assert not water.decide("auto", det) and water.decide("on", det) and not water.decide("off", det)
    det.fraction = 0.2
    assert water.decide("auto", det)


def test_feature_masks_keep_shore_and_cover_all_images(tmp_path: Path):
    m = np.zeros((48, 64), np.uint8)
    m[:, :32] = water.CONFIDENT
    n = water.write_feature_masks({"a.jpg": m, "b.jpg": np.zeros_like(m)}, {"a.jpg": (640, 480), "b.jpg": (640, 480)}, tmp_path)
    assert n == 1
    a = cv2.imread(str(tmp_path / "a.jpg.png"), cv2.IMREAD_GRAYSCALE)
    b = cv2.imread(str(tmp_path / "b.jpg.png"), cv2.IMREAD_GRAYSCALE)
    assert a.shape == (480, 640) and b.shape == (480, 640)
    assert a[240, 100] == 0  # 수면 안쪽: 특징점 제외
    assert a[240, 315] == 255  # 물가(경계 바로 안쪽)는 남김
    assert a[240, 500] == 255 and (b == 255).all()
    # 확실한 수면이 없으면 마스크를 쓰지 않음
    assert water.write_feature_masks({"b.jpg": np.zeros_like(m)}, {"b.jpg": (640, 480)}, tmp_path / "none") == 0


def test_masks_roundtrip(tmp_path: Path):
    m = np.zeros((10, 20), np.uint8)
    m[2:5, 3:9] = 1
    m[6:9, 10:18] = 2
    d = tmp_path / "결과" / "w"  # 한글 경로, 하위 폴더 영상
    water.save_masks({"x.jpg": m, "비행1/y.JPG": m}, d)
    back = water.load_masks(d)
    assert sorted(back) == ["x.jpg", "비행1/y.JPG"]
    assert np.array_equal(back["x.jpg"], m) and np.array_equal(back["비행1/y.JPG"], m)


def _view(name: str, cx: float) -> View:
    """(cx, 0, 100)에서 연직으로 내려다보는 200×100 px 영상 (GSD 1 m). 영상 (u, v) = (x - cx + 100, 50 - y)."""
    cam = pycolmap.Camera.create_from_model_name(1, "PINHOLE", 100.0, 200, 100)
    R = np.diag([1.0, -1.0, -1.0])
    C = np.array([cx, 0.0, 100.0])
    fp = _footprint(cam, R, C, 0.0)
    return View(name, cam, R, -R @ C, C, (fp[:, 0].min(), fp[:, 1].min(), fp[:, 0].max(), fp[:, 1].max()))


def _mask_for(cx: float, roof: bool) -> np.ndarray:
    u, v = np.meshgrid(np.arange(200) + 0.5, np.arange(100) + 0.5)
    x, y = u + cx - 100, 50 - v
    m = np.zeros((100, 200), np.uint8)
    m[x < -20] = water.CONFIDENT
    if roof:  # 수면처럼 보이는 청록 지붕 (x 40~70, y -20~20, 높이 25 m)
        m[(x >= 40) & (x <= 70) & (np.abs(y) <= 20)] = water.CANDIDATE
    return m


def test_ground_water_flattens_sea_and_keeps_raised_roof():
    views = [_view("a", -40.0), _view("b", 40.0)]
    masks = {"a": _mask_for(-40.0, True), "b": _mask_for(40.0, True)}
    # DSM: 육지 10 m, 지붕 25 m, 수면은 보간 때문에 육지 쪽 높이(20 m)로 잘못 채워진 상태
    xs = -140 + np.arange(281)
    ys = 50 - np.arange(101)
    X, Y = np.meshgrid(xs, ys)
    z = np.full(X.shape, 10.0, np.float32)
    z[X < -20] = 20.0
    roof = (X >= 40) & (X <= 70) & (np.abs(Y) <= 20)
    z[roof] = 25.0
    dsm = Dsm(z=z, x0=-140.0, y0=50.0, res=1.0, num_points=0)
    # 점: 육지 2 m 간격 (지붕 안쪽 제외), 지붕 가장자리는 1 m 간격 25 m, 수면 안에는 엉뚱한 점 3개
    gx, gy = np.meshgrid(np.arange(-20, 140, 2.0), np.arange(-50, 51, 2.0))
    land = np.column_stack([gx.ravel(), gy.ravel(), np.full(gx.size, 10.0)])
    inside_roof = (land[:, 0] >= 40) & (land[:, 0] <= 70) & (np.abs(land[:, 1]) <= 20)
    land = land[~inside_roof]
    t = np.arange(0, 1, 1 / 140)
    per = np.concatenate([
        np.column_stack([40 + 30 * t[:30], np.full(30, -20.0)]),
        np.column_stack([40 + 30 * t[:30], np.full(30, 20.0)]),
        np.column_stack([np.full(40, 40.0), -20 + 40 * t[:40]]),
        np.column_stack([np.full(40, 70.0), -20 + 40 * t[:40]]),
    ])
    roof_pts = np.column_stack([per, np.full(len(per), 25.0)])
    junk = np.array([[-100, 0, 35.0], [-80, 20, -5.0], [-60, -30, 50.0]])
    pts = np.vstack([land, roof_pts, junk])

    wmask, level, stats = water.ground_water(views, dsm, masks, pts)
    sea = (X < -25) & (X > -115) & (np.abs(Y) < 38)  # 높이 20 m에서 영상 a가 보는 범위 안
    assert wmask[sea].mean() > 0.95
    assert not wmask[roof & (np.abs(X - 55) < 10) & (np.abs(Y) < 10)].any()  # 높은 평면은 수면이 아님
    assert stats["water_components"] == 1
    flat = water.flatten(dsm, wmask, level)
    assert np.allclose(flat.z[sea & wmask], 10.0, atol=0.01)  # 물가 높이로 평면
    assert np.allclose(flat.z[roof & ~wmask], 25.0)  # 지붕 높이 유지
    assert np.allclose(flat.z[(X > -10) & ~roof], 10.0)


def test_render_options_water_by_version():
    from quickortho_engine.pipeline import render_options

    assert render_options({"engine_version": "0.4.2", "render": {}}).water == "off"
    assert render_options({"engine_version": "0.5.0", "render": {"water": "on"}}).water == "on"
    assert render_options({"engine_version": "0.5.0", "render": {}}).water == "off"
