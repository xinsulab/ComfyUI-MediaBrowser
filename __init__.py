"""ComfyUI-MediaBrowser：加载节点上的媒体浏览器。

缩略图必须自己做：原生 /api/view?preview=webp;N 的 N 是质量不是尺寸。
PIL / 扫盘 / 抽帧必须进线程池，不能在 async 处理器里同步跑。
"""
import asyncio
import hashlib
import io
import json
import math
import os
import re
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from aiohttp import web
from PIL import Image, ImageDraw, ImageOps, ImageFilter
from PIL.PngImagePlugin import PngInfo

import folder_paths
from server import PromptServer

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# 缩略图按固定长边分档缓存。0 表示保留原像素，仅重编码；大图查看始终读取原文件。
THUMB_NATIVE = 0
# 前后端档位必须一致，避免吸附到相邻尺寸后使预设失真。
THUMB_SIZES = (256, 384, 512, 640, 768, 1024, 1536, 2048, THUMB_NATIVE)
THUMB_PX = 512          # 默认档（不带 px 参数时）。原来是 256，在高分屏上偏糊
# 缩略图质量统一配置，尺寸由请求档位决定。
THUMB_QUALITY = 82
# WebP method=2 在编码耗时与体积之间折中；取值范围为 0～6。
THUMB_METHOD = 2


def clamp_thumb_px(want: int) -> int:
    """请求的长边吸附到 THUMB_SIZES。别的值每个像素都会切一份缓存。

    0（原像素）是精确匹配，不参与「取最近档」—— 否则 0 会被吸到 256，
    用户选了原像素反而拿到最糊的一档。
    """
    if want == THUMB_NATIVE:
        return THUMB_NATIVE
    real = [s for s in THUMB_SIZES if s != THUMB_NATIVE]
    return min(real, key=lambda s: abs(s - want))
CACHE_DIR = os.path.join(os.path.dirname(__file__), "_thumbcache")
REGIONS_DIR = os.path.join(os.path.dirname(__file__), "_regions")
os.makedirs(CACHE_DIR, exist_ok=True)

# 首屏 IO 和缩略图共用有界线程池，按核数调整并为生成任务保留余量。
_POOL = ThreadPoolExecutor(
    max_workers=min(8, max(3, (os.cpu_count() or 4) // 2)),
    thread_name_prefix="mediabrowser",
)
# ONNX 推理由 _run_lock 串行化；工位用来叠「下一张解码」和「这一张推理」。
# 前端「同时检测几张」上限 4，池子对齐这个上限。再多也快不了，run 仍是一把锁。
_CENSOR_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="mediabrowser-censor")
# 索引预热独立排队，不能占满首屏列表和缩略图的工作线程。
_BACKGROUND_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="mediabrowser-index")
_BACKGROUND_JOBS = set()
# 生成完成时只做一次很小的旁挂索引写入；独立单线程避免和整库尺寸预热互相排队。
# 线程按首次任务惰性创建，空闲时没有轮询、CPU 或磁盘开销。
_ELAPSED_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mediabrowser-elapsed")


def _spawn_bg(loop, fn, *args, coalesce=False) -> None:
    """后台执行响应不依赖的索引工作，并记录异常；可合并同函数的重复预热。"""
    # 预热是尽力补全；上一轮没结束时跳过重复预热，避免快速切目录堆积整库任务。
    if coalesce and fn in _BACKGROUND_JOBS:
        return
    if coalesce:
        _BACKGROUND_JOBS.add(fn)
    fut = loop.run_in_executor(_BACKGROUND_POOL, fn, *args)

    def _report(f):
        if coalesce:
            _BACKGROUND_JOBS.discard(fn)
        if f.cancelled():
            return
        exc = f.exception()
        if exc is not None:
            print(f"[MediaBrowser] 后台任务 {getattr(fn, '__name__', fn)} 失败: {exc!r}")

    fut.add_done_callback(_report)

_DIRS = {
    "input": folder_paths.get_input_directory,
    "output": folder_paths.get_output_directory,
    "temp": folder_paths.get_temp_directory,
}


def _resolve(kind: str, filename: str) -> str:
    """(类型, 文件名) → 真实路径，并挡住越界。

    两道判据：
    1. 逐段拒退化名。Windows 会把 "......" / 尾随空格这类名字规范化掉，
       结果解析后落回根目录 —— 用户传了个不存在的目录却拿到根内容，会困惑。
    2. 解析后的绝对路径必须仍在根内。不是「有没有 ..」——
       单用 os.path.join 挡不住绝对路径穿越。
    """
    get_dir = _DIRS.get(kind)
    if get_dir is None:
        raise ValueError(f"未知类型 {kind}")
    for part in re.split(r"[\/]+", filename):
        if part in ("", "."):
            continue                      # "./" "a//b" 这类是合法写法
        if not part.strip(" ."):          # "......" "  " —— 全是点或空格
            raise ValueError("非法目录名")
    root = os.path.abspath(get_dir())
    target = os.path.abspath(os.path.join(root, filename))
    if target != root and not target.startswith(root + os.sep):
        raise ValueError("路径越界")
    return target


def _video_thumb(src: str, dst: str, px: int = THUMB_PX) -> None:
    """视频封面：抽一帧再缩。

    取 1 秒处而不是第 0 帧 —— 很多片子首帧是黑场/淡入，抽出来一片黑。
    抽不到就退回第 0 帧（短于 1 秒的片子）。

    最后一档换 NVIDIA 硬解再试：捆绑的 imageio_ffmpeg 里 libaom-av1 解不动
    某些 AV1 流（报 "No sequence header"），而 av1_cuvid 实测能出图。
    只在软解全败时才走，正常片子不多跑一趟。
    """
    if not FFMPEG:
        raise RuntimeError("没有 ffmpeg，装不了视频封面")
    import subprocess
    tmp = f"{dst}.{uuid.uuid4().hex}.part"          # 带 uuid：并发各写各的，不互相踩
    attempts = [(ss, None) for ss in ("00:00:01", "00:00:00")]
    attempts += [("00:00:00", "av1_cuvid")]         # 硬解兜底
    last = ""
    for ss, dec in attempts:
        # 只抽一帧：-threads 1 更快，也只占 1 个核。
        cmd = [FFMPEG, "-v", "error", "-threads", "1"]
        if dec:
            cmd += ["-c:v", dec]
        cmd += ["-ss", ss, "-i", src, "-frames:v", "1"]
        # px=0 是原像素档：整个不加 scale 滤镜。
        # 不能写 scale='min(0,iw)' —— 那会算出 0 宽，ffmpeg 直接报错。
        if px:
            cmd += ["-vf", f"scale='min({px},iw)':-2"]
        cmd += ["-f", "webp", "-quality", str(THUMB_QUALITY), "-y", tmp]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=25)
        except Exception as e:
            last = str(e)
            continue
        if os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
            _publish(tmp, dst)                      # 有输出就算成功：硬解会边报警告边出图
            return
        last = (r.stderr or b"").decode("utf-8", "ignore").strip()[-200:]
    _rm(tmp)
    raise RuntimeError(f"这个视频抽不出封面。ffmpeg 说：{last or '没给原因'}")


def thumb_key(kind: str, filename: str, st: os.stat_result, px: int) -> str:
    """缓存键带 mtime + size：源文件改了自动失效。"""
    return hashlib.sha1(
        f"{kind}|{filename}|{st.st_mtime_ns}|{st.st_size}|{px}".encode("utf-8")
    ).hexdigest()


def bigger_cached(kind: str, filename: str, st: os.stat_result, px: int) -> str | None:
    """查找已缓存的更大尺寸，优先复用最近的一档；原像素档没有更大的候选。"""
    if px == THUMB_NATIVE:
        return None
    bigger = sorted(s for s in THUMB_SIZES if s != THUMB_NATIVE and s > px)
    for cand in bigger + [THUMB_NATIVE]:
        p = os.path.join(CACHE_DIR, thumb_key(kind, filename, st, cand) + ".webp")
        if os.path.isfile(p):
            return p
    return None


def _make_thumb(src: str, dst: str, px: int = THUMB_PX, base: str | None = None) -> None:
    """同步的缩略图生成。只在线程池里调用，绝不在事件环上跑。

    base = 同一张图更大的那一档已经生成好的 webp（见 bigger_cached）。
    有它就从它缩，原图和 ffmpeg 都不用碰。
    """
    if base is None and src.lower().endswith(VID_EXT) and not src.lower().endswith(".gif"):
        return _video_thumb(src, dst, px)
    with Image.open(base or src) as im:
        # 缓存里那份是我们自己写的，早就转正过了；再转一次反而会转错
        if base is None:
            im = ImageOps.exif_transpose(im)  # 手机照片带旋转信息，不转会躺着
        if px:                                # px=0 是原像素档：只重编码，不缩放
            im.thumbnail((px, px), Image.Resampling.LANCZOS)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        tmp = f"{dst}.{uuid.uuid4().hex}.part"
        im.save(tmp, format="webp", quality=THUMB_QUALITY, method=THUMB_METHOD)
    _publish(tmp, dst)


IMG_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
VID_EXT = (".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v", ".gif")
AUD_EXT = (".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus")
# ⚠️ AUD_EXT 一定要并进 MEDIA_EXT —— 漏了它，音频加载节点（VHS_LoadAudioUpload）
#    在宫格里一个文件都看不到，而且不报错，只是空列表。
MEDIA_EXT = tuple(sorted(set(IMG_EXT + VID_EXT + AUD_EXT)))
# 缩略图只给能出画面的。音频算媒体（列表要看见），但 PIL/ffmpeg 出不了封面。
THUMB_EXT = tuple(sorted(set(IMG_EXT + VID_EXT)))
# 「全部」要名副其实：列目录时不按扩展名筛，让前端的类型下拉去决定显示什么。
# 不这么做的话，output 里的 .md/.txt/.json 永远列不出来，而下拉却写着「全部」。
LIST_ALL_FILES = True


def _find_ffmpeg() -> str | None:
    """定位 ffmpeg。

    优先复用 VideoHelperSuite 的 ffmpeg_path —— 它已经在这个环境里解决过
    这个问题，且它能跑就说明路径对。自己猜路径迟早猜错。
    """
    try:
        from videohelpersuite.utils import ffmpeg_path as p   # type: ignore
        if p and os.path.isfile(p):
            return p
    except Exception:
        pass
    try:
        import imageio_ffmpeg
        p = imageio_ffmpeg.get_ffmpeg_exe()
        if p and os.path.isfile(p):
            return p
    except Exception:
        pass
    import shutil as _sh
    return _sh.which("ffmpeg")


FFMPEG = _find_ffmpeg()
_LIST_CACHE: dict[str, tuple[float, dict]] = {}
_LIST_TTL = 20.0        # 秒。只挡换排序/连点同一目录，点刷新必须带 refresh=1 绕过
_LIST_CACHE_MAX = 64    # 每个目录一个键，不设上限逛久了会一直涨

# 缩略图缓存上限。到顶就按最后访问时间删掉最旧的一批。
# 源文件改名/删除后旧缩略图会成孤儿（键里带 mtime，改了就是新键），靠这个回收。
_THUMB_MAX_FILES = 8000

# 修剪的节流计数。修剪一次要 scandir 整个缓存目录再逐个 stat 排序 ——
# 3000 个文件实测 7ms。原本每生成一张缩略图就跑一次：首次浏览一个新目录
# 是一屏 30 张 → 白烧 200ms **线程池**时间，而线程池正是生成缩略图的瓶颈。
# 缓存离上限还差几千个时这些活全是白干的。改成每 N 次才真跑一次。
_TRIM_EVERY = 200
_trim_tick = 0

# 每个缓存键一把锁，合并同一缩略图的并发生成请求。
_INFLIGHT: dict[str, asyncio.Lock] = {}


def _rm(p: str) -> None:
    try:
        os.remove(p)
    except OSError:
        pass


