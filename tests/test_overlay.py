"""非破坏式遮蔽的持久化、并发、路径和导出像素契约。"""
import asyncio
import io
import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from PIL import Image
from PIL.PngImagePlugin import PngInfo
from test_mediabrowser import mb


@pytest.fixture
def source(tmp_path, monkeypatch):
    monkeypatch.setattr(mb, "OVERLAY_DIR", str(tmp_path / "layers"))
    monkeypatch.setitem(mb._DIRS, "output", lambda: str(tmp_path))
    path = tmp_path / "source.png"
    image = Image.new("RGB", (48, 32))
    image.putdata([(x * 5, y * 7, (x + y) * 3) for y in range(32) for x in range(48)])
    info = PngInfo()
    info.add_text("workflow", '{"nodes":[1]}')
    info.add_text("prompt", '{"1":{}}')
    image.save(path, pnginfo=info)
    return path


def record(source):
    rec = mb._overlay_read(str(source))
    return {**rec, "expectedRevision": rec["revision"], "ops": [
        {"id": "r1", "k": "r", "x": .1, "y": .1, "w": .5, "h": .5, "block": 8}
    ]}


def test_overlay_save_is_non_destructive_and_clear_persists(source):
    before = source.read_bytes(), source.stat().st_mtime_ns
    saved = mb._overlay_save(str(source), record(source))
    assert saved["revision"] == 1
    assert mb._overlay_read(str(source))["ops"] == saved["ops"]
    cleared = mb._overlay_save(str(source), {**saved, "expectedRevision": 1, "ops": []})
    assert cleared["exists"] and not cleared["ops"]
    assert mb._overlay_read(str(source))["exists"]
    assert (source.read_bytes(), source.stat().st_mtime_ns) == before


def test_overlay_concurrent_save_rejects_lost_update(source):
    body = record(source)
    def save():
        try:
            return mb._overlay_save(str(source), body)["revision"]
        except FileExistsError:
            return "conflict"
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: save(), range(2)))
    assert results.count(1) == results.count("conflict") == 1


def test_overlay_source_replacement_does_not_reuse_old_regions(source):
    old = mb._overlay_save(str(source), record(source))
    Image.new("RGB", (20, 40), "blue").save(source)
    current = mb._overlay_read(str(source))
    assert current["stale"] and not current["exists"] and not current["ops"]
    with pytest.raises(FileExistsError):
        mb._overlay_save(str(source), {**old, "expectedRevision": old["revision"]})


def test_overlay_atomic_failure_keeps_previous_record(source, monkeypatch):
    old = mb._overlay_save(str(source), record(source))
    def fail(*args):
        raise OSError("disk full")
    monkeypatch.setattr(mb.os, "replace", fail)
    with pytest.raises(OSError):
        mb._overlay_save(str(source), {**old, "expectedRevision": 1, "ops": []})
    assert mb._overlay_read(str(source))["ops"] == old["ops"]
    assert not list(source.parent.joinpath("layers").glob("*.tmp"))


def test_overlay_render_pixels_match_both_metadata_modes(source):
    body = {**record(source), "showOverlay": True}
    before = source.read_bytes(), source.stat().st_mtime_ns
    with_meta = mb._render_overlay(str(source), {**body, "keepWorkflow": True})
    without_meta = mb._render_overlay(str(source), {**body, "keepWorkflow": False})
    with Image.open(io.BytesIO(with_meta)) as a, Image.open(io.BytesIO(without_meta)) as b, Image.open(source) as original:
        assert a.size == b.size == original.size
        assert a.tobytes() == b.tobytes()
        assert a.tobytes() != original.convert("RGBA").tobytes()
        assert a.info["workflow"] == '{"nodes":[1]}'
        assert a.info["prompt"] == '{"1":{}}'
        assert not b.info
    assert (source.read_bytes(), source.stat().st_mtime_ns) == before


def test_overlay_peek_and_hidden_render_original_pixels(source):
    body = record(source)
    for flags in ({"showOverlay": False}, {"showOverlay": True, "fullBlur": True, "peeking": True}):
        with Image.open(io.BytesIO(mb._render_overlay(str(source), {**body, **flags}))) as output, Image.open(source) as original:
            assert output.tobytes() == original.convert("RGBA").tobytes()


