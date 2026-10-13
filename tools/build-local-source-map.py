"""Rebuild the ordinary local source-map-js dependency archive deterministically."""
from pathlib import Path
import gzip
import io
import json
import os
import stat
import sys
import tarfile
import tempfile

if len(sys.argv) != 1:
    raise SystemExit("Usage: python3 tools/build-local-source-map.py")

root = Path(__file__).resolve().parent.parent
source = root / "vendor/source-map-js"
target = root / "vendor/source-map-js-1.2.2+101.1.tgz"
files = []
total = 0

def collect(directory, depth=0):
    global total
    state = directory.lstat()
    if not stat.S_ISDIR(state.st_mode) or directory.is_symlink() or depth > 2:
        raise ValueError("Local archive requires ordinary bounded source directories")
    entries = sorted(directory.iterdir())
    if len(entries) > 64:
        raise ValueError("Local archive directory limit exceeded")
    for path in entries:
        state = path.lstat()
        if stat.S_ISDIR(state.st_mode):
            collect(path, depth + 1)
            continue
        if not stat.S_ISREG(state.st_mode) or path.is_symlink() or state.st_size > 131072:
            raise ValueError("Local archive requires ordinary bounded source files")
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
            opened = os.fstat(stream.fileno())
            data = stream.read(131073)
            after = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size) != (state.st_dev, state.st_ino, state.st_size):
            raise ValueError("Local source changed before reading")
        if after.st_size != len(data) or after.st_mtime_ns != opened.st_mtime_ns or after.st_ctime_ns != opened.st_ctime_ns:
            raise ValueError("Local source changed during reading")
        total += len(data)
        files.append((path.relative_to(source).as_posix(), data))
        if len(files) > 64 or total > 1048576:
            raise ValueError("Local archive source limits exceeded")

collect(source)
meta = json.loads(dict(files)["package.json"])
if meta["name"] != "source-map-js" or meta["version"] != "1.2.2+101.1" or meta.get("private") is not True:
    raise ValueError("Unexpected local dependency identity")

payload = io.BytesIO()
with tarfile.open(fileobj=payload, mode="w", format=tarfile.USTAR_FORMAT) as archive:
    for name, data in sorted(files):
        entry = tarfile.TarInfo("package/" + name)
        entry.size = len(data)
        entry.mode = 0o644
        entry.mtime = entry.uid = entry.gid = 0
        entry.uname = entry.gname = ""
        archive.addfile(entry, io.BytesIO(data))

temporary = None
try:
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".101-source-map-", delete=False) as stream:
        temporary = Path(stream.name)
        with gzip.GzipFile(filename="", mode="wb", fileobj=stream, mtime=0) as compressed:
            compressed.write(payload.getvalue())
    temporary.replace(target)
finally:
    if temporary is not None:
        temporary.unlink(missing_ok=True)
print(json.dumps({"archive": str(target.relative_to(root)), "files": len(files), "sourceBytes": total}))