def _publish(tmp: str, dst: str) -> None:
    """原子发布缓存。并发写入已有可用目标时允许复用，否则传播写入错误。"""
    try:
        os.replace(tmp, dst)
    except OSError:
        _rm(tmp)
        if not os.path.isfile(dst):
            raise          # 目标也不在 = 真失败，不能吞


def _trim_thumb_cache() -> None:
    import time as _t
    # 节流：见 _TRIM_EVERY 的注释。第一次（tick=1）也跑一遍，
    # 这样进程刚起来就能把上次残留的 .part 孤儿收掉。
    global _trim_tick
    _trim_tick += 1
    if _trim_tick != 1 and _trim_tick % _TRIM_EVERY != 0:
        return
    try:
        ents = []
        for e in os.scandir(CACHE_DIR):
            if not e.is_file():
                continue
            # 顺手收掉超过一小时的 .part 孤儿（进程被杀/生成失败留下的）
            if e.name.endswith(".part"):
                try:
                    if _t.time() - e.stat().st_mtime > 3600:
                        _rm(e.path)
                except OSError:
                    pass
                continue
            # 索引不是缩略图，绝不能进淘汰名单：删了不报错，
            # 表现只是「怎么每次列目录都变慢了」——最难查的那种。
            if not _is_thumb_file(e.name):
                continue
            ents.append(e)
    except OSError:
        return
    if len(ents) <= _THUMB_MAX_FILES:
        return
    ents.sort(key=lambda e: e.stat().st_atime)          # 最久没被读的先删
    for e in ents[: len(ents) - int(_THUMB_MAX_FILES * 0.9)]:
        _rm(e.path)


_SKIP = {"_thumbcache", "__pycache__", ".git", "node_modules", "_models", "_regions", "_overlays"}


# 尺寸索引用于瀑布流初始比例；未索引条目在缩略图加载后由前端校正。
# 后台每轮限制新建条目数，前台只读取列表首段的缺失项。
DIM_BUDGET = 600
# 首屏同步尺寸范围；其余索引在后台补全。
DIM_BUDGET_SYNC = 64
# 预算外只读 PNG 文本块拿耗时。每次 list 最多这么多张，避免 4000+ 冷目录全扫。
ELAPSED_TEXT_BUDGET = 64
DIM_INDEX = os.path.join(CACHE_DIR, "_dims.json")
_DIMS: dict[str, list] = {}
_DIMS_DIRTY = False


def _load_dims() -> None:
    global _DIMS
    try:
        import json
        with open(DIM_INDEX, "r", encoding="utf-8") as f:
            _DIMS = json.load(f)
    except Exception:
        _DIMS = {}


def _save_dims() -> None:
    global _DIMS_DIRTY
    if not _DIMS_DIRTY:
        return
    try:
        import json
        tmp = DIM_INDEX + f".{uuid.uuid4().hex}.part"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_DIMS, f)
        _publish(tmp, DIM_INDEX)
        _DIMS_DIRTY = False
    except Exception:
        pass


# ── 耗时旁挂索引 ────────────────────────────────────────────────
# 键是 "size|mtime_ns"，**不是路径** —— 这样改名、挪目录（含跨盘）之后还认得出来。
# 实测：rename、同卷 shutil.move、跨卷 shutil.move（走 copy2）都不改 mtime 和 size；
# Windows 资源管理器拖拽也保留。所以这个键扛得住「文件还是那个文件，只是换了地方」。
#
# ⚠️ 为什么不写进 PNG 的文本块（那是最初的做法，已废弃）：
#   为了存十几个字节，要把用户几十 MB 的原图整个重写一遍，代价和风险完全不成比例——
#   ① 重写就有丢数据的可能：实测丢过 IEND 之后的 2713 字节，
#      内容是照片编辑器的调整图层参数，静默且不可逆；
#   ② mtime 和 size 都会变，而缩略图缓存键和检测缓存键**都含这两项** ——
#      等于每补写一张就作废它的封面和已检测出的框，要重新解码、重新跑 GPU；
#   ③ 文件内容变了，任何按内容哈希去重/同步的系统都会把它当成新文件；
#   ④ 12 张图要读写约 284MB，而这里只要 0.4KB。
#   代价是「换台机器就没了」—— 但耗时是「这次跑了多久」的辅助信息，不是作品的一部分。
ELAPSED_INDEX = os.path.join(CACHE_DIR, "_elapsed.json")
# 条数上限。一条约 30 字节，20000 条不到 1MB，但它只增不减，得有个头。
_ELAPSED_MAX = 20000
# 目录列表只兜底最近一小段 history；正常持久化已经由 task_done 挂钩负责。
_HISTORY_ELAPSED_RECENT = 128
_ELAPSED: dict[str, float] = {}
_ELAPSED_DIRTY = False
_ELAPSED_LOCK = threading.RLock()
# 只用于进程内作废清理前已排队的写任务；无需写入磁盘。
_ELAPSED_EPOCH = 0


def elapsed_key(st: os.stat_result) -> str:
    """文件的身份键。用 size + mtime 而不是路径，改名挪目录都还认得。"""
    return f"{st.st_size}|{st.st_mtime_ns}"


def _load_elapsed() -> None:
    global _ELAPSED
    with _ELAPSED_LOCK:
        try:
            import json
            with open(ELAPSED_INDEX, "r", encoding="utf-8") as f:
                data = json.load(f)
            _ELAPSED = {k: float(v) for k, v in data.items()
                        if isinstance(k, str) and isinstance(v, (int, float))}
        except Exception:
            _ELAPSED = {}


