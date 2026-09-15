"""预览局部遮蔽：本机 ONNX 检测框，不写遮蔽图、不 import nudenet/ultralytics。

冷启动不 load session。第一次 detect() 才加载；闲置 10 分钟卸。
同步重活由调用方丢进 _POOL。
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import urllib.request
import uuid

from PIL import Image, ImageOps

INPUT_SIZE = 640
# GitHub 常下到登录/警告页 HTML，所以默认走镜像，并校验体积和 SHA256。
WEIGHT_URL = "https://huggingface.co/zhangsongbo365/nudenet_onnx/resolve/main/640m.onnx"
WEIGHT_URL_GITHUB = "https://github.com/notAI-tech/NudeNet/releases/download/v3.4-weights/640m.onnx"
WEIGHT_URLS = (WEIGHT_URL, WEIGHT_URL_GITHUB)
RELEASE_URL = "https://github.com/notAI-tech/NudeNet/releases/tag/v3.4-weights"
WEIGHT_NAME = "640m.onnx"
# 640m 约 98.7MB；半截文件或网页远小于此
WEIGHT_MIN_BYTES = 80_000_000
# HuggingFace 上该 640m.onnx 公布的 SHA256（与约 98.7MB 官方档一致）
WEIGHT_SHA256 = "5fd488c39acfb268efb4a92bce4fbc95967c059bd7ee1c01026fcaf81aec5c9e"
_DL_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
IDLE_SEC = 600
CACHE_FLOOR = 0.15
NMS_IOU = 0.45
ORT_THREADS = 2

LABELS = [
    "FEMALE_GENITALIA_COVERED",
    "FACE_FEMALE",
    "BUTTOCKS_EXPOSED",
    "FEMALE_BREAST_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_BREAST_EXPOSED",
    "ANUS_EXPOSED",
    "FEET_EXPOSED",
    "BELLY_COVERED",
    "FEET_COVERED",
    "ARMPITS_COVERED",
    "ARMPITS_EXPOSED",
    "FACE_MALE",
    "BELLY_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
    "ANUS_COVERED",
    "FEMALE_BREAST_COVERED",
    "BUTTOCKS_COVERED",
]

DEFAULT_BLUR = frozenset({
    "BUTTOCKS_EXPOSED",
    "FEMALE_BREAST_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_BREAST_EXPOSED",
    "ANUS_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
})

_ROOT = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(_ROOT, "_models")
REGIONS_DIR = os.path.join(_ROOT, "_regions")

_session = None
_session_path = None
_session_size = 0
_inferring = 0
_idle_timer: threading.Timer | None = None
_lock = threading.Lock()
_run_lock = threading.Lock()   # ORT session.run 必须串行
_dl_lock = threading.Lock()    # download_start 决策（含 SHA）必须串行
_ort_once: list = []           # [module] 或 [None]，避免在事件环上反复 import
_dl = {"on": False, "progress": 0.0, "error": None, "cancel": False, "cancelled": False}


class DownloadCancelled(Exception):
    """用户点了取消。不是失败。"""


def _ensure_dirs() -> None:
    os.makedirs(MODELS_DIR, exist_ok=True)
    os.makedirs(REGIONS_DIR, exist_ok=True)


def cache_key(abs_path: str, mtime_ns: int, size: int, model_id: str, weight_size: int) -> str:
    raw = f"{os.path.normcase(os.path.abspath(abs_path))}|{mtime_ns}|{size}|{model_id}|{weight_size}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _iou(a: tuple, b: tuple) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1 = max(ax, bx), max(ay, by)
    x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def nms(boxes: list, scores: list, iou_thr: float = NMS_IOU) -> list[int]:
    order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
    keep: list[int] = []
    while order:
        i = order.pop(0)
        keep.append(i)
        order = [j for j in order if _iou(boxes[i], boxes[j]) < iou_thr]
    return keep


def yolo_to_rel(cx, cy, w, h, orig_w, orig_h, model, x_pad, y_pad) -> dict:
    """对齐 NudeNet：letterbox 像素 → 原图相对坐标 0–1。"""
    x = (cx - w / 2) * (orig_w + x_pad) / model
    y = (cy - h / 2) * (orig_h + y_pad) / model
    bw = w * (orig_w + x_pad) / model
    bh = h * (orig_h + y_pad) / model
    x = max(0.0, min(x, float(orig_w)))
    y = max(0.0, min(y, float(orig_h)))
    bw = min(bw, float(orig_w) - x)
    bh = min(bh, float(orig_h) - y)
    return {
        "x": x / orig_w if orig_w else 0,
        "y": y / orig_h if orig_h else 0,
        "w": bw / orig_w if orig_w else 0,
        "h": bh / orig_h if orig_h else 0,
    }


def letterbox_meta(orig_w: int, orig_h: int) -> tuple[int, int]:
    """NudeNet：pad 右、下到 max(w,h)，不居中。"""
    max_size = max(orig_w, orig_h)
    return max_size - orig_w, max_size - orig_h


def _ort_mod():
    if _ort_once:
        return _ort_once[0]
    try:
        import onnxruntime as ort  # noqa: PLC0415
        _ort_once.append(ort)
    except Exception:
        _ort_once.append(None)
    return _ort_once[0]


def _settings_path() -> str:
    _ensure_dirs()
    return os.path.join(MODELS_DIR, "settings.json")


def load_settings() -> dict:
    try:
        with open(_settings_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_settings(data: dict) -> None:
    _ensure_dirs()
    tmp = _settings_path() + f".{uuid.uuid4().hex}.part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, _settings_path())


def model_id_of(path: str | None) -> str:
    if not path:
        return "nudenet-640m"
    name = os.path.basename(path).lower()
    if "640" in name:
        return "nudenet-640m"
    if "320" in name:
        return "nudenet-320n"
    return f"custom-{name}"


def _resolve_onnx_path(raw: str) -> str:
    raw = (raw or "").strip().strip('"')
    if not raw:
        raise ValueError("空路径")
    if not raw.lower().endswith(".onnx"):
        raise ValueError("只接受 .onnx")
    if os.path.isabs(raw):
        path = raw
    else:
        path = os.path.join(MODELS_DIR, os.path.basename(raw))
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        raise ValueError("文件不存在")
    return path


def current_onnx() -> str | None:
    s = load_settings()
    p = s.get("onnx")
    if isinstance(p, str) and os.path.isfile(p):
        return p
    default = os.path.join(MODELS_DIR, WEIGHT_NAME)
    if os.path.isfile(default):
        return default
    return None


def set_onnx_path(path: str) -> dict:
    resolved = _resolve_onnx_path(path)
    mid = model_id_of(resolved)
    save_settings({**load_settings(), "onnx": resolved, "model_id": mid})
    # 换权重必须换 session，旧缓存靠 model_id+size 自然错开
    if _session_path and os.path.normcase(_session_path) != os.path.normcase(resolved):
        shutdown()
    return {"onnx": resolved, "model_id": mid}


def _cache_path(key: str) -> str:
    _ensure_dirs()
    return os.path.join(REGIONS_DIR, key + ".json")


def read_cached(key: str) -> dict | None:
    p = _cache_path(key)
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and "boxes" in data:
            return data
    except Exception:
        pass
    return None


# 检测结果缓存的容量上限。一条 json 通常几百字节到几 KB，
# 20000 条约 20~60MB —— 到这个量级还不痛，但它只增不减：
# 每检测一张图就多一条，删掉原图也不会带走它。缩略图缓存有
# _THUMB_MAX_FILES 自动修剪，这里原来没有，只能在设置里手动清。
_REGIONS_MAX_FILES = 20000
# 每写这么多次才修剪一次。scandir 整个目录不便宜，不必每次都做。
_REGIONS_TRIM_EVERY = 500
_regions_tick = 0


def _trim_regions_cache() -> None:
    """超出上限就按最后访问时间淘汰最旧的一批，一次砍到九成。

    砍到九成而不是刚好卡线：卡线的话之后每写一条都会触发一次修剪。
    顺手收掉超过一小时的 .part 孤儿（进程被杀或写入失败留下的）。
    """
    global _regions_tick
    _regions_tick += 1
    # 第一次也跑，把上次残留的孤儿收掉
    if _regions_tick != 1 and _regions_tick % _REGIONS_TRIM_EVERY != 0:
        return
    try:
        ents = []
        for e in os.scandir(REGIONS_DIR):
            if not e.is_file():
                continue
            if ".part" in e.name:
                try:
                    if time.time() - e.stat().st_mtime > 3600:
                        os.remove(e.path)
                except OSError:
                    pass
                continue
            if e.name.endswith(".json"):
                ents.append(e)
    except OSError:
        return
    if len(ents) <= _REGIONS_MAX_FILES:
        return
    try:
        ents.sort(key=lambda e: e.stat().st_atime)
    except OSError:
        return
    for e in ents[: len(ents) - int(_REGIONS_MAX_FILES * 0.9)]:
        try:
            os.remove(e.path)
        except OSError:
            pass


def write_cached(key: str, payload: dict) -> None:
    _ensure_dirs()
    dst = _cache_path(key)
    tmp = dst + f".{uuid.uuid4().hex}.part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    try:
        os.replace(tmp, dst)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return
    _trim_regions_cache()


def _arm_idle() -> None:
    global _idle_timer
    if _idle_timer is not None:
        _idle_timer.cancel()
    _idle_timer = threading.Timer(IDLE_SEC, _maybe_unload)
    _idle_timer.daemon = True
    _idle_timer.start()


def _maybe_unload() -> None:
    with _lock:
        if _inferring:
            _arm_idle()
            return
        shutdown()


def shutdown() -> None:
    global _session, _session_path, _session_size, _idle_timer
    _session = None
    _session_path = None
    _session_size = 0
    if _idle_timer is not None:
        _idle_timer.cancel()
        _idle_timer = None


def _load_session(onnx: str):
    global _session, _session_path, _session_size
    with _lock:
        if _session is not None and _session_path == onnx:
            return _session
        ort = _ort_mod()
        if ort is None:
            raise RuntimeError("no_runtime")
        so = ort.SessionOptions()
        so.intra_op_num_threads = ORT_THREADS
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        sess = ort.InferenceSession(onnx, so, providers=["CPUExecutionProvider"])
        _session = sess
        _session_path = onnx
        try:
            _session_size = os.path.getsize(onnx)
        except OSError:
            _session_size = 0
        return sess


def _input_size(session, onnx: str) -> int:
    try:
        n = session.get_inputs()[0].shape[2]
        if isinstance(n, int) and n >= 32:
            return n
    except Exception:
        pass
    return 320 if "320" in os.path.basename(onnx) else INPUT_SIZE


def _video_frame(src: str, ffmpeg: str | None) -> Image.Image:
    if not ffmpeg:
        raise RuntimeError("没有 ffmpeg，抽不出视频封面")
    import subprocess
    tmp = os.path.join(REGIONS_DIR, f"frame-{uuid.uuid4().hex}.jpg")
    _ensure_dirs()
    last = ""
    for ss in ("00:00:01", "00:00:00"):
        cmd = [ffmpeg, "-v", "error", "-threads", "1",
               "-ss", ss, "-i", src, "-frames:v", "1", "-y", tmp]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=25)
        except Exception as e:
            last = str(e)
            continue
        if os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
            try:
                return Image.open(tmp).convert("RGB")
            finally:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        last = (r.stderr or b"").decode("utf-8", "ignore")[-200:]
    try:
        os.remove(tmp)
    except OSError:
        pass
    raise RuntimeError(f"抽封面失败: {last or '未知'}")


def _prepare_blob(im: Image.Image, size: int):
    import numpy as np
    im = ImageOps.exif_transpose(im.convert("RGB"))
    orig_w, orig_h = im.size
    x_pad, y_pad = letterbox_meta(orig_w, orig_h)
    max_size = max(orig_w, orig_h)
    canvas = Image.new("RGB", (max_size, max_size), (0, 0, 0))
    canvas.paste(im, (0, 0))
    canvas = canvas.resize((size, size), Image.Resampling.BILINEAR)
    arr = np.asarray(canvas, dtype=np.float32) / 255.0
    blob = arr.transpose(2, 0, 1)[None, ...]
    return blob, orig_w, orig_h, x_pad, y_pad


def parse_yolo(output, orig_w, orig_h, x_pad, y_pad, model: int) -> list:
    import numpy as np
    arr = output[0] if isinstance(output, (list, tuple)) else output
    arr = np.squeeze(arr)
    if arr.ndim != 2:
        return []
    # (22, A) → (A, 22)
    if arr.shape[0] == 4 + len(LABELS):
        arr = arr.T
    boxes, scores, labels = [], [], []
    for row in arr:
        cls = row[4:]
        score = float(cls.max())
        if score < CACHE_FLOOR:
            continue
        cid = int(cls.argmax())
        cx, cy, w, h = (float(row[0]), float(row[1]), float(row[2]), float(row[3]))
        rel = yolo_to_rel(cx, cy, w, h, orig_w, orig_h, model, x_pad, y_pad)
        if rel["w"] <= 0 or rel["h"] <= 0:
            continue
        boxes.append((rel["x"], rel["y"], rel["w"], rel["h"]))
        scores.append(score)
        labels.append(LABELS[cid] if 0 <= cid < len(LABELS) else str(cid))
    keep = nms(boxes, scores, NMS_IOU)
    out = []
    for i in keep:
        x, y, w, h = boxes[i]
        out.append({"x": x, "y": y, "w": w, "h": h, "label": labels[i], "score": float(scores[i])})
    return out


def _infer(abs_path: str, *, video: bool, ffmpeg: str | None, onnx: str) -> list:
    global _inferring
    sess = _load_session(onnx)
    size = _input_size(sess, onnx)
    if video:
        im = _video_frame(abs_path, ffmpeg)
    else:
        im = Image.open(abs_path)
    try:
        blob, orig_w, orig_h, x_pad, y_pad = _prepare_blob(im, size)
    finally:
        if hasattr(im, "close"):
            try:
                im.close()
            except Exception:
                pass
    name = sess.get_inputs()[0].name
    # 关弹层再点「未打」可能两条 _POOL 任务打同一份 session。
    # ORT InferenceSession.run 不是线程安全的，必须串行。
    with _run_lock:
        with _lock:
            _inferring += 1
        try:
            outputs = sess.run(None, {name: blob})
        finally:
            with _lock:
                _inferring -= 1
            _arm_idle()
    return parse_yolo(outputs, orig_w, orig_h, x_pad, y_pad, size)


def detect_file(abs_path: str, *, infer: bool = True, video: bool = False,
                ffmpeg: str | None = None, force: bool = False) -> dict:
    onnx = current_onnx()
    mid = model_id_of(onnx)
    try:
        wsize = os.path.getsize(onnx) if onnx else 0
    except OSError:
        wsize = 0
    st = os.stat(abs_path)
    key = cache_key(abs_path, st.st_mtime_ns, st.st_size, mid, wsize)
    hit = None if force else read_cached(key)
    if hit is not None:
        return hit
    if not infer:
        return {"model_id": mid, "boxes": None, "reason": "no_cache"}
    if _ort_mod() is None:
        return {"model_id": mid, "boxes": None, "reason": "no_runtime"}
    if not onnx:
        return {"model_id": mid, "boxes": None, "reason": "no_weights"}
    try:
        boxes = _infer(abs_path, video=video, ffmpeg=ffmpeg, onnx=onnx)
    except Exception as e:
        return {"model_id": mid, "boxes": None, "reason": "failed", "error": str(e)[:200]}
    payload = {"model_id": mid, "boxes": boxes}
    write_cached(key, payload)
    return payload


def recommended_path() -> str:
    return os.path.join(MODELS_DIR, WEIGHT_NAME)


def recommended_present() -> bool:
    """盘上有够大的 640m。不做 SHA，给状态轮询用。"""
    path = recommended_path()
    try:
        return os.path.isfile(path) and os.path.getsize(path) >= WEIGHT_MIN_BYTES
    except OSError:
        return False


def recommended_ready() -> bool:
    if not recommended_present():
        return False
    try:
        return file_sha256(recommended_path()) == WEIGHT_SHA256
    except OSError:
        return False


def download_start(force: bool = False) -> dict:
    with _dl_lock:
        if _dl["on"]:
            return {"started": False, "already": True, "downloading": True}
        if not force and recommended_ready():
            return {"started": False, "already": True, "has_recommended": True}
        _dl.update(on=True, progress=0.0, error=None, cancel=False, cancelled=False)
    threading.Thread(target=_download_worker, daemon=True, name="mb-censor-dl").start()
    return {"started": True}


def download_cancel() -> None:
    _dl["cancel"] = True


def _finish_download(*, cancelled: bool = False, error: str | None = None) -> None:
    if cancelled:
        _dl["error"] = None
        _dl["cancelled"] = True
    else:
        _dl["error"] = error
        _dl["cancelled"] = False
    _dl["on"] = False


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def looks_like_html(head: bytes, content_type: str = "") -> bool:
    ct = (content_type or "").lower()
    if "text/html" in ct:
        return True
    s = (head or b"").lstrip()[:80].lower()
    return s.startswith(b"<!doctype") or s.startswith(b"<html") or b"github.com/login" in s


def _download_one(url: str, part: str) -> int:
    req = urllib.request.Request(url, headers={"User-Agent": _DL_UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        ctype = resp.headers.get("Content-Type") or ""
        total = int(resp.headers.get("Content-Length") or 0)
        first = resp.read(256 * 1024)
        if not first:
            raise RuntimeError("服务器没返回内容")
        if looks_like_html(first, ctype):
            raise RuntimeError(
                "下到的是网页（登录页或内容警告），不是模型。"
                "请再点下载（会改走镜像），或用浏览器打开发布页后手动下载 640m.onnx，填到下面的路径"
            )
        got = 0
        with open(part, "wb") as f:
            f.write(first)
            got += len(first)
            _dl["progress"] = (got / total) if total else 0.0
            while True:
                if _dl["cancel"]:
                    raise DownloadCancelled()
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                _dl["progress"] = (got / total) if total else 0.0
        if total and got != total:
            raise RuntimeError(f"下载长度对不上（得到 {got}，声明 {total}）")
        if got < WEIGHT_MIN_BYTES:
            raise RuntimeError(
                f"只下到了 {got} 字节，不是约 99MB 的完整权重。"
                "多半是网页。请再点下载，或手动下载 640m.onnx 后填路径"
            )
        return got


def _download_worker() -> None:
    _ensure_dirs()
    dest = recommended_path()
    part = dest + ".part"
    last = None
    cancelled = False
    try:
        for url in WEIGHT_URLS:
            if _dl["cancel"]:
                cancelled = True
                break
            try:
                _download_one(url, part)
                digest = file_sha256(part)
                if digest != WEIGHT_SHA256:
                    raise RuntimeError(
                        "权重校验对不上，文件可能不是完整的 640m.onnx。"
                        "请再点下载，或到发布页手动下载后填路径"
                    )
                os.replace(part, dest)
                set_onnx_path(dest)
                _dl["progress"] = 1.0
                last = None
                break
            except DownloadCancelled:
                cancelled = True
                try:
                    os.remove(part)
                except OSError:
                    pass
                break
            except Exception as e:
                last = e
                try:
                    os.remove(part)
                except OSError:
                    pass
        if cancelled:
            _finish_download(cancelled=True)
            return
        if last is not None:
            raise last
        _finish_download()
    except Exception as e:
        _finish_download(error=str(e))
        try:
            os.remove(part)
        except OSError:
            pass


def status() -> dict:
    onnx = current_onnx()
    ort = _ort_mod() is not None
    ready = bool(ort and onnx)
    return {
        "ort": ort,
        "ready": ready,
        "model_path": onnx,
        "model_id": model_id_of(onnx),
        "downloading": bool(_dl["on"]),
        "progress": float(_dl["progress"]),
        "error": _dl["error"],
        "cancelled": bool(_dl.get("cancelled")),
        "has_recommended": recommended_present(),
        "release_url": RELEASE_URL,
        "weight_url": WEIGHT_URL,
        "loaded": _session is not None,
        "models": list_models(),
    }


def list_models() -> list[str]:
    _ensure_dirs()
    out = []
    try:
        for name in sorted(os.listdir(MODELS_DIR)):
            if name.lower().endswith(".onnx"):
                out.append(os.path.join(MODELS_DIR, name))
    except OSError:
        pass
    return out
