"""좌표계·DSM·정사투영 단위 테스트 (합성 데이터 사용, 실제 드론 영상 불필요)."""

import io
from pathlib import Path

import numpy as np
import pycolmap
import rasterio
from PIL import Image
from pyproj import CRS

from quickortho_engine.geo import UtmProjector, utm_epsg
from quickortho_engine.ortho import View, make_view, render_orthomosaic, _footprint
from quickortho_engine.protocol import Emitter
from quickortho_engine.surface import Dsm, build_dsm, remove_z_outliers


def test_utm_epsg():
    assert utm_epsg(129.0, 35.1) == 32652  # 부산
    assert utm_epsg(126.9, 37.5) == 32652  # 서울
    assert utm_epsg(-81.75, 41.3) == 32617  # 미국 오하이오
    assert utm_epsg(151.2, -33.9) == 32756  # 남반구
    e, n = UtmProjector(129.0, 35.1).forward(np.array([129.0]), np.array([35.1]))
    assert 490_000 < e[0] < 510_000 and 3_880_000 < n[0] < 3_890_000


def test_remove_z_outliers_drops_spike():
    rng = np.random.default_rng(0)
    pts = np.column_stack([rng.uniform(0, 100, 500), rng.uniform(0, 100, 500), rng.normal(10, 0.2, 500)])
    pts[0, 2] = 80.0  # 날아간 점
    kept = remove_z_outliers(pts)
    assert 80.0 not in kept[:, 2]
    assert len(kept) > 450


def test_build_dsm_fills_outside_hull_smoothly():
    rng = np.random.default_rng(1)
    # 가운데 영역에만 점이 있고, 한쪽은 높은 숲(20 m)
    xy = rng.uniform(30, 70, (800, 2))
    z = np.where(xy[:, 0] > 50, 20.0, 0.0)
    dsm = build_dsm(np.column_stack([xy, z]), (0, 0, 100, 100), res=2.0)
    assert not np.isnan(dsm.z).any()
    # 볼록껍질 밖(점이 없는 곳)에서 최근접 채움으로 인한 급격한 단차가 없어야 함
    # (점이 있는 곳의 실제 20 m 단차는 평활화를 줄인 뒤로 그대로 남는 것이 맞음)
    gy, gx = np.gradient(dsm.z, dsm.res)
    xs = np.arange(dsm.z.shape[1]) * dsm.res
    ys = 100 - np.arange(dsm.z.shape[0]) * dsm.res
    X, Y = np.meshgrid(xs, ys)
    outside = (X < 26) | (X > 74) | (Y < 26) | (Y > 74)
    assert np.hypot(gx, gy)[outside].max() < 4.0
    assert 0.0 <= dsm.z.min() and dsm.z.max() <= 20.0