def _save_elapsed(expected_epoch: int | None = None) -> None:
    global _ELAPSED_DIRTY, _ELAPSED
    with _ELAPSED_LOCK:
        if expected_epoch is not None and expected_epoch != _ELAPSED_EPOCH:
            return
        if not _ELAPSED_DIRTY:
            return
        try:
            import json
            if len(_ELAPSED) > _ELAPSED_MAX:
                # 超了就砍掉一半。没有访问时间可依，按插入顺序丢最旧的
                # （dict 在 3.7+ 保序）。丢了也只是那张图不显示耗时，不影响别的。
                keep = list(_ELAPSED.items())[-(_ELAPSED_MAX // 2):]
                _ELAPSED = dict(keep)
            tmp = ELAPSED_INDEX + f".{uuid.uuid4().hex}.part"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(_ELAPSED, f)
            _publish(tmp, ELAPSED_INDEX)
            _ELAPSED_DIRTY = False
        except Exception:
            pass


def remember_elapsed(st: os.stat_result, seconds,
                     expected_epoch: int | None = None) -> bool:
    """记住某个文件跑了多久。不碰文件本身。"""
    global _ELAPSED_DIRTY
    sec = _parse_seconds(seconds)
    if not sec:
        return False
    k = elapsed_key(st)
    with _ELAPSED_LOCK:
        if expected_epoch is not None and expected_epoch != _ELAPSED_EPOCH:
            return False
        if abs(_ELAPSED.get(k, 0.0) - sec) < 0.05:
            return False                  # 已经有这个值了，别把索引标脏
        _ELAPSED[k] = sec
        _ELAPSED_DIRTY = True
        return True


def recall_elapsed(st: os.stat_result) -> float | None:
    with _ELAPSED_LOCK:
        return _ELAPSED.get(elapsed_key(st))


def recall_elapsed_rec(f: dict) -> float:
    """从 _browse 的文件记录里查耗时。

    ⚠️ 用记录里现成的 s/n（scandir 那一次 stat 就带回来了），**不要再 os.stat** ——
    这条在最常走的路径上，6000 个文件多 stat 一遍实测 152ms（热缓存），
    冷盘或网络盘上是几秒。
    """
    sz, mns = f.get("s"), f.get("n")
    if not mns:
        # 记录里没带（旧的列表缓存、或调用方自己拼的）：退回 stat 一次。
        # 正常路径不会走到这儿 —— _browse 现在都会带上。
        try:
            st = os.stat(f["a"])
            sz, mns = st.st_size, st.st_mtime_ns
        except (OSError, KeyError):
            return 0.0
    with _ELAPSED_LOCK:
        return _ELAPSED.get(f"{sz}|{mns}", 0.0)


def annotate_widget_value(rel: str, kind: str) -> str:
    """LoadImage 系读文件：非 input 必须带 [output]/[temp]。

    前端 JS 的 annotate 必须与这里逐字同语义。错了 = 从 output 选的图
    入队报 Invalid image file，错误信息完全不提缺后缀。
    """
    if kind == "input":
        return rel
    return f"{rel} [{kind}]"


def _is_vid(path: str) -> bool:
    low = path.lower()
    return low.endswith(VID_EXT) and not low.endswith(".gif")


def _parse_seconds(v) -> float | None:
    """把各种「跑了多久」写法收成秒。0 / 负数 / 认不出的都当成没有。"""
    if isinstance(v, (int, float)):
        return float(v) if v > 0 else None
    if not isinstance(v, str):
        return None
    s = v.strip()
    if not s:
        return None
    m = re.match(r"^([\d.]+)\s*s(?:ec(?:onds?)?)?$", s, re.I)
    if m:
        try:
            n = float(m.group(1))
        except ValueError:
            return None
        return n if n > 0 else None
    try:
        n = float(s)
    except ValueError:
        return None
    return n if n > 0 else None


def elapsed_from_png_info(info: dict | None) -> float | None:
    """标准 Comfy PNG 只有 prompt/workflow，没有耗时。

    偶尔有自定义存图节点或 A1111 参数块会带 generation_time / Time taken。
    有就用，没有就当没有 —— 不要编 0.00s。
    """
    if not info:
        return None
    low = {str(k).lower().replace(" ", "_"): v for k, v in info.items()}
    for k in (
        "generation_time", "generation_time_seconds",
        "execution_time", "execution_time_seconds",
        "elapsed", "elapsed_seconds", "gen_time", "comfy_elapsed",
        "time_taken",
    ):
        sec = _parse_seconds(low.get(k))
        if sec:
            return sec
    params = low.get("parameters")
    if isinstance(params, str):
        m = re.search(r"Time taken:\s*([\d.]+)\s*s", params, re.I)
        if m:
            try:
                n = float(m.group(1))
            except ValueError:
                n = 0
            if n > 0:
                return n
    return None


def elapsed_from_status(status: dict | None) -> float | None:
    """从 history.status.messages 的开始和结束时间戳计算耗时秒数。"""
    if not isinstance(status, dict):
        return None
    start = end = None
    for entry in status.get("messages") or []:
        if not (isinstance(entry, (list, tuple)) and len(entry) >= 2):
            continue
        name, data = entry[0], entry[1]
        if not isinstance(data, dict):
            continue
        ts = data.get("timestamp")
        if not isinstance(ts, (int, float)):
            continue
        if name == "execution_start":
            start = ts
        elif name in ("execution_success", "execution_error", "execution_interrupted"):
            end = ts
    if start and end and end > start:
        return (end - start) / 1000.0
    return None


def parse_ffmpeg_duration(text: str) -> float | None:
    """从 ffmpeg 横幅里抠 Duration: HH:MM:SS.xx。"""
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text or "")
    if not m:
        return None
    sec = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return sec if sec > 0 else None


def _video_duration(src: str) -> float | None:
    """只读容器头，不解码。整库同步探会卡死列表，只给按需接口用。"""
    if not FFMPEG:
        return None
    import subprocess
    try:
        r = subprocess.run(
            [FFMPEG, "-hide_banner", "-i", src],
            capture_output=True, timeout=12,
        )
    except Exception:
        return None
    return parse_ffmpeg_duration((r.stderr or b"").decode("utf-8", "ignore"))


def _history_item_elapsed_records(item: dict) -> list[tuple[str, str, float]]:
    """把一条 history 压成 ``(根类型, 相对路径, 秒数)`` 小记录。

    这个函数会在 ComfyUI 的 history 锁内执行，不能保留 prompt、工作流或图片对象；
    只返回落盘所需的几个字符串和数字，避免生成完成时深拷贝整条历史。
    """
    if not isinstance(item, dict):
        return []
    sec = elapsed_from_status(item.get("status"))
    if not sec:
        return []
    outputs = item.get("outputs")
    if not isinstance(outputs, dict):
        return []
    records: list[tuple[str, str, float]] = []
    for node_out in outputs.values():
        if not isinstance(node_out, dict):
            continue
        for entries in node_out.values():
            if not isinstance(entries, list):
                continue
            for it in entries:
                if not isinstance(it, dict):
                    continue
                kind = it.get("type")
                if kind is None:
                    kind = "output"
                if not isinstance(kind, str) or kind not in _DIRS:
                    continue
                fn = it.get("filename")
                if not isinstance(fn, str) or not fn:
                    continue
                sub = it.get("subfolder")
                if sub is None:
                    sub = ""
                if not isinstance(sub, str):
                    continue
                sub = sub.replace("\\", "/").strip("/")
                name = fn.replace("\\", "/").lstrip("/")
                records.append((kind, f"{sub}/{name}" if sub else name, sec))
    return records


def _legacy_recent_history_records(queue) -> list[tuple[str, str, float]] | None:
    """旧版队列没有有界查询参数时，从受锁保护的内部字典尾部压取小窗口。"""
    history = getattr(queue, "history", None)
    mutex = getattr(queue, "mutex", None)
    if not isinstance(history, dict) or mutex is None:
        return None
    from itertools import islice
    records: list[tuple[str, str, float]] = []
    try:
        with mutex:
            # reversed(dict) 是反向键迭代器；islice 只访问 128 条，不创建一万键的列表。
            recent_ids = list(islice(reversed(history), _HISTORY_ELAPSED_RECENT))
            # 恢复为旧→新，让后续同路径赋值保持“最新一次生成获胜”的原有语义。
            for prompt_id in reversed(recent_ids):
                records.extend(_history_item_elapsed_records(history[prompt_id]))
    except Exception:
        return None
    return records


def _history_elapsed_map(kind: str) -> dict[str, float]:
    """把还活着的 prompt history 对上本次列表的相对路径。

    这是旧版本和挂钩安装失败时的兼容兜底。正常情况下，生成完成挂钩会在
    history 被清理或服务重启前立即写入旁挂索引。
    """
    queue = getattr(getattr(PromptServer, "instance", None), "prompt_queue", None)
    try:
        hist = queue.get_history(max_items=_HISTORY_ELAPSED_RECENT)
    except TypeError:
        # 老版本没有 max_items，优先在队列锁内自行取尾部小窗口。
        records = _legacy_recent_history_records(queue)
        if records is not None:
            return {rel: sec for record_kind, rel, sec in records
                    if record_kind == kind}
        # 极老或第三方队列没有标准内部字段时，功能兼容优先，才最后退回公开接口。
        try:
            hist = queue.get_history()
        except Exception:
            return {}
    except Exception:
        return {}
    if not isinstance(hist, dict):
        return {}
    out: dict[str, float] = {}
    for item in hist.values():
        for record_kind, rel, sec in _history_item_elapsed_records(item):
            if record_kind == kind:
                out[rel] = sec
    return out


def _prompt_elapsed_records(queue, prompt_id) -> list[tuple[str, str, float]]:
    """只读取刚完成的 prompt；新版 ComfyUI 走 map_function 避免深拷贝。"""
    try:
        hist = queue.get_history(
            prompt_id=prompt_id,
            map_function=_history_item_elapsed_records,
        )
    except TypeError:
        # 兼容尚未支持 map_function 的旧版 ComfyUI；仍只取一个 prompt。
        try:
            hist = queue.get_history(prompt_id=prompt_id)
        except Exception:
            return []
    except Exception:
        return []
    if not isinstance(hist, dict):
        return []
    item = hist.get(prompt_id)
    if isinstance(item, list):
        return item
    return _history_item_elapsed_records(item)


def _persist_elapsed_records(records: list[tuple[str, str, float]],
                             expected_epoch: int | None = None) -> None:
    """把完成事件中的小记录关联到真实文件，并原子写入旁挂索引。"""
    changed = False
    for kind, rel, sec in records:
        try:
            st = os.stat(_resolve(kind, rel))
        except (OSError, ValueError):
            continue
        if remember_elapsed(st, sec, expected_epoch):
            changed = True
    if changed:
        _save_elapsed(expected_epoch)


def _submit_elapsed_records(records: list[tuple[str, str, float]]) -> None:
    """后台持久化，不让 JSON 写盘延长生成队列的关键路径。"""
    if not records:
        return
    with _ELAPSED_LOCK:
        expected_epoch = _ELAPSED_EPOCH
    try:
        fut = _ELAPSED_POOL.submit(_persist_elapsed_records, records, expected_epoch)
    except RuntimeError:
        # 解释器关机时线程池会先关闭；辅助元数据不能让已完成的生成反向报错。
        return

    def _report(f):
        if f.cancelled():
            return
        exc = f.exception()
        if exc is not None:
            print(f"[MediaBrowser] 耗时索引写入失败: {exc!r}")

    fut.add_done_callback(_report)


def _install_elapsed_completion_hook() -> bool:
    """在 ComfyUI ``task_done`` 后立即截取耗时，摆脱浏览目录的时机依赖。"""
    queue = getattr(getattr(PromptServer, "instance", None), "prompt_queue", None)
    current = getattr(queue, "task_done", None)
    if queue is None or not callable(current):
        return False

    # 重载插件时始终包住最初的 ComfyUI 方法，避免 wrapper 套 wrapper 重复写盘。
    original = getattr(queue, "_mediabrowser_original_task_done", current)
    try:
        queue._mediabrowser_original_task_done = original
    except Exception:
        return False

    def task_done_with_elapsed(*args, **kwargs):
        item_id = args[0] if args else kwargs.get("item_id")
        prompt_id = None
        try:
            mutex = getattr(queue, "mutex", None)
            if mutex is None:
                prompt = getattr(queue, "currently_running", {}).get(item_id)
            else:
                with mutex:
                    prompt = getattr(queue, "currently_running", {}).get(item_id)
            if isinstance(prompt, (list, tuple)) and len(prompt) > 1:
                prompt_id = prompt[1]
        except Exception:
            prompt_id = None

        # 原方法必须先完成 history 写入；采集失败也绝不能改变 ComfyUI 的执行结果。
        result = original(*args, **kwargs)
        if prompt_id is not None:
            try:
                records = _prompt_elapsed_records(queue, prompt_id)
                _submit_elapsed_records(records)
            except Exception as exc:
                print(f"[MediaBrowser] 生成耗时采集失败: {exc!r}")
        return result

    queue.task_done = task_done_with_elapsed
    return True


def _dims_extras(hit: list | None) -> tuple[float, float]:
    """索引第 5/6 位：任务耗时（秒）、视频片长（秒）。没有就是 0。"""
    if not hit:
        return 0.0, 0.0
    el = hit[4] if len(hit) > 4 else 0
    du = hit[5] if len(hit) > 5 else 0
    try:
        el = float(el) if el else 0.0
    except (TypeError, ValueError):
        el = 0.0
    try:
        du = float(du) if du else 0.0
    except (TypeError, ValueError):
        du = 0.0
    return (el if el > 0 else 0.0), (du if du > 0 else 0.0)


def _store_dims(rel: str, w: int, h: int, mtime: float, wf: int,
                elapsed: float = 0.0, duration: float = 0.0) -> None:
    global _DIMS_DIRTY
    prev = _DIMS.get(rel)
    old_el, old_du = _dims_extras(prev)
    _DIMS[rel] = [
        w, h, mtime, wf,
        elapsed if elapsed > 0 else old_el,
        duration if duration > 0 else old_du,
    ]
    _DIMS_DIRTY = True


def _apply_history_elapsed(kind: str, ordered_full: list, elapsed: dict) -> dict:
    global _DIMS_DIRTY
    hist = _history_elapsed_map(kind)
    if not hist:
        return elapsed
    dirty = False
    for f in ordered_full:
        rel = f["p"]
        sec = hist.get(rel)
        if not sec:
            continue
        elapsed[rel] = sec
        rec = _DIMS.get(rel)
        if rec is None:
            # 还没有尺寸行就只放进本次返回值。写 [0,0,…] 会让下次误判缓存命中，永远不算真宽高。
            continue
        old_el, _old_du = _dims_extras(rec)
        if abs(old_el - sec) < 0.001:
            continue
        rec = list(rec)
        while len(rec) < 6:
            rec.append(0)
        rec[4] = sec
        _DIMS[rel] = rec
        dirty = True
    if dirty:
        _DIMS_DIRTY = True
        _save_dims()
    return elapsed


def _remember_known_elapsed(ordered_full: list, elapsed: dict,
                            expected_epoch: int | None = None) -> None:
    """把已知耗时写入按 size+mtime 标识的旁挂索引，保留改名后的关联。"""
    if not elapsed:
        return
    if expected_epoch is None:
        with _ELAPSED_LOCK:
            expected_epoch = _ELAPSED_EPOCH
    by_rel = {f["p"]: f for f in ordered_full}
    hit = False
    for rel, sec in elapsed.items():
        f = by_rel.get(rel)
        path = (f or {}).get("a")
        if not path:
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        if remember_elapsed(st, sec, expected_epoch):
            hit = True
    if hit:
        _save_elapsed(expected_epoch)


def _fill_dims(ordered_full: list, budget: int | None = None, foreground: bool = False,
               expected_elapsed_epoch: int | None = None) -> dict:
    """给排序后的列表补尺寸 / 已缓存的耗时和片长。只在线程池里调用。

    查索引是内存字典，全部都查；开文件算尺寸只给预算内的。
    这两件必须在同一线程里做完再写回，避免事件环上跑 PIL。
    视频片长要开 ffmpeg，不在这里同步探 —— 前端对看得见的再问 /clipinfo。
    """
    global _DIMS_DIRTY
    dims, elapsed, duration = {}, {}, {}
    if budget is None:
        budget = DIM_BUDGET      # 调用时取，别写进默认参数（那是定义时求值）
    # 首屏预算按位置截断，不在每次缓存命中后继续向后寻找下一批缺失项。
    # 预算外的旧 PNG 尾部耗时块只在后台扫描，辅助信息不能拖住列表响应。
    limit = budget
    text_budget = 0 if foreground else ELAPSED_TEXT_BUDGET
    dirty_elapsed = False
    if expected_elapsed_epoch is None:
        with _ELAPSED_LOCK:
            expected_elapsed_epoch = _ELAPSED_EPOCH
    for index, f in enumerate(ordered_full):
        if foreground and index >= limit:
            budget = 0
        rel = f["p"]
        hit = _DIMS.get(rel)
        if hit and len(hit) >= 3 and abs(hit[2] - f["t"]) < 1:
            dims[rel] = [hit[0], hit[1], hit[3] if len(hit) > 3 else -1]
            el, du = _dims_extras(hit)
            # ⚠️ 这是**三条路径里最常走的一条**（尺寸缓存命中就到这儿为止）。
            #    _DIMS 按路径索引，改名后这里查不到耗时；旁挂索引按 size+mtime，
            #    正是为这种情况准备的。只接另外两条 = 改名后第一次刷新还在、
            #    第二次就没了，比一直没有更难查。
            if not el:
                el = recall_elapsed_rec(f)
            if el:
                elapsed[rel] = el
            if du:
                duration[rel] = du
            continue
        if budget <= 0:
            # 尺寸先不重算。耗时只读文本块；有旧宽高时只改第 5 位，
            # 不要把当前 mtime 写进去，否则永远不再 _dim_of。
            old_el, old_du = _dims_extras(hit)
            if old_el:
                elapsed[rel] = old_el
                if old_du:
                    duration[rel] = old_du
                continue
            # 旁挂索引按 size+mtime 查，命中就直接用 —— 纯内存 dict，
            # 不用开文件，所以也不需要 text_budget 那种限流了。
            # 老图可能还带着早期版本写进 PNG 的 elapsed 文本块，
            # 预算内回落读一次，读到就顺手记进索引，以后不用再开文件。
            el = recall_elapsed_rec(f)
            # 老图身上可能还带着早期版本写进 PNG 的 elapsed 块。这条要开文件，
            # 所以有 text_budget 限流；读到就记进索引，以后走上面那行直接命中。
            if (not el and text_budget > 0
                    and str(f.get("a") or "").lower().endswith(".png")):
                text_budget -= 1
                try:
                    el = elapsed_from_png_info(_png_text(f["a"])) or 0.0
                except Exception:
                    el = 0.0
                if el:
                    try:
                        if remember_elapsed(os.stat(f["a"]), el, expected_elapsed_epoch):
                            _save_elapsed(expected_elapsed_epoch)
                    except OSError:
                        pass
            if el:
                elapsed[rel] = el
                if hit:
                    rec = list(hit)
                    while len(rec) < 6:
                        rec.append(0)
                    rec[4] = el
                    _DIMS[rel] = rec
                    dirty_elapsed = True
            continue
        budget -= 1
        d = _dim_of(f["a"], rel, f["t"])
        if d:
            dims[rel] = d
            el, du = _dims_extras(_DIMS.get(rel))
            # ⚠️ _DIMS 是按**路径**索引的，改个名就查不到了。
            #    旁挂索引按 size+mtime 索引，正是为这种情况准备的 ——
            #    两条路径都要查它，只接一条等于「扛得住改名」只在半数情况成立。
            if not el:
                el = recall_elapsed_rec(f)
            if el:
                elapsed[rel] = el
            if du:
                duration[rel] = du
    if dirty_elapsed:
        _DIMS_DIRTY = True
    _save_dims()
    return {"dims": dims, "elapsed": elapsed, "duration": duration}


def _dim_of(abs_path: str, rel: str, mtime: float) -> list:
    """返回 [宽, 高, 工作流状态]，按 mtime 复用索引。视频暂用 16:9，片长由 /clipinfo 补充。"""
    hit = _DIMS.get(rel)
    if hit and len(hit) >= 3 and abs(hit[2] - mtime) < 1:
        return [hit[0], hit[1], hit[3] if len(hit) > 3 else -1]

    low = abs_path.lower()
    elapsed = 0.0
    if not low.endswith(MEDIA_EXT):
        # 非媒体（.md/.json/.zip…）直接给方块，**不要去 Image.open** ——
        # PIL 对认不出的格式会一路试探各种解码器，很慢：实测放它进来后
        # 全库首扫从 544ms 涨到 8345ms，而这些文件本来就没有宽高可言。
        w, h, wf = 1, 1, 0
    elif _is_vid(low):
        # 视频先按 16:9 摆着，等缩略图到了前端再用真实比例校正
        w, h, wf = 16, 9, -1
    else:
        w, h, wf = 1, 1, 0
        try:
            with Image.open(abs_path) as im:
                w, h = im.size
                wf = 1 if ("workflow" in im.info or "prompt" in im.info) else 0
                elapsed = elapsed_from_png_info(im.info) or 0.0
                # 旧补写把块放在 IDAT 后，PIL 看不见；自己扫一遍文本块兜住。
                if not elapsed and low.endswith(".png"):
                    elapsed = elapsed_from_png_info(_png_text(abs_path)) or 0.0
        except Exception:
            pass

    _store_dims(rel, w, h, mtime, wf, elapsed=elapsed)    # 它自己会置脏标记
    return [w, h, wf]


_load_dims()
_load_elapsed()
_install_elapsed_completion_hook()

def _scan(base: str, root: str, recursive: bool) -> tuple[list, list]:
    """扫描当前层或子树，返回目录和带时间戳的文件；此阶段不读取媒体内容。"""
    dirs, files = [], []
    stack = [base]
    first = True
    while stack:
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                for e in it:
                    if e.name in _SKIP:
                        continue
                    if e.is_dir(follow_symlinks=False):
                        if recursive:
                            stack.append(e.path)
                        elif first:
                            dirs.append(e.path)          # 非递归只收第一层的目录
                    elif LIST_ALL_FILES or e.name.lower().endswith(MEDIA_EXT):
                        try:
                            est = e.stat(follow_symlinks=False)
                            mt, sz, mns = est.st_mtime, est.st_size, est.st_mtime_ns
                        except OSError:
                            mt, sz, mns = 0, 0, 0
                        rel = os.path.relpath(e.path, root).replace(os.sep, "/")
                        # 这里**不算尺寸**：算尺寸要逐个开文件，2 万个文件的目录
                        # 冷盘要 10 秒。改成排序之后只给排在前面的算（见 DIM_BUDGET），
                        # 剩下的等缩略图到了前端自己校正比例。
                        # 顺手带上 size 和 mtime_ns：scandir 这一次 stat 已经拿到了，
                        # 后面查耗时索引就不用再 stat 一遍 —— 6000 个文件实测省 152ms
                        # （热缓存；冷盘或网络盘上是几秒）。
                        files.append({"p": rel, "t": mt, "a": e.path, "s": sz, "n": mns})
        except OSError:
            pass
        first = False
        if not recursive:
            break
    return dirs, files


def _count_imgs(path: str) -> int:
    n = 0
    for _, dn, fn in os.walk(path):
        dn[:] = [d for d in dn if d not in _SKIP]
        n += sum(1 for f in fn) if LIST_ALL_FILES else sum(1 for f in fn if f.lower().endswith(MEDIA_EXT))
    return n


def _browse(base: str, root: str, recursive: bool) -> dict:
    """列目录并统计非空子目录的文件数；recursive 为真时平铺子树。"""
    dpaths, files = _scan(base, root, recursive)
    dirs = []
    for p in dpaths:
        n = _count_imgs(p)
        # 空目录不显示 —— 免得点进去才发现没东西
        if n:
            dirs.append({"name": os.path.basename(p), "count": n,
                         "t": os.stat(p).st_mtime})
    dirs.sort(key=lambda d: d["name"].lower())
    return {"dirs": dirs, "files": files}


def _sort_files(files: list, mode: str) -> list:
    """就地排序并把同一个列表还回来。默认时间倒序 —— 最常用的就是「刚出的那张」。

    还回完整对象而不是路径列表：后面算尺寸还要用里面的绝对路径。
    """
    if mode == "time_asc":
        files.sort(key=lambda f: f["t"])
    elif mode == "name_asc":
        files.sort(key=lambda f: f["p"].lower())
    elif mode == "name_desc":
        files.sort(key=lambda f: f["p"].lower(), reverse=True)
    else:                                    # time_desc，默认
        files.sort(key=lambda f: f["t"], reverse=True)
    return files


@PromptServer.instance.routes.get("/mediabrowser/list")
async def mediabrowser_list(request):
    q = request.rel_url.query
    kind = q.get("type", "input")
    subfolder = q.get("subfolder", "")
    recursive = q.get("recursive", "") in ("1", "true", "yes")

    get_dir = _DIRS.get(kind)
    if get_dir is None:
        return web.json_response({"error": f"未知类型 {kind}"}, status=400)
    root = os.path.abspath(get_dir())

    try:
        base = _resolve(kind, subfolder) if subfolder else root
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    if not os.path.isdir(base):
        return web.json_response({"error": "目录不存在"}, status=404)

    sort = q.get("sort", "time_desc")
    force = q.get("refresh", "") in ("1", "true", "yes")

    import time
    now = time.time()
    ck = f"{kind}|{subfolder}|{int(recursive)}"
    hit = None if force else _LIST_CACHE.get(ck)
    used_cache = bool(hit and now - hit[0] < _LIST_TTL)
    if used_cache:
        raw = hit[1]
    else:
        # 同步 IO 一律甩线程池，别冻事件环
        raw = await asyncio.get_running_loop().run_in_executor(
            _POOL, _browse, base, root, recursive
        )
        if len(_LIST_CACHE) > _LIST_CACHE_MAX:
            for k in sorted(_LIST_CACHE, key=lambda k: _LIST_CACHE[k][0])[:_LIST_CACHE_MAX // 2]:
                _LIST_CACHE.pop(k, None)
        _LIST_CACHE[ck] = (now, raw)

    # 排序在缓存之外做 —— 换排序不用重扫盘
    ordered_full = _sort_files(list(raw["files"]), sort)
    ordered = [f["p"] for f in ordered_full]
    # 两件事分开：
    #   **查**索引是内存字典查找，白拿 —— 全部文件都查，有多少给多少。
    #   **算**尺寸要逐个开文件（2 万个冷盘 10 秒），只给排在最前面的算。
    # 之前把两件混成一件，结果索引里明明有几千条，返回的却只有本次算的 600 条，
    # 前端因此以为"这文件没信息"，⧉ 按钮的判断也跟着失准。
    # 算尺寸 / 写索引必须进线程池：同步 PIL 在事件环上会冻住 Comfy 的 HTTP。
    loop = asyncio.get_running_loop()
    # 清理前发起的列表任务不能在清理后把旧耗时索引重新写回来。
    with _ELAPSED_LOCK:
        elapsed_epoch = _ELAPSED_EPOCH
    # 只算**眼前看得见**的那些，其余等响应发出去再补（见 DIM_BUDGET_SYNC）。
    pack = await loop.run_in_executor(
        _POOL, _fill_dims, ordered_full, DIM_BUDGET_SYNC, True, elapsed_epoch
    )
    elapsed = _apply_history_elapsed(kind, ordered_full, dict(pack.get("elapsed") or {}))
    # 下面两件都是**写**操作，响应内容不依赖它们的结果 —— 不 await，别让人干等磁盘。
    #   ① 把 history 对上的秒数记进旁挂索引（改名挪目录后还认得出耗时）
    #   ② 把预算外那些文件的尺寸补进索引，下次列这个目录就是纯内存命中
    _spawn_bg(loop, _remember_known_elapsed, ordered_full, elapsed, elapsed_epoch)
    if len(ordered_full) > DIM_BUDGET_SYNC:
        _spawn_bg(loop, _fill_dims, ordered_full, DIM_BUDGET, False,
                  elapsed_epoch, coalesce=True)
    return web.json_response({
        "dirs": raw["dirs"],
        "files": ordered,
        "dims": pack.get("dims") or {},
        "times": {f["p"]: f["t"] for f in ordered_full},
        "elapsed": elapsed,
        "duration": pack.get("duration") or {},
        "cached": used_cache,
        "sort": sort,
    })


# 早期版本把耗时写进 PNG 的 tEXt 块，键叫 elapsed。写入那条路已经拆掉
# （见 ELAPSED_INDEX 上面那段说明），但**读还得留着** ——
# 用户手上已经有一批被写过的图，得认得出来。
_ELAPSED_PNG_KEY = "elapsed"


def _png_text(path: str) -> dict:
    """读 PNG 的 tEXt/iTXt 块，拿 prompt / workflow。"""
    out = {}
    with open(path, "rb") as f:
        if f.read(8) != b"\x89PNG\r\n\x1a\n":
            return out
        while True:
            head = f.read(8)
            if len(head) < 8:
                break
            ln = int.from_bytes(head[:4], "big")
            typ = head[4:8]
            if typ == b"IEND":
                break
            if typ in (b"tEXt", b"iTXt"):
                blob = f.read(ln)
                nul = blob.find(b"\x00")
                if nul > 0:
                    k = blob[:nul].decode("latin1", "ignore")
                    v = blob[nul + 1:]
                    if typ == b"iTXt":            # iTXt 还有 3 个头字节要跳
                        v = v[3:] if len(v) > 3 else v
                    out[k] = v.decode("utf-8", "ignore").lstrip("\x00")
                f.read(4)
            else:
                f.seek(ln + 4, 1)
    return out


# 采样器类节点的正负向条件各走哪个键
_POS_KEYS = ("positive", "guider")
_NEG_KEYS = ("negative",)
# 归零/裁剪类节点：语义就是「把上游 conditioning 清空/削掉」。回溯到它必须停，
# 否则会穿过去摸到上游的正向文本，把它误当成负向 —— 实测 KSampler 用
# ConditioningZeroOut(正向) 当负向是很常见的写法（省一个空文本节点）。
_COND_SINK = ("ConditioningZeroOut", "ConditioningSetTimestepRange")
# 想顺手带出来的关键参数（有就给，没有不强求）
_PARAM_KEYS = ("steps", "cfg", "sampler_name", "scheduler", "denoise", "seed", "noise_seed")
_TEXT_KEYS = ("text", "prompt", "string", "value", "populated_text")


def _extract_positive(prompt_graph: dict) -> list[str]:
    """顺采样器的 positive 连线回溯，摘出真正的正向提示词。

    为什么不是「找第一个 CLIPTextEncode」：很多流里第一个是**负向**
    （LTX 就是），按顺序猜必错。唯一可靠的是顺 positive 连线追。
    """
    if not isinstance(prompt_graph, dict):
        return []

    def node(nid):
        return prompt_graph.get(str(nid))

    def trace(link, depth=0, seen=None):
        """从一个连线回溯，返回沿途所有非空字符串字段。"""
        seen = seen or set()
        if depth > 8 or not isinstance(link, list) or not link:
            return []
        nid = str(link[0])
        if nid in seen:
            return []
        seen.add(nid)
        n = node(nid)
        if not isinstance(n, dict):
            return []
        # 撞上归零节点就停 —— 它下游拿到的是空条件，上游那段文本跟这条线无关
        if str(n.get("class_type", "")) in _COND_SINK:
            return []
        found = []
        ins = n.get("inputs", {})
        for k in _TEXT_KEYS:
            v = ins.get(k)
            if isinstance(v, str) and v.strip():
                found.append(v.strip())
        if found:
            return found
        for v in ins.values():                    # 没直接带文本就继续往上游找
            if isinstance(v, list):
                found += trace(v, depth + 1, seen)
        return found

    def collect(keys):
        out = []
        for _nid, n in prompt_graph.items():
            if not isinstance(n, dict):
                continue
            if not any(x in str(n.get("class_type", "")) for x in ("Sampler", "Guider")):
                continue
            ins = n.get("inputs", {})
            for k in keys:
                if k in ins:
                    out += trace(ins[k])
        seen, uniq = set(), []
        for t in out:
            if t not in seen:
                seen.add(t)
                uniq.append(t)
        return uniq

    pos = collect(_POS_KEYS)
    neg = collect(_NEG_KEYS)
    # 同一段文本两边都摸到时，判它是正向 —— 文本节点本身写的是正向内容，
    # 负向那条线只是「路过」它（如经过归零节点）。剔除方向搞反会把正向整段删掉。
    neg = [n for n in neg if n not in pos]

    # 兜底：条件链上一段文本都没摸到时，去全图捞。
    # 为什么需要：VLM 反推流（ImageCaptionNode 之类）里，采样器的 text 是**连线**不是
    # 字面量 —— 真正用了的提示词只落在 easy showAnything 这类显示节点上。这段文本确实
    # 是这次跑用的词，但它不在条件链上，所以只能标「推测」，不能跟确凿的正向混为一谈。
    guess = []
    if not pos and not neg:
        for _nid, n in prompt_graph.items():
            if not isinstance(n, dict):
                continue
            for k in _TEXT_KEYS:
                v = n.get("inputs", {}).get(k)
                if not isinstance(v, str):
                    continue
                v = v.strip()
                # 20 字以下多半是开关值/短标签；含换行的路径模板也排掉
                if len(v) < 20 or v.count("%") > 2 or v.count("\\") > 1:
                    continue
                if v not in guess:
                    guess.append(v)

    params, model = {}, None
    for _nid, n in prompt_graph.items():
        if not isinstance(n, dict):
            continue
        cls = str(n.get("class_type", ""))
        ins = n.get("inputs", {})
        if any(x in cls for x in ("Sampler", "Scheduler", "Guider")):
            for k in _PARAM_KEYS:
                v = ins.get(k)
                if isinstance(v, (int, float, str)) and k not in params:
                    params[k] = v
        if model is None and cls in ("UNETLoader", "CheckpointLoaderSimple"):
            model = ins.get("unet_name") or ins.get("ckpt_name")

    return {"positive": pos, "negative": neg, "guess": guess,
            "params": params, "model": model}


def _video_meta(src: str) -> dict:
    """从视频容器元数据里读工作流。

    ComfyUI 存视频时（VHS_VideoCombine / SaveVideo）把 GUI 图写进容器的
    `workflow` 标签 —— 实测 mp4 里确实有。跟 PNG 的 `prompt` 不是一个东西：
    那是 API 图（扁平，输入直接带链），这是 GUI 图（nodes 数组 + links 数组，
    文本躺在 widgets_values 里），所以得单独解析。
    """
    if not FFMPEG:
        return {}
    import subprocess, json
    try:
        r = subprocess.run(
            [FFMPEG, "-v", "error", "-threads", "1", "-i", src, "-f", "ffmetadata", "-"],
            capture_output=True, timeout=20)
    except Exception:
        return {}
    txt = (r.stdout or b"").decode("utf-8", "ignore")
    out = {}
    # ffmetadata 是 key=value 行式；工作流 JSON 很长且自带换行转义，
    # 所以定位到 key= 之后一路取到下一个顶层 key 为止。
    for key in ("workflow", "prompt"):
        i = txt.find(f"\n{key}=")
        if i < 0 and txt.startswith(f"{key}="):
            i = -1
        if i < 0 and not txt.startswith(f"{key}="):
            continue
        start = (0 if i < 0 else i + 1) + len(key) + 1
        rest = txt[start:]
        # 往后扫到第一个「行首是 单词= 」的位置
        end = len(rest)
        for m in re.finditer(r"\n([A-Za-z_][A-Za-z0-9_-]*)=", rest):
            end = m.start()
            break
        raw = re.sub(r"\\([=;#\\\n])", r"\1", rest[:end])
        try:
            out[key] = json.loads(raw)
        except Exception:
            pass
    return out


def _extract_from_gui(gui: dict) -> dict:
    """从 GUI 图里摘提示词。

    GUI 图跟 API 图两套结构：这里的连线在顶层 links 数组
    （[链id, 源节点, 源槽, 目标节点, 目标槽, 类型]），文本在 widgets_values 数组里
    按位置放，没有字段名。所以判正负向只能靠「采样器的第几个输入槽」——
    找到采样器节点，看它 positive/negative 槽各连到谁，再去那个节点的
    widgets_values 里捞字符串。
    """
    nodes = {str(n.get("id")): n for n in gui.get("nodes", []) if isinstance(n, dict)}
    if not nodes:
        return {"positive": [], "negative": [], "guess": [], "params": {}, "model": None}

    # 建索引：目标节点 -> {目标槽名: 源节点id}
    wired: dict[str, dict[str, str]] = {}
    for ln in gui.get("links", []):
        if not isinstance(ln, list) or len(ln) < 5:
            continue
        src_id, dst_id, dst_slot = str(ln[1]), str(ln[3]), ln[4]
        dn = nodes.get(dst_id)
        if not dn:
            continue
        ins = dn.get("inputs") or []
        if isinstance(dst_slot, int) and 0 <= dst_slot < len(ins):
            name = (ins[dst_slot] or {}).get("name")
            if name:
                wired.setdefault(dst_id, {})[str(name)] = src_id

    def texts_of(nid, depth=0, seen=None):
        seen = seen or set()
        if depth > 8 or nid in seen:
            return []
        seen.add(nid)
        n = nodes.get(nid)
        if not n:
            return []
        if str(n.get("type", "")) in _COND_SINK:
            return []
        got = [v.strip() for v in (n.get("widgets_values") or [])
               if isinstance(v, str) and len(v.strip()) >= 12]
        if got:
            return got
        out = []
        for up in (wired.get(nid) or {}).values():
            out += texts_of(up, depth + 1, seen)
        return out

    pos, neg = [], []
    for nid, n in nodes.items():
        if not any(x in str(n.get("type", "")) for x in ("Sampler", "Guider")):
            continue
        w = wired.get(nid) or {}
        for k in _POS_KEYS:
            if k in w:
                pos += texts_of(w[k])
        for k in _NEG_KEYS:
            if k in w:
                neg += texts_of(w[k])

    def uniq(xs):
        s2, o = set(), []
        for x in xs:
            if x not in s2:
                s2.add(x)
                o.append(x)
        return o

    pos, neg = uniq(pos), uniq(neg)
    neg = [n for n in neg if n not in pos]

    guess = []
    if not pos and not neg:
        for n in nodes.values():
            for v in (n.get("widgets_values") or []):
                if not isinstance(v, str):
                    continue
                v = v.strip()
                if len(v) < 20 or v.count("%") > 2 or v.count("\\") > 1:
                    continue
                if v not in guess:
                    guess.append(v)

    model = None
    for n in nodes.values():
        if str(n.get("type", "")) in ("UNETLoader", "CheckpointLoaderSimple"):
            for v in (n.get("widgets_values") or []):
                if isinstance(v, str) and v.endswith(".safetensors"):
                    model = v
                    break
        if model:
            break
    return {"positive": pos, "negative": neg, "guess": guess, "params": {}, "model": model}


@PromptServer.instance.routes.get("/mediabrowser/meta")
async def mediabrowser_meta(request):
    q = request.rel_url.query
    filename, kind = q.get("filename", ""), q.get("type", "input")
    if not filename:
        return web.json_response({"error": "缺 filename"}, status=400)
    try:
        src = _resolve(kind, filename)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    if not os.path.isfile(src):
        return web.json_response({"error": "文件不存在"}, status=404)

    def work():
        import json
        low = src.lower()
        empty = {"positive": [], "negative": [], "guess": [], "params": {}, "model": None}

        if low.endswith(VID_EXT) and not low.endswith(".gif"):
            vm = _video_meta(src)
            if "prompt" in vm:                      # 少见，但拿得到就用最准的
                got = _extract_positive(vm["prompt"])
            elif "workflow" in vm:
                got = _extract_from_gui(vm["workflow"])
            else:
                return {**empty, "has_workflow": False, "has_prompt": False,
                        "note": "这个视频里没存工作流。ComfyUI 出的片子一般会把它写进"
                                "文件元数据，外部下载或转码过的就没有了。"}
            return {**got, "has_workflow": "workflow" in vm, "has_prompt": "prompt" in vm}

        if not low.endswith(".png"):
            return {**empty, "has_workflow": False, "has_prompt": False,
                    "note": "jpg / webp 存不下工作流，只有 PNG 和视频存得下。"}

        txt = _png_text(src)
        got = dict(empty)
        if "prompt" in txt:
            try:
                got = _extract_positive(json.loads(txt["prompt"]))
            except Exception:
                pass
        return {**got, "has_workflow": "workflow" in txt, "has_prompt": "prompt" in txt}

    data = await asyncio.get_running_loop().run_in_executor(_POOL, work)
    return web.json_response(data)


@PromptServer.instance.routes.get("/mediabrowser/workflow")
async def mediabrowser_workflow(request):
    """把文件里内嵌的工作流原样吐出来，前端拿去开新标签。

    PNG 读 tEXt/iTXt 块；视频读容器元数据（ComfyUI 存片时会把 GUI 图写进
    `workflow` 标签）。两种都能还原成可运行的画布。
    """
    q = request.rel_url.query
    filename, kind = q.get("filename", ""), q.get("type", "input")
    # 跟 /meta、/thumb 保持一致：没给 filename 是**用户传错了参数**（400），
    # 不是「文件不存在」（404）。少这一句的话空参数会落进 _resolve、
    # 解析出根目录本身、再报 404 —— 错误码和原因都不对，排查时会被带偏。
    if not filename:
        return web.json_response({"error": "缺 filename"}, status=400)
    try:
        src = _resolve(kind, filename)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    if not os.path.isfile(src):
        return web.json_response({"error": "文件不存在"}, status=404)

    low = src.lower()
    is_vid = low.endswith(VID_EXT) and not low.endswith(".gif")
    if not is_vid and not low.endswith(".png"):
        # 分开判：文件不存在是 404，格式不对才是 400。
        # 合在一起会对不存在的 .png 报「只支持 PNG」，误导排查。
        ext = (os.path.splitext(src)[1] or "").lstrip(".").upper() or "这种"
        return web.json_response(
            {"error": f"{ext} 文件里存不下工作流，只有 PNG 和视频存得下"}, status=400)

    def work():
        import json
        if is_vid:
            vm = _video_meta(src)
            for k in ("workflow", "prompt"):
                if k in vm:
                    return {"kind": k, "graph": vm[k]}
            return {"error": "这个视频里没存工作流 —— 外部下载或转码过的片子会丢掉这些信息"}
        txt = _png_text(src)
        for k in ("workflow", "prompt"):
            if k in txt:
                try:
                    return {"kind": k, "graph": json.loads(txt[k])}
                except Exception:
                    continue
        return {"error": "这张图里没存工作流"}

    data = await asyncio.get_running_loop().run_in_executor(_POOL, work)
    return web.json_response(data, status=400 if "error" in data else 200)


# ⚠️ 别为「视频有没有内嵌工作流」加批量探测端点来决定 ⧉ 按钮显不显示。
# 成本不是问题（一个视频 40ms，答案进索引就不再问），交互才是：
# 答案要等探测回来，按钮就会在鼠标已经停上去之后才消失 —— 等于在光标底下抽走目标。
# 而 76% 的视频本来就有工作流，猜错的代价只是点一下看到一句明确提示。
# 所以视频一律显示 ⧉，没有工作流时由 /workflow 给出具体原因。
# PNG 的同款标记保留 —— 那个跟读尺寸共用一次 PIL open，是真的白拿。

@PromptServer.instance.routes.post("/mediabrowser/clipinfo")
async def mediabrowser_clipinfo(request):
    """给看得见的视频补片长。一次最多 16 个，答案进 _DIMS。"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    kind = body.get("type", "output")
    files = body.get("files") or []
    if not isinstance(files, list):
        return web.json_response({"error": "files 必须是数组"}, status=400)
    files = [str(x).replace("\\", "/") for x in files if x][:16]

    def work():
        out = {}
        for rel in files:
            try:
                src = _resolve(kind, rel)
            except ValueError:
                continue
            if not os.path.isfile(src) or not _is_vid(src):
                continue
            rec = _DIMS.get(rel)
            cached = _dims_extras(rec)[1]
            if cached > 0:
                out[rel] = cached
                continue
            dur = _video_duration(src)
            if not dur:
                continue
            try:
                mt = os.path.getmtime(src)
            except OSError:
                mt = 0
            if rec and len(rec) >= 4:
                _store_dims(rel, rec[0], rec[1], rec[2], rec[3], duration=dur)
            else:
                _store_dims(rel, 16, 9, mt, -1, duration=dur)
            out[rel] = dur
        _save_dims()
        return out

    data = await asyncio.get_running_loop().run_in_executor(_POOL, work)
    return web.json_response({"duration": data})


@PromptServer.instance.routes.get("/mediabrowser/thumb")
async def mediabrowser_thumb(request):
    filename = request.rel_url.query.get("filename", "")
    kind = request.rel_url.query.get("type", "input")
    # px 只认 THUMB_SIZES 里的档：传别的取最接近的一档。
    # 不直接用用户给的数 —— 那样每个像素值都会切出一份缓存，磁盘迟早爆。
    try:
        want = int(request.rel_url.query.get("px", THUMB_PX))
    except ValueError:
        want = THUMB_PX
    px = clamp_thumb_px(want)
    if not filename:
        return web.Response(status=400, text="缺 filename")

    try:
        src = _resolve(kind, filename)
    except ValueError as e:
        return web.Response(status=400, text=str(e))

    if not os.path.isfile(src):
        return web.Response(status=404, text="文件不存在")
    if not src.lower().endswith(THUMB_EXT):
        # 用户错误必须是 4xx，不能让 PIL 抛异常变成 500。
        # 音频在 MEDIA_EXT 里（列表要能看见），但出不了封面 —— 不要让 PIL 试探。
        return web.Response(status=400, text="不是支持的图片/视频格式")

    st = os.stat(src)

    # 档位比原图长边还大时，thumbnail() 只缩不放 —— 出来的图跟原像素一模一样。
    # 但缓存键带 px 的话，1536 / 2048 / 原像素 会给同一张图存三份**完全相同**的
    # webp（实测 1280x1278 的图三档都是 33KB）。而这一类图不少：
    # 抽样 300 张，长边中位数 1536，2048 档下 76% 的图根本不会被缩小。
    # 所以先把 px 夹到原图长边，让这些请求落到同一个缓存条目上。
    # 尺寸从浏览时已填好的内存索引里取，取不到就照原样（不为此多开一次文件）。
    # ⚠️ _DIMS 的键是**相对 root 的路径**、不含 root，所以 input/a.png 和
    #    output/a.png 会互相覆盖。只凭路径取尺寸可能拿到另一个文件的 ——
    #    那会按错误的长边归一，给大图生成原像素档。
    #    第三位存的就是 mtime，跟这里已经拿到的 st 比一下；对不上就不归一
    #    （宁可多存一份缓存，也不能按错尺寸出图）。
    dim = _DIMS.get(filename)
    if dim and len(dim) >= 3 and abs(float(dim[2] or 0) - st.st_mtime) < 1:
        long_edge = max(int(dim[0] or 0), int(dim[1] or 0))
        if long_edge and (px == THUMB_NATIVE or px > long_edge):
            px = THUMB_NATIVE      # 归一到原像素这一档，别按档位各存一份

    key = thumb_key(kind, filename, st, px)
    cache = os.path.join(CACHE_DIR, key + ".webp")
    # 同一张图更大的那一档要是已经生成过，就从它缩 —— 别再解码一遍原图 / 再开一次 ffmpeg
    base = None if os.path.isfile(cache) else bigger_cached(kind, filename, st, px)

    if not os.path.isfile(cache):
        lock = _INFLIGHT.setdefault(key, asyncio.Lock())
        async with lock:
            # 拿到锁再查一次 —— 等锁期间别人可能已经生成好了
            if not os.path.isfile(cache):
                try:
                    loop = asyncio.get_running_loop()
                    _t0 = time.perf_counter()
                    await loop.run_in_executor(_POOL, _make_thumb, src, cache, px, base)
                    _note_thumb(px, time.perf_counter() - _t0, hit=False)
                    if sum(r["gen"] for r in _THUMB_STATS.values()) % _THUMB_LOG_EVERY == 0:
                        print(_thumb_stats_line())
                    # 只在真生成时才修剪 —— 命中缓存的路径不做多余 IO
                    loop.run_in_executor(_POOL, _trim_thumb_cache)
                except Exception as e:
                    return web.Response(status=500, text=f"缩略图生成失败: {e}")
                finally:
                    _INFLIGHT.pop(key, None)
            else:
                _INFLIGHT.pop(key, None)
                _note_thumb(px, 0.0, hit=True)      # 等锁期间别人生成好了，也算命中
    else:
        _note_thumb(px, 0.0, hit=True)

    # 读进内存返回，不用 FileResponse。
    # FileResponse 会在整个响应期间持有文件句柄，Windows 上另一个请求
    # 正好 os.replace 同一个缓存文件时就会撞锁 —— 实测 16 并发偶发 403。
    # 缩略图只有几 KB，读进内存成本可以忽略。
    try:
        data = await asyncio.get_running_loop().run_in_executor(
            _POOL, lambda: open(cache, "rb").read()
        )
    except OSError as e:
        return web.Response(status=500, text=f"读缓存失败: {e}")

    return web.Response(
        body=data,
        headers={
            # 长缓存安全的前提是 **URL 带 mtime**（前端拼 thumbUrl 时加的 &t=）。
            # 别把这里的理由写成「thumb_key 带 mtime」—— 那是服务端缓存**文件名**，
            # 浏览器看不见它，只按 URL 认。曾经就是这么写的，结果原地覆盖同名文件后
            # 用户盯着七天前的封面，完全不报错（2026-09-05 查出）。
            "Cache-Control": "public, max-age=604800",
            "Content-Type": "image/webp",                # 显式给 —— 否则视频抽的帧被当 octet-stream
        },
    )


# ── 遮蔽：框检测。冷启动不 load ONNX；同步推理进 _POOL ──
# 按文件加载：测试里是 `import __init__`（无包），Comfy 里是包名导入，
# 两种情况下裸 `import censor` 都可能找错模块。
# 加载失败也要把路由挂上，否则前端只看到 404，会误以为「没重启」。
import importlib.util as _ilu
_censor = None
_censor_err = None
try:
    _censor_spec = _ilu.spec_from_file_location(
        "mediabrowser_censor", os.path.join(os.path.dirname(__file__), "censor.py"))
    _censor = _ilu.module_from_spec(_censor_spec)
    _censor_spec.loader.exec_module(_censor)
    print("[MediaBrowser] 局部遮蔽已就绪")
except Exception as e:
    _censor_err = f"{type(e).__name__}: {e}"
    print(f"[MediaBrowser] 局部遮蔽没加载上：{_censor_err}")
    print("[MediaBrowser] 浏览和其它功能都不受影响；界面上遮蔽相关的按钮会带出同一条原因。"
          "这一步只 import 标准库和 Pillow，出错基本只有插件文件不完整一种可能 —— "
          "重新拉一次插件目录即可。")


# censor.py 没加载成功时也要能告诉前端去哪下权重，所以这里必须有独立的一份 ——
# 此刻 import 不到 censor.RELEASE_URL。有契约测试钉住两处相同，防静默漂移。
_FALLBACK_RELEASE_URL = "https://github.com/notAI-tech/NudeNet/releases/tag/v3.4-weights"


def _censor_down():
    return {
        "ort": False,
        "ready": False,
        "model_path": None,
        "downloading": False,
        "progress": 0.0,
        "error": _censor_err or "censor 未加载",
        "cancelled": False,
        "has_recommended": False,
        "release_url": _FALLBACK_RELEASE_URL,
        "models": [],
    }


@PromptServer.instance.routes.get("/mediabrowser/censor/status")
async def mediabrowser_censor_status(request):
    if _censor is None:
        return web.json_response(_censor_down())
    data = await asyncio.get_running_loop().run_in_executor(_POOL, _censor.status)
    return web.json_response(data)


@PromptServer.instance.routes.post("/mediabrowser/censor/download")
async def mediabrowser_censor_download(request):
    if _censor is None:
        return web.json_response(_censor_down(), status=503)
    force = False
    try:
        body = await request.json()
        if isinstance(body, dict):
            force = bool(body.get("force"))
    except Exception:
        pass
    return web.json_response(
        await asyncio.get_running_loop().run_in_executor(
            _POOL, lambda: _censor.download_start(force=force)
        )
    )


@PromptServer.instance.routes.post("/mediabrowser/censor/download/cancel")
async def mediabrowser_censor_download_cancel(request):
    if _censor is None:
        return web.json_response(_censor_down(), status=503)
    _censor.download_cancel()
    return web.json_response({"ok": True})


@PromptServer.instance.routes.post("/mediabrowser/censor/settings")
async def mediabrowser_censor_settings(request):
    if _censor is None:
        return web.json_response({"error": _censor_err or "censor 未加载"}, status=503)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        return web.json_response({"error": "JSON 对象"}, status=400)
    path = body.get("onnx")
    if not path:
        return web.json_response({"error": "缺 onnx"}, status=400)
    try:
        return web.json_response(_censor.set_onnx_path(str(path)))
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)


@PromptServer.instance.routes.get("/mediabrowser/regions")
async def mediabrowser_regions(request):
    q = request.rel_url.query
    filename, kind = q.get("filename", ""), q.get("type", "input")
    infer = q.get("infer", "1") not in ("0", "false", "no")
    force = q.get("force", "0") not in ("0", "false", "no")
    if not filename:
        return web.json_response({"error": "缺 filename"}, status=400)
    low = filename.lower()
    if low.endswith(AUD_EXT):
        return web.json_response({"boxes": None, "reason": "unsupported"}, status=400)
    if not (low.endswith(IMG_EXT) or low.endswith(VID_EXT)):
        return web.json_response({"boxes": None, "reason": "unsupported"}, status=400)
    try:
        src = _resolve(kind, filename)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    if not os.path.isfile(src):
        return web.json_response({"error": "文件不存在"}, status=404)
    is_vid = low.endswith(VID_EXT) and not low.endswith(".gif")

    if _censor is None:
        return web.json_response({"boxes": None, "reason": "no_backend", "error": _censor_err}, status=503)

    def work():
        return _censor.detect_file(src, infer=infer, video=is_vid, ffmpeg=FFMPEG, force=force)

    # 走 _CENSOR_POOL，不占缩略图的工位（见 _CENSOR_POOL 的注释）
    data = await asyncio.get_running_loop().run_in_executor(_CENSOR_POOL, work)
    return web.json_response(data)


# 限制解码像素数量，避免预览合成占用过量内存。
_PAINT_MAX_PIXELS = 50_000_000
_PAINT_STILL = (".png", ".jpg", ".jpeg", ".webp", ".bmp")


def _pixelate_box(im: Image.Image, box: tuple[int, int, int, int], block: int) -> None:
    """把矩形变成马赛克。NEAREST 放大才会是色块，不是糊。"""
    x0, y0, x1, y1 = box
    region = im.crop((x0, y0, x1, y1))
    rw, rh = region.size
    if rw < 2 or rh < 2:
        return
    small = region.resize(
        (max(1, rw // block), max(1, rh // block)),
        Image.Resampling.NEAREST,
    )
    im.paste(small.resize((rw, rh), Image.Resampling.NEAREST), (x0, y0))


def _norm_rect(op: dict, w: int, h: int) -> tuple[int, int, int, int] | None:
    x0 = int(max(0, min(w, round(op["x"] * w))))
    y0 = int(max(0, min(h, round(op["y"] * h))))
    x1 = int(max(0, min(w, round((op["x"] + op["w"]) * w))))
    y1 = int(max(0, min(h, round((op["y"] + op["h"]) * h))))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    return x0, y0, x1, y1


def _pixelate_stroke(im: Image.Image, pts: list, radius_norm: float, block: int, effect: str = "mosaic", strength: float = 14) -> None:
    """沿折线打圆形笔刷马赛克。先糊包围盒，再用笔迹当蒙版贴回去。"""
    w, h = im.size
    radius = max(1, int(round(radius_norm * min(w, h))))
    pix = [(p[0] * w, p[1] * h) for p in pts]
    xs = [p[0] for p in pix]
    ys = [p[1] for p in pix]
    x0 = int(max(0, math.floor(min(xs) - radius)))
    y0 = int(max(0, math.floor(min(ys) - radius)))
    x1 = int(min(w, math.ceil(max(xs) + radius)))
    y1 = int(min(h, math.ceil(max(ys) + radius)))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return
    mosaic = im.crop((x0, y0, x1, y1))
    mw, mh = mosaic.size
    # 共用笔迹蒙版，确保模糊与马赛克切换不改变已画区域。
    if effect == "blur":
        mosaic = mosaic.filter(ImageFilter.GaussianBlur(strength))
    else:
        small = mosaic.resize(
            (max(1, mw // block), max(1, mh // block)), Image.Resampling.NEAREST,
        )
        mosaic = small.resize((mw, mh), Image.Resampling.NEAREST)
    mask = Image.new("L", (mw, mh), 0)
    draw = ImageDraw.Draw(mask)
    local = [(p[0] - x0, p[1] - y0) for p in pix]
    if len(local) == 1:
        px, py = local[0]
        draw.ellipse((px - radius, py - radius, px + radius, py + radius), fill=255)
    else:
        draw.line(local, fill=255, width=radius * 2, joint="curve")
        for px, py in local:
            draw.ellipse((px - radius, py - radius, px + radius, py + radius), fill=255)
    im.paste(mosaic, (x0, y0), mask)


def _png_keep_info(im: Image.Image) -> PngInfo:
    """把原 PNG 的 prompt / workflow 文本块带去新文件。重编码像素，但工作流不能丢。"""
    info = PngInfo()
    text = getattr(im, "text", None) or {}
    for key, val in text.items():
        if not isinstance(key, str) or not isinstance(val, str) or not key:
            continue
        try:
            val.encode("latin-1")
            info.add_text(key, val)
        except (UnicodeEncodeError, OSError, ValueError):
            try:
                info.add_itxt(key, val)
            except (OSError, ValueError):
                pass
    return info


# 图层单独保存；锁覆盖版本比较和原子写入，避免多个窗口互相覆盖。
OVERLAY_DIR = os.path.join(os.path.dirname(__file__), "_overlays")
_OVERLAY_LOCK = threading.RLock()


def _overlay_source(src):
    st = os.stat(src)
    with Image.open(src) as im:
        if im.width * im.height > _PAINT_MAX_PIXELS:
            raise ValueError("图片尺寸超出处理限制")
        if getattr(im, "n_frames", 1) > 1:
            raise ValueError("暂不支持编辑动态图")
        # 浏览器按 EXIF 显示方向，图层坐标也必须使用相同的朝向。
        width, height = im.size
        if im.getexif().get(274, 1) in (5, 6, 7, 8):
            width, height = height, width
        return {"size": st.st_size, "mtimeNs": str(st.st_mtime_ns), "width": width, "height": height}


def _overlay_path(src):
    key = hashlib.sha256(os.path.normcase(os.path.realpath(src)).encode("utf-8")).hexdigest()
    return os.path.join(OVERLAY_DIR, key + ".json")


def _overlay_ops(raw):
    if not isinstance(raw, list) or len(raw) > 2000:
        raise ValueError("遮蔽区域数量超出限制")
    out, ids, total = [], set(), 0
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("遮蔽记录无效")
        ident = item.get("id")
        if not isinstance(ident, str) or not ident or len(ident) > 100 or ident in ids:
            raise ValueError("遮蔽标识无效")
        ids.add(ident)
        kind = item.get("k")
        keys = ("x", "y", "w", "h") if kind == "r" else ("r",) if kind == "s" else ()
        if not keys:
            raise ValueError("遮蔽类型无效")
        op = {"id": ident, "k": kind, "auto": item.get("auto") is True,
              "label": str(item.get("label", ""))[:100]}
        for key in keys:
            value = item.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError("遮蔽坐标无效")
            op[key] = value
        if kind == "r":
            if op["w"] <= 0 or op["h"] <= 0 or op["x"] + op["w"] > 1.000001 or op["y"] + op["h"] > 1.000001:
                raise ValueError("遮蔽区域越界")
        else:
            pts = item.get("pts")
            if not isinstance(pts, list) or not pts or not 0.001 <= op["r"] <= 0.2:
                raise ValueError("笔刷记录无效")
            total += len(pts)
            if total > 50000:
                raise ValueError("笔刷点数量超出限制")
            for point in pts:
                if not isinstance(point, list) or len(point) != 2 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1 for v in point):
                    raise ValueError("笔刷坐标无效")
            op["pts"] = pts
        block = item.get("block", 16)
        if isinstance(block, bool) or not isinstance(block, (int, float)) or not math.isfinite(block) or not 6 <= block <= 48:
            raise ValueError("马赛克尺寸无效")
        op["block"] = int(block)
        effect = item.get("effect", "mosaic")
        strength = item.get("strength", 14)
        if effect not in ("mosaic", "blur") or isinstance(strength, bool) or not isinstance(strength, (int, float)) or not math.isfinite(strength) or not 1 <= strength <= 80:
            raise ValueError("遮蔽样式无效")
        op.update(effect=effect, strength=strength)
        raw = item.get("raw")
        if isinstance(raw, dict):
            # 仅保存检测器的标量输入，不允许任意对象进入长期图层记录。
            allowed = {k: raw[k] for k in ("x", "y", "w", "h", "score") if k in raw}
            if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in allowed.values()):
                raise ValueError("检测区域无效")
            allowed["label"] = str(raw.get("label", ""))[:100]
            op["raw"] = allowed
        out.append(op)
    return out


def _overlay_read(src):
    version = _overlay_source(src)
    path = _overlay_path(src)
    with _OVERLAY_LOCK:
        if not os.path.isfile(path):
            return {"schemaVersion": 1, "sourceVersion": version, "revision": 0, "ops": [], "suppressed": [], "exists": False}
        with open(path, encoding="utf-8") as f:
            record = json.load(f)
        if record.get("sourceVersion") != version:
            return {"schemaVersion": 1, "sourceVersion": version, "revision": record["revision"], "ops": [], "suppressed": [], "exists": False, "stale": True}
        return {**record, "exists": True}


def _overlay_save(src, body):
    revision = body.get("expectedRevision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        raise ValueError("遮蔽版本无效")
    ops = _overlay_ops(body.get("ops"))
    suppressed = _overlay_ops(body.get("suppressed", []))
    with _OVERLAY_LOCK:
        old = _overlay_read(src)
        if body.get("sourceVersion") != old["sourceVersion"] or body.get("expectedRevision") != old["revision"]:
            raise FileExistsError("图片或遮蔽已更新，请重新打开后编辑")
        record = {"schemaVersion": 1, "sourceVersion": old["sourceVersion"], "revision": old["revision"] + 1,
                  "ops": ops, "suppressed": suppressed, "updatedAt": time.time(), "exists": True}
        os.makedirs(OVERLAY_DIR, exist_ok=True)
        path = _overlay_path(src)
        tmp = path + "." + uuid.uuid4().hex + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(record, f, ensure_ascii=False, allow_nan=False)
            # 写入期间源文件被其他程序替换时，拒绝保存旧坐标。
            if _overlay_source(src) != old["sourceVersion"]:
                raise FileExistsError("图片已更新，请重新打开后编辑")
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
        return record


def _render_overlay(src, body):
    for key in ("showOverlay", "fullBlur", "peeking", "keepWorkflow"):
        if key in body and not isinstance(body[key], bool):
            raise ValueError("显示状态无效")
    ops = _overlay_ops(body.get("ops", []))
    version = _overlay_source(src)
    if body.get("sourceVersion") != version:
        raise FileExistsError("图片已更新，请重新打开后复制")
    with Image.open(src) as im:
        im.load()
        info = _png_keep_info(im) if body.get("keepWorkflow") is True else None
        work = ImageOps.exif_transpose(im).convert("RGBA")
        if not body.get("peeking"):
            if body.get("showOverlay"):
                for op in ops:
                    if op["k"] == "r":
                        box = _norm_rect(op, *work.size)
                        if box:
                            if op["effect"] == "blur":
                                work.paste(work.crop(box).filter(ImageFilter.GaussianBlur(op["strength"])), box)
                            else:
                                _pixelate_box(work, box, op["block"])
                    else:
                        _pixelate_stroke(work, op["pts"], op["r"], op["block"], op["effect"], op["strength"])
            if body.get("fullBlur"):
                work = work.filter(ImageFilter.GaussianBlur(22))
        # 预览先按原图尺度合成再缩小；复制未传此参数，始终导出源尺寸。
        preview_max = body.get("previewMax")
        if preview_max is not None:
            if isinstance(preview_max, bool) or not isinstance(preview_max, int) or not 64 <= preview_max <= 2048:
                raise ValueError("预览尺寸无效")
            work.thumbnail((preview_max, preview_max), Image.Resampling.LANCZOS)
        result = io.BytesIO()
        work.save(result, format="PNG", pnginfo=info)
    if _overlay_source(src) != version:
        raise FileExistsError("图片已更新，请重新打开后复制")
    return result.getvalue()


def _forget_listed(kind: str, rel: str = "") -> None:
    """删文件后列表缓存和尺寸索引必须立刻失效，否则刷新还看得见幽灵。"""
    dead = [k for k in _LIST_CACHE if k.startswith(f"{kind}|")]
    for k in dead:
        _LIST_CACHE.pop(k, None)
    if rel:
        _DIMS.pop(rel.replace("\\", "/"), None)


def _send_to_recycle(path: str) -> None:
    """把文件送进系统回收站。禁止 os.remove / unlink。"""
    if os.path.isdir(path):
        raise ValueError("只能删文件，文件夹请在资源管理器里处理")
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    if os.name == "nt":
        _recycle_windows(path)
        return
    _recycle_other(path)


def _recycle_windows(path: str) -> None:
    """SHFileOperation + FOF_ALLOWUNDO → 资源管理器回收站。"""
    import ctypes
    from ctypes import wintypes

    FO_DELETE = 3
    FOF_SILENT = 4
    FOF_NOCONFIRMATION = 16
    FOF_ALLOWUNDO = 64
    FOF_NOERRORUI = 1024

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", ctypes.c_void_p),
            ("pTo", ctypes.c_void_p),
            ("fFlags", wintypes.USHORT),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", ctypes.c_void_p),
            ("lpszProgressTitle", ctypes.c_void_p),
        ]

    # 双 NUL 结尾：SHFileOperation 的 pFrom 是文件列表，不是普通 C 字符串。
    # create_unicode_buffer 自己会再补一个 NUL，所以先加一个即可。
    buf = ctypes.create_unicode_buffer(os.path.abspath(path) + "\0")
    op = SHFILEOPSTRUCTW()
    op.wFunc = FO_DELETE
    op.pFrom = ctypes.addressof(buf)
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT
    rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if rc != 0:
        raise OSError(rc, f"系统回收站拒绝（{rc}）")
    if op.fAnyOperationsAborted:
        raise OSError("已取消")
    if os.path.exists(path):
        raise OSError("回收站操作结束，文件还在原处")


def _recycle_other(path: str) -> None:
    """macOS / Linux：走系统回收站命令。没有命令就失败，绝不直接删。"""
    import shutil
    import subprocess

    abs_path = os.path.abspath(path)
    if sys.platform == "darwin":
        r = subprocess.run(
            ["osascript", "-e",
             f'tell application "Finder" to delete POSIX file {abs_path!r}'],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            raise OSError(r.stderr.strip() or "Finder 没能移到废纸篓")
        return
    for cmd in (
        ["gio", "trash", abs_path],
        ["kioclient5", "move", abs_path, "trash:/"],
        ["trash-put", abs_path],
    ):
        if not shutil.which(cmd[0]):
            continue
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if r.returncode == 0:
            return
        raise OSError((r.stderr or r.stdout or "回收站命令失败").strip())
    raise OSError("这台机器没有可用的回收站命令（gio / trash-put）。不会直接删除文件")


@PromptServer.instance.routes.post("/mediabrowser/trash")
async def mediabrowser_trash(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        return web.json_response({"error": "JSON 对象"}, status=400)
    filename = str(body.get("filename") or "").strip()
    kind = str(body.get("type") or "input").strip()
    if not filename:
        return web.json_response({"error": "缺 filename"}, status=400)
    try:
        src = _resolve(kind, filename)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    if os.path.isdir(src):
        return web.json_response({"error": "只能删文件，文件夹请在资源管理器里处理"}, status=400)
    if not os.path.isfile(src):
        return web.json_response({"error": "文件不存在"}, status=404)

    def work():
        _send_to_recycle(src)

    try:
        await asyncio.get_running_loop().run_in_executor(_POOL, work)
    except FileNotFoundError:
        return web.json_response({"error": "文件不存在"}, status=404)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except OSError as e:
        return web.json_response({"error": e.strerror or str(e)}, status=500)

    rel = filename.replace("\\", "/")
    _forget_listed(kind, rel)
    return web.json_response({"ok": True, "filename": rel})


@PromptServer.instance.routes.post("/mediabrowser/paint")
async def mediabrowser_paint(request):
    # 旧页面不能继续覆盖源图；刷新后使用独立图层接口。
    return web.json_response({"error": "打码已改为独立图层，请刷新页面"}, status=410)


async def _overlay_request(request, action):
    try:
        if action == "read":
            body = dict(request.query)
        else:
            if request.content_length and request.content_length > 2 * 1024 * 1024:
                return web.json_response({"error": "遮蔽记录过大"}, status=413)
            raw = await request.read()
            if len(raw) > 2 * 1024 * 1024:
                return web.json_response({"error": "遮蔽记录过大"}, status=413)
            body = json.loads(raw)
        if not isinstance(body, dict) or not body.get("filename"):
            raise ValueError("请选择图片")
        src = _resolve(str(body.get("type", "input")), str(body["filename"]))
        if not src.lower().endswith(_PAINT_STILL):
            return web.json_response({"error": "此功能仅支持静态图片"}, status=415)
        fn = {"read": lambda: _overlay_read(src), "save": lambda: _overlay_save(src, body), "render": lambda: _render_overlay(src, body)}[action]
        result = await asyncio.get_running_loop().run_in_executor(_POOL, fn)
        if action == "render":
            return web.Response(body=result, content_type="image/png", headers={"Cache-Control": "no-store"})
        return web.json_response(result)
    except FileExistsError as e:
        return web.json_response({"error": str(e)}, status=409)
    except FileNotFoundError:
        return web.json_response({"error": "图片不存在"}, status=404)
    except (ValueError, TypeError, KeyError, UnicodeDecodeError):
        return web.json_response({"error": "遮蔽记录或图片无效"}, status=400)
    except OSError:
        return web.json_response({"error": "无法读取或保存遮蔽，请重试"}, status=500)


@PromptServer.instance.routes.get("/mediabrowser/overlay")
async def mediabrowser_overlay_get(request):
    return await _overlay_request(request, "read")


@PromptServer.instance.routes.post("/mediabrowser/overlay")
async def mediabrowser_overlay_post(request):
    return await _overlay_request(request, "save")


@PromptServer.instance.routes.post("/mediabrowser/render")
async def mediabrowser_render(request):
    return await _overlay_request(request, "render")


def _purge_dir(root: str) -> int:
    """清理插件缓存目录中的文件和空子目录，保留根目录。"""
    root = os.path.abspath(root)
    n = 0
    if not os.path.isdir(root):
        return 0
    # topdown=False：先走最深一层。回到上层时它已经空了，rmdir 才删得掉。
    for dirpath, _dns, filenames in os.walk(root, topdown=False):
        here = os.path.abspath(dirpath)
        if here != root and not here.startswith(root + os.sep):
            continue
        for name in filenames:
            try:
                os.remove(os.path.join(dirpath, name))
                n += 1
            except OSError:
                pass
        if here != root:
            try:
                os.rmdir(here)      # 只删空的；里面还有东西会抛 OSError，正好跳过
            except OSError:
                pass
    return n


# 缩略图统计按尺寸区分生成与命中，用于定位首次生成成本。
# 按**尺寸档**分开记：640 和 1536 的成本差一个量级，混在一起的均值没有意义。
_THUMB_STATS: dict[int, dict] = {}
_THUMB_LOG_EVERY = 60          # 每这么多次生成打一行汇总，别把日志刷爆


def _note_thumb(px: int, sec: float, hit: bool) -> None:
    """记一次缩略图请求。hit=True 是命中缓存（没真生成，sec 不计入）。"""
    rec = _THUMB_STATS.setdefault(px, {"gen": 0, "hit": 0, "sec": 0.0, "max": 0.0})
    if hit:
        rec["hit"] += 1
        return
    rec["gen"] += 1
    rec["sec"] += sec
    if sec > rec["max"]:
        rec["max"] = sec


def _thumb_stats_line() -> str:
    """一行人能读的汇总，按档从小到大。"""
    parts = []
    for px in sorted(_THUMB_STATS):
        r = _THUMB_STATS[px]
        avg = (r["sec"] / r["gen"]) if r["gen"] else 0.0
        parts.append(f"{px}px 生成{r['gen']}/命中{r['hit']} 均{avg * 1000:.0f}ms 最慢{r['max'] * 1000:.0f}ms")
    return "[MediaBrowser] 缩略图 " + " | ".join(parts) if parts else "[MediaBrowser] 缩略图 暂无数据"


def _is_thumb_file(name: str) -> bool:
    """排除尺寸/耗时索引和 .part 临时文件；同时用于缓存用量和缩略图清理。"""
    return not name.startswith(("_dims", "_elapsed")) and ".part" not in name


def _cache_usage() -> dict:
    """统计两份缓存的数量、字节数和淘汰上限。必须在线程池调用。"""
    def stat_dir(d: str) -> tuple[int, int]:
        n = total = 0
        try:
            for e in os.scandir(d):
                if not e.is_file() or not _is_thumb_file(e.name):
                    continue
                n += 1
                try:
                    total += e.stat().st_size
                except OSError:
                    pass
        except OSError:
            pass
        return n, total

    tn, tb = stat_dir(CACHE_DIR)
    rn, rb = stat_dir(REGIONS_DIR)
    # 上限的真相源在 censor.py（淘汰逻辑在那儿）。这里读它，不要照抄一个数字过来：
    # 两份数字迟早漂移，而界面上写着的那个才是用户信的。
    # censor 是按文件路径动态加载的，可能加载失败 —— 那种情况给 0，
    # 前端据此不显示上限（不知道就别编一个）。
    cap_regions = getattr(_censor, "_REGIONS_MAX_FILES", 0) if _censor else 0
    return {
        "thumbs": {"n": tn, "cap": _THUMB_MAX_FILES, "bytes": tb},
        "regions": {"n": rn, "cap": cap_regions, "bytes": rb},
    }


def _purge_what(what: str) -> dict:
    """清插件自己的磁盘缓存。不碰用户成片，不删 _models。"""
    global _DIMS, _DIMS_DIRTY, _ELAPSED_EPOCH
    if what not in ("thumbs", "regions", "disk"):
        raise ValueError("未知清理项")
    out = {"thumbs": 0, "regions": 0, "index": False}
    if what in ("thumbs", "disk"):
        n = 0
        if os.path.isdir(CACHE_DIR):
            for e in os.scandir(CACHE_DIR):
                if not e.is_file():
                    continue
                # 两个索引都住在缩略图缓存目录里，但它们不是缩略图 ——
                # 清封面时不该连耗时和尺寸一起清掉。
                if what == "thumbs" and not _is_thumb_file(e.name):
                    continue
                try:
                    os.remove(e.path)
                    n += 1
                except OSError:
                    pass
        out["thumbs"] = n
        _LIST_CACHE.clear()
    if what == "disk":
        _DIMS = {}
        _DIMS_DIRTY = False
        try:
            os.remove(DIM_INDEX)
        except OSError:
            pass
        # 耗时索引跟尺寸索引同类，一起清 —— 漏了的话「清空」之后它还在，
        # 而用户看不出残留在哪
        with _ELAPSED_LOCK:
            _ELAPSED_EPOCH += 1
            globals()["_ELAPSED"] = {}
            globals()["_ELAPSED_DIRTY"] = False
            try:
                os.remove(ELAPSED_INDEX)
            except OSError:
                pass
        out["index"] = True
        _LIST_CACHE.clear()
    if what in ("regions", "disk"):
        out["regions"] = _purge_dir(REGIONS_DIR)
    return out


@PromptServer.instance.routes.post("/mediabrowser/purge")
async def mediabrowser_purge(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        return web.json_response({"error": "JSON 对象"}, status=400)
    what = str(body.get("what") or "").strip()
    try:
        data = await asyncio.get_running_loop().run_in_executor(_POOL, _purge_what, what)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    # 把清完的新用量一起带回去：用户唯一能验证「真清掉了」的地方就是那个数字，
    # 只给一句 toast 等于让他信我们。
    usage = await asyncio.get_running_loop().run_in_executor(_POOL, _cache_usage)
    return web.json_response({"ok": True, **data, "usage": usage})


@PromptServer.instance.routes.get("/mediabrowser/usage")
async def mediabrowser_usage(request):
    """缓存用量。单独一个接口，不并进 censor/status —— 那个在下载模型时
    每 600ms 轮一次，而这里要 scandir 两个目录（缩略图上限 8000 个）。"""
    data = await asyncio.get_running_loop().run_in_executor(_POOL, _cache_usage)
    return web.json_response(data)


__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
