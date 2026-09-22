"""把实际前端生命周期回归接入默认测试，避免单独脚本漏跑。"""
from pathlib import Path
import subprocess
import pytest


@pytest.mark.parametrize("script", [
    "test_place_pop.mjs",
    "run_place_helpers.mjs",
    "run_layer_stack.mjs",
    "run_thumb_sched.mjs",
    "run_thumb_lifecycle.mjs",
    "run_infer_lifecycle.mjs",
    "run_list_lifecycle.mjs",
    "run_meta_lifecycle.mjs",
    "run_selection_lifecycle.mjs",
    "run_filter_lifecycle.mjs",
    "run_viewer_lifecycle.mjs",
    "run_picker_session.mjs",
    "run_png_strip.mjs",
    "run_paint_helpers.mjs",
    "run_overlay_lifecycle.mjs",
    "run_overlay_copy.mjs",
    "run_fullscreen_layout.mjs",
    "run_overlay_review.mjs",
])
def test_frontend_lifecycle(script):
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", str(root / "tests" / script), str(root / "web" / "mediabrowser.js")],
        capture_output=True, text=True, encoding="utf-8", timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