def _nadir_view(tmp_path: Path) -> tuple[View, Path]:
    """(0,0,100)에서 연직으로 내려다보는 카메라와 색 구분 영상을 만든다.

    영상: 위쪽 1/4은 초록(북쪽), 나머지의 왼쪽 절반은 빨강(서쪽), 오른쪽 절반은 파랑(동쪽).
    """
    w, h = 200, 100
    arr = np.zeros((h, w, 3), np.uint8)
    arr[:, : w // 2] = (255, 0, 0)
    arr[:, w // 2 :] = (0, 0, 255)
    arr[: h // 4] = (0, 255, 0)
    img_dir = tmp_path / "imgs"
    img_dir.mkdir()
    Image.fromarray(arr).save(img_dir / "a.png")

    cam = pycolmap.Camera.create_from_model_name(1, "PINHOLE", 100.0, w, h)  # f=100px → GSD 1 m @100 m
    R = np.diag([1.0, -1.0, -1.0])  # 카메라 z축이 아래, 영상 행 방향이 남쪽
    C = np.array([0.0, 0.0, 100.0])
    t = -R @ C
    fp = _footprint(cam, R, C, 0.0)
    bbox = (fp[:, 0].min(), fp[:, 1].min(), fp[:, 0].max(), fp[:, 1].max())
    return View("a.png", cam, R, t, C, bbox), img_dir


def test_footprint_nadir(tmp_path: Path):
    v, _ = _nadir_view(tmp_path)
    xmin, ymin, xmax, ymax = v.bbox
    assert np.allclose([xmin, xmax, ymin, ymax], [-100, 100, -50, 50], atol=1e-6)


def test_render_orthomosaic_orientation(tmp_path: Path):
    view, img_dir = _nadir_view(tmp_path)
    dsm = Dsm(z=np.zeros((3, 3), np.float32), x0=-100, y0=50, res=100, num_points=0)
    out = tmp_path / "o.tif"
    stats = render_orthomosaic(
        [view], dsm, img_dir, out, CRS.from_epsg(32652), gsd=1.0, src_gsd=1.0,
        bounds=(-100, -50, 100, 50), out=Emitter(io.StringIO()), tile=64,
    )
    assert stats["width"] == 200 and stats["height"] == 100
    with rasterio.open(out) as ds:
        a = ds.read()
    rgb = np.moveaxis(a[:3], 0, -1)
    assert (a[3] == 255).mean() > 0.95
    # 북쪽(위) = 초록, 남서 = 빨강, 남동 = 파랑
    assert tuple(rgb[5, 100]) == (0, 255, 0)
    assert tuple(rgb[80, 30]) == (255, 0, 0)
    assert tuple(rgb[80, 170]) == (0, 0, 255)


def test_make_view_limits_oblique_range():
    cam = pycolmap.Camera.create_from_model_name(1, "PINHOLE", 100.0, 200, 100)
    # 60° 기울어진 카메라: 위쪽 광선은 지평선 가까이 뻗음
    ang = np.deg2rad(60)
    Rx = np.array([[1, 0, 0], [0, np.cos(ang), -np.sin(ang)], [0, np.sin(ang), np.cos(ang)]])
    R = Rx @ np.diag([1.0, -1.0, -1.0])
    C = np.array([0.0, 0.0, 100.0])
    v = make_view("x", cam, R, -R @ C, ground_z=0.0, max_range_factor=4.0)
    assert v is not None and np.allclose(v.center, C)
    xmin, ymin, xmax, ymax = v.bbox
    assert max(abs(xmin), abs(xmax), abs(ymin), abs(ymax)) <= 400 + 1e-6


def _solid_view(img_dir: Path, name: str, color, cx: float) -> View:
    """(cx, 0, 100)에서 연직으로 내려다보는 단색 영상 (200×100 px, GSD 1 m)."""
    w, h = 200, 100
    Image.fromarray(np.full((h, w, 3), color, np.uint8)).save(img_dir / name)
    cam = pycolmap.Camera.create_from_model_name(1, "PINHOLE", 100.0, w, h)
    R = np.diag([1.0, -1.0, -1.0])
    C = np.array([cx, 0.0, 100.0])
    fp = _footprint(cam, R, C, 0.0)
    return View(name, cam, R, -R @ C, C, (fp[:, 0].min(), fp[:, 1].min(), fp[:, 0].max(), fp[:, 1].max()))


def test_seamline_picks_one_image_per_pixel(tmp_path: Path):
    """두 영상이 겹치는 곳을 평균하지 않고, 영상 중심에 가까운 쪽 하나로 칠한다 (경계선 근처만 섞음).

    평균하면 영상끼리 조금만 어긋나도 상이 겹쳐 보이므로(이중상), 섞이는 화소는 경계선의 좁은 띠뿐이어야 한다.
    """
    img_dir = tmp_path / "imgs"
    img_dir.mkdir()
    a = _solid_view(img_dir, "a.png", (255, 0, 0), -40.0)  # x -140~60
    b = _solid_view(img_dir, "b.png", (0, 0, 255), 40.0)  # x -60~140
    dsm = Dsm(z=np.zeros((3, 3), np.float32), x0=-200, y0=100, res=200, num_points=0)
    out = tmp_path / "o.tif"
    render_orthomosaic(
        [a, b], dsm, img_dir, out, CRS.from_epsg(32652), gsd=1.0, src_gsd=1.0,
        bounds=(-140, -50, 140, 50), out=Emitter(io.StringIO()), tile=64,
    )
    with rasterio.open(out) as ds:
        img = ds.read()
    red, blue = img[0].astype(int), img[2].astype(int)
    overlap = slice(140 - 60, 140 + 60)  # x -60~60 (두 영상이 겹치는 120 m)
    mixed = (red[:, overlap] > 10) & (blue[:, overlap] > 10)
    assert mixed.mean() < 0.15  # 경계선(x=0) 양쪽 몇 화소만 섞임
    # 경계선은 두 영상 중심의 가운데(x=0): 서쪽은 빨강, 동쪽은 파랑
    assert red[50, 140 - 30] == 255 and blue[50, 140 - 30] == 0
    assert blue[50, 140 + 30] == 255 and red[50, 140 + 30] == 0
