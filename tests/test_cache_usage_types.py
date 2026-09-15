import tempfile
from pathlib import Path
from unittest.mock import patch
import test_mediabrowser as base

def test_usage_counts_each_cache_format():
    with tempfile.TemporaryDirectory() as d:
        thumbs, regions = Path(d)/'thumbs', Path(d)/'regions'
        thumbs.mkdir(); regions.mkdir()
        (thumbs/'a.webp').write_bytes(b'123')
        (thumbs/'_dims.json').write_bytes(b'{}')
        (regions/'a.json').write_bytes(b'{}')
        (regions/'a.json.part').write_bytes(b'123')
        with patch.object(base.mb, 'CACHE_DIR', str(thumbs)), patch.object(base.mb, 'REGIONS_DIR', str(regions)):
            usage = base.mb._cache_usage()
        assert usage['thumbs']['n'] == 1
        assert usage['regions']['n'] == 1
        assert usage['regions']['bytes'] == 2