def test_overlay_stroke_and_full_blur_render(source):
    body = {**record(source), "showOverlay": True, "ops": [{"id":"s", "k":"s", "pts":[[.2,.2],[.8,.8]],"r":.1,"block":12}]}
    a = mb._render_overlay(str(source), body)
    b = mb._render_overlay(str(source), {**body, "fullBlur": True})
    assert a != b


@pytest.mark.parametrize("op", [
    {"id":"x","k":"r","x":float("nan"),"y":0,"w":.5,"h":.5},
    {"id":"x","k":"r","x":.8,"y":0,"w":.5,"h":.5},
    {"id":"x","k":"s","r":.1,"pts":[[0,2]]},
    {"id":"x","k":"s","r":.1,"pts":[[0,0]]*50001},
    {"id":"x","k":"r","x":0,"y":0,"w":1,"h":1,"block":float("inf")},
])
def test_overlay_rejects_invalid_shapes(op):
    with pytest.raises(ValueError):
        mb._overlay_ops([op])


class Request:
    def __init__(self, body):
        self.raw = json.dumps(body).encode()
        self.content_length = len(self.raw)
        self.query = body
    async def read(self):
        return self.raw


def test_overlay_routes_check_boundaries_and_revision(source):
    bad = asyncio.run(mb.mediabrowser_overlay_get(Request({"type":"output","filename":"../private.png"})))
    assert bad.status == 400
    body = {**record(source), "type":"output", "filename":source.name}
    saved = asyncio.run(mb.mediabrowser_overlay_post(Request(body)))
    assert saved.status == 200
    conflict = asyncio.run(mb.mediabrowser_overlay_post(Request(body)))
    assert conflict.status == 409
    rendered = asyncio.run(mb.mediabrowser_render(Request({**body,"showOverlay":True})))
    assert rendered.status == 200 and rendered.content_type == "image/png"
    too_big = Request(body)
    too_big.content_length = 3 * 1024 * 1024
    assert asyncio.run(mb.mediabrowser_overlay_post(too_big)).status == 413

def test_overlay_exif_orientation_matches_browser(source):
    src = source.parent / "rotated.jpg"
    image = Image.new("RGB", (40, 20), "red")
    exif = image.getexif()
    exif[274] = 6
    image.save(src, exif=exif)
    rec = mb._overlay_read(str(src))
    assert (rec["sourceVersion"]["width"], rec["sourceVersion"]["height"]) == (20, 40)
    result = mb._render_overlay(str(src), {**rec, "showOverlay": False})
    with Image.open(io.BytesIO(result)) as output:
        assert output.size == (20, 40)


def test_overlay_preview_does_not_reduce_copy_resolution(source):
    src = source.parent / "large.png"
    Image.new("RGB", (320, 240), "blue").save(src)
    rec = mb._overlay_read(str(src))
    with Image.open(io.BytesIO(mb._render_overlay(str(src), {**rec, "previewMax":64}))) as preview:
        assert preview.size == (64, 48)
    with Image.open(io.BytesIO(mb._render_overlay(str(src), rec))) as exported:
        assert exported.size == (320, 240)


def test_blur_stroke_export_keeps_mask_and_changes_with_strength(source):
    rec = record(source)
    stroke = {"id": "stroke", "k": "s", "pts": [[.3, .5], [.7, .5]], "r": .2,
              "effect": "blur", "strength": 2, "block": 8}
    body = {**rec, "ops": [stroke], "showOverlay": True}
    def pixels(op):
        return Image.open(io.BytesIO(mb._render_overlay(str(source), {**body, "ops": [op]}))).convert("RGB")
    mild = pixels(stroke)
    strong = pixels({**stroke, "strength": 30})
    mosaic = pixels({**stroke, "effect": "mosaic"})
    with Image.open(source) as original:
        assert strong.getpixel((0, 0)) == original.getpixel((0, 0))
    assert mild.tobytes() != strong.tobytes()
    assert strong.tobytes() != mosaic.tobytes()
