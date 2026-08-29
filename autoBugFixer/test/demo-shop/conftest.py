"""pytest 路径引导：无需安装包即可运行（把 src 加入 sys.path）。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))
