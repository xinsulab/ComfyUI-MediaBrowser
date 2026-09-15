"""首屏路径只读首段缺失尺寸；列表命中不应继续扫描后面的文件。"""
from unittest.mock import patch
import test_mediabrowser as base


def test_foreground_does_not_chase_later_index_misses():
    mb = base.mb
    files = [{"p": f"{i}.png", "a": f"{i}.png", "t": 10, "s": 1, "n": 10} for i in range(8)]
    cached = {f"{i}.png": [100, 200, 10, 0, 0, 0] for i in [0, 1, 7]}
    with patch.object(mb, '_DIMS', cached), patch.object(mb, '_save_dims'), \
         patch.object(mb, '_png_text') as legacy, patch.object(mb, '_dim_of') as dimensions:
        got = mb._fill_dims(files, 2, foreground=True)
    dimensions.assert_not_called()
    legacy.assert_not_called()
    assert set(got['dims']) == {'0.png', '1.png', '7.png'}


def test_foreground_reads_missing_first_items():
    mb = base.mb
    files = [{"p": "first.png", "a": "first.png", "t": 10, "s": 1, "n": 10}]
    with patch.object(mb, '_DIMS', {}), patch.object(mb, '_save_dims'), \
         patch.object(mb, '_dim_of', return_value=[100,200,0]) as dimensions:
        got = mb._fill_dims(files, 2, foreground=True)
    dimensions.assert_called_once_with('first.png', 'first.png', 10)
    assert got['dims']['first.png'] == [100,200,0]


def test_repeated_prewarm_does_not_queue_duplicate_work():
    import asyncio
    import threading
    mb = base.mb
    entered, release = threading.Event(), threading.Event()
    calls = []

    def work():
        calls.append(threading.current_thread().name)
        entered.set()
        release.wait(3)

    async def run():
        loop = asyncio.get_running_loop()
        try:
            mb._spawn_bg(loop, work, coalesce=True)
            assert await asyncio.to_thread(entered.wait, 2)
            mb._spawn_bg(loop, work, coalesce=True)
            assert len(calls) == 1
        finally:
            release.set()
        for _ in range(100):
            if work not in mb._BACKGROUND_JOBS:
                break
            await asyncio.sleep(.01)
        assert work not in mb._BACKGROUND_JOBS

    asyncio.run(run())
    assert calls[0].startswith('mediabrowser-index')
