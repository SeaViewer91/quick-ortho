"""QuickOrtho 처리 엔진."""

__version__ = "0.4.1"

# rasterio를 불러오기 전에 PROJ·GDAL 데이터 경로를 패키지 내장 데이터로 고정한다 (geoenv.py 참고)
from . import geoenv as _geoenv

_geoenv.isolate()
