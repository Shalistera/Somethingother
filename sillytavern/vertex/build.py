"""Build the two-part install archive without user data or local settings."""
from pathlib import Path
import json
import zipfile

repo = Path(__file__).resolve().parents[2]
version = json.loads((repo / 'package.json').read_text())['version']
destination = repo / 'sillytavern' / f'vertex-native-v{version}.zip'
common = ['package.json', 'manifest.json', 'index.js', 'sillytavern/LICENSE']
server_files = common + [
    'sillytavern/vertex/INSTALL.txt',
    'sillytavern/vertex-text.patch',
    'sillytavern/sillytavern-stream-debug.patch',
] + [str(p.relative_to(repo)) for p in (repo / 'sillytavern/vertex/server').iterdir() if p.is_file()]
front_files = common + [str(p.relative_to(repo)) for p in (repo / 'sillytavern/vertex/frontend').iterdir() if p.is_file()]

with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for prefix, files in [
        ('plugins/vertex-native', server_files),
        ('public/scripts/extensions/third-party/Somethingother', front_files),
    ]:
        for relative in sorted(files):
            info = zipfile.ZipInfo(f'{prefix}/{relative}', date_time=(2026, 10, 19, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, (repo / relative).read_bytes())
print(destination)
