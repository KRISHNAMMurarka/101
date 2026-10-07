"""Bounded read-only contents gate for the seven ordinary 101 SDK packages.

Uses public standard-library gzip/tar parsers without extraction or execution.
The selected portable npm profile has plain contiguous headers. Future extended
archive formats fail closed after the complete decoded bytes have been scanned.
"""

import gzip
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import tarfile
import zlib


PROFILE = "sdk-content-audit/1"
NAMES = ("@101/device-model", "@101/device-runtime", "@101/transport-webrtc",
         "@101/transport-websocket", "@101/device-web", "@101/vision", "@101/connect")
LIMITS = {"manifestBytes": 1048576, "sourcePins": 512, "packages": 7,
          "filesPerPackage": 256, "membersPerPackage": 512, "pathBytes": 512,
          "compressedTarBytes": 2097152, "decodedTarBytes": 16777216,
          "fileBytes": 2097152, "chunkBytes": 65536, "receiptBytes": 1048576,
          "workspaceVariants": 4, "toolBytes": 1048576, "packageJsonBytes": 131072}
SHA = re.compile(r"^[0-9a-f]{64}$")
TREE = re.compile(r"^[0-9a-f]{40}$")
VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
PUBLIC = re.compile(r"^(?:dist/[^/]+\.(?:js|d\.ts)|schema/device-descriptor\.json|examples/[^/]+\.(?:js|ts|d\.ts))$")
TELEMETRY = "examples/telemetry-owner.mjs"
PRIVATE_NAME = re.compile(r"^(?:\.env(?:\..*)?|\.npmrc|\.git|\.ssh|node_modules|receipts|credentials?\.json|secrets?\.json|google-services\.json|GoogleService-Info\.plist)$", re.IGNORECASE)
PRIVATE_EXTENSION = re.compile(r"\.(?:pem|p12|mobileprovision|key|jks|keystore|pfx)$", re.IGNORECASE)
PRIVATE_KEY = re.compile(br"-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----")
TEMPORARY_SOURCE = b"101-sdk-source-"


class Refusal(Exception):
    def __init__(self, reason, package=None, ordinal=None, marker=None, name=None):
        super().__init__(reason)
        self.reason = reason
        self.location = {}
        if package in NAMES:
            self.location["package"] = package
        if type(ordinal) is int and 0 <= ordinal < LIMITS["membersPerPackage"]:
            self.location["memberOrdinal"] = ordinal
        if marker in ("private-key", "workspace-root", "producer-temporary-source"):
            self.location["marker"] = marker
        if isinstance(name, str):
            self.location["memberPathSha256"] = digest(name.encode("utf-8", errors="replace"))


def require(condition, reason, **location):
    if not condition:
        raise Refusal(reason, **location)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def number(value, maximum, minimum=0):
    require(type(value) is int and value >= minimum, "unsupported-schema")
    require(value <= maximum, "limit-exceeded")
    return value


def sha(value):
    require(isinstance(value, str) and SHA.fullmatch(value), "unsupported-schema")
    return value


def text(value, maximum, reason="unsupported-schema"):
    require(isinstance(value, str) and 0 < len(value.encode("utf-8")) <= maximum
            and not any(ord(c) < 32 or ord(c) == 127 for c in value), reason)
    return value


def parse_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "unsupported-schema")
            result[key] = value
        return result

    def constant(_value):
        raise Refusal("unsupported-schema")

    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    except Refusal:
        raise
    except (ValueError, UnicodeError, RecursionError):
        raise Refusal("unsupported-schema") from None


def arguments(values):
    flags = {"--manifest", "--manifest-sha256", "--artifact-root", "--source-tree",
             "--audit-tool-sha256", "--output"}
    result = {"workspace_roots": []}
    require(len(values) % 2 == 0 and len(values) <= 20, "invalid-arguments")
    for index in range(0, len(values), 2):
        flag, value = values[index:index + 2]
        text(value, 2048, "invalid-arguments")
        if flag == "--workspace-root":
            result["workspace_roots"].append(value)
        else:
            require(flag in flags and flag not in result, "invalid-arguments")
            result[flag] = value
    require(flags.issubset(result), "invalid-arguments")
    require(SHA.fullmatch(result["--manifest-sha256"])
            and SHA.fullmatch(result["--audit-tool-sha256"])
            and TREE.fullmatch(result["--source-tree"]), "invalid-arguments")
    require(1 <= len(result["workspace_roots"]) <= LIMITS["workspaceVariants"], "invalid-arguments")
    for flag in ("--manifest", "--artifact-root", "--output"):
        require(os.path.isabs(result[flag]), "invalid-arguments")
    return result


def workspace_variants(roots):
    values = set()
    for root in roots:
        require(os.path.isabs(root), "invalid-arguments")
        logical = os.path.abspath(root)
        require(logical != os.path.sep, "invalid-arguments")
        try:
            real = os.path.realpath(logical, strict=True)
            require(Path(real).is_dir(), "invalid-arguments")
        except OSError:
            raise Refusal("invalid-arguments") from None
        values.update((logical, real))
    require(len(values) <= LIMITS["workspaceVariants"], "invalid-arguments")
    return tuple(value.encode("utf-8") for value in sorted(values))


def ordinary_root(value):
    path = Path(os.path.abspath(value))
    try:
        require(stat.S_ISDIR(path.lstat().st_mode), "unsafe-file")
        return path.resolve(strict=True)
    except OSError:
        raise Refusal("unsafe-file") from None


def under_root(base, relative):
    path = base
    try:
        for part in relative.split("/"):
            path = path / part
            require(not stat.S_ISLNK(path.lstat().st_mode), "unsafe-file")
        require(path.resolve(strict=True).is_relative_to(base), "unsafe-file")
    except OSError:
        raise Refusal("unsafe-file") from None
    return path


def regular_bytes(path, maximum):
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode), "unsafe-file")
        number(before.st_size, maximum)
        result = bytearray()
        while True:
            chunk = os.read(descriptor, LIMITS["chunkBytes"])
            if not chunk:
                break
            require(len(result) + len(chunk) <= maximum, "limit-exceeded")
            result.extend(chunk)
        after = os.fstat(descriptor)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), "artifact-integrity")
        require(len(result) == before.st_size, "artifact-integrity")
        current = path.lstat()
        require((current.st_dev, current.st_ino) == (before.st_dev, before.st_ino)
                and stat.S_ISREG(current.st_mode), "artifact-integrity")
        return bytes(result)
    except OSError:
        raise Refusal("unsafe-file") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def path_name(value, directory=False):
    require(isinstance(value, str), "unsafe-archive")
    require(len(value.encode("utf-8")) <= LIMITS["pathBytes"], "limit-exceeded")
    if directory and value.endswith("/"):
        value = value[:-1]
    require(value and not value.startswith("/") and not re.match(r"^[A-Za-z]:", value)
            and "\\" not in value and not any(ord(c) < 32 or ord(c) == 127 for c in value)
            and all(part not in ("", ".", "..") for part in value.split("/")), "unsafe-archive")
    return value


def private_path(value):
    return any(PRIVATE_NAME.fullmatch(part) or PRIVATE_EXTENSION.search(part) for part in value.split("/"))


def public_path(value, package):
    return value in ("LICENSE", "README.md", "package.json") or bool(PUBLIC.fullmatch(value)) or (package == "@101/connect" and value == TELEMETRY)


class ContentScanner:
    def __init__(self, roots, package):
        self.roots = roots
        self.package = package
        self.tail = b""
        self.overlap = max([64, len(TEMPORARY_SOURCE)] + [len(root) for root in roots]) - 1

    def feed(self, chunk):
        data = self.tail + chunk
        marker = None
        if PRIVATE_KEY.search(data):
            marker = "private-key"
        elif any(root in data for root in self.roots):
            marker = "workspace-root"
        elif TEMPORARY_SOURCE in data:
            marker = "producer-temporary-source"
        if marker:
            raise Refusal("private-content", package=self.package, marker=marker)
        self.tail = data[-self.overlap:]


def scan_bytes(data, roots, package):
    scanner = ContentScanner(roots, package)
    for index in range(0, len(data), LIMITS["chunkBytes"]):
        scanner.feed(data[index:index + LIMITS["chunkBytes"]])


def validate_manifest(manifest, source_tree):
    require(isinstance(manifest, dict) and set(manifest) == {"schemaVersion", "source", "environment", "builderSha256", "outputDir", "packages"}, "unsupported-schema")
    require(type(manifest["schemaVersion"]) is int and manifest["schemaVersion"] == 1, "unsupported-schema")
    source = manifest["source"]
    require(isinstance(source, dict) and set(source) == {"revision", "tree", "sha256"}, "unsupported-schema")
    require(isinstance(source["tree"], str) and TREE.fullmatch(source["tree"]), "unsupported-schema")
    require(source["tree"] == source_tree, "source-identity")
    require(source["revision"] is None or isinstance(source["revision"], str) and TREE.fullmatch(source["revision"]), "unsupported-schema")
    require(isinstance(source["sha256"], dict), "unsupported-schema")
    number(len(source["sha256"]), LIMITS["sourcePins"], 1)
    for path, value in source["sha256"].items():
        path_name(path)
        sha(value)
    environment = manifest["environment"]
    require(isinstance(environment, dict) and set(environment) == {"node", "npm", "typescript"}, "unsupported-schema")
    for value in environment.values():
        require(isinstance(value, str) and VERSION.fullmatch(value), "unsupported-schema")
    sha(manifest["builderSha256"])
    original_root = text(manifest["outputDir"], 2048)
    require(os.path.isabs(original_root) and original_root == os.path.abspath(original_root), "unsupported-schema")
    records = manifest["packages"]
    require(isinstance(records, list) and len(records) == len(NAMES), "unsupported-schema")
    by_name = {}
    for record in records:
        require(isinstance(record, dict) and set(record) == {"name", "version", "license", "directory", "tarball", "sha256", "bytes", "files"}, "unsupported-schema")
        name = record["name"]
        require(isinstance(name, str) and name in NAMES and name not in by_name, "unsupported-schema")
        require(isinstance(record["version"], str) and VERSION.fullmatch(record["version"])
                and record["license"] == "MIT", "unsupported-schema")
        require(record["directory"] == os.path.join(original_root, "packages", name[5:]), "unsupported-schema")
        relative = "tarballs/" + name[1:].replace("/", "-") + "-" + record["version"] + ".tgz"
        require(record["tarball"] == os.path.join(original_root, relative), "unsupported-schema")
        sha(record["sha256"])
        number(record["bytes"], LIMITS["compressedTarBytes"], 1)
        require(isinstance(record["files"], list), "unsupported-schema")
        number(len(record["files"]), LIMITS["filesPerPackage"], 1)
        inventory = {}
        for file in record["files"]:
            require(isinstance(file, dict) and set(file) == {"path", "size", "sha256"}, "unsupported-schema")
            path = path_name(file["path"])
            require(path not in inventory and public_path(path, name), "unsupported-schema")
            number(file["size"], LIMITS["fileBytes"])
            sha(file["sha256"])
            inventory[path] = file
        required = {"LICENSE", "README.md", "package.json", "dist/index.js", "dist/index.d.ts"}
        if name in ("@101/device-model", "@101/connect"):
            required.add("schema/device-descriptor.json")
        if name == "@101/connect":
            required.update(("examples/run.js", "examples/run.d.ts", "examples/run.ts"))
        require(required.issubset(inventory), "inventory-mismatch", package=name)
        by_name[name] = (record, relative, inventory)
    return by_name


def decoded_tar(compressed):
    result = bytearray()
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode="rb") as stream:
            while True:
                chunk = stream.read(LIMITS["chunkBytes"])
                if not chunk:
                    break
                require(len(result) + len(chunk) <= LIMITS["decodedTarBytes"], "limit-exceeded")
                result.extend(chunk)
    except (OSError, EOFError, ValueError, zlib.error):
        raise Refusal("archive-corrupt") from None
    return bytes(result)


def inspect_tar(compressed, inventory, roots, package):
    data = decoded_tar(compressed)
    # Scan every physical header, extension body, payload, padding and trailer
    # before tarfile can normalize or discard any part of the archive.
    scan_bytes(data, roots, package)
    ancestors = {"package"}
    for path in inventory:
        parts = ("package/" + path).split("/")
        ancestors.update("/".join(parts[:index]) for index in range(1, len(parts)))
    seen, found, last_end, metadata = set(), set(), 0, None
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r|") as archive:
            for ordinal, member in enumerate(archive):
                require(ordinal < LIMITS["membersPerPackage"], "limit-exceeded", package=package)
                # Public offsets expose consumed GNU/PAX extensions without a
                # custom archive decoder. Current observed npm7.5.7 is plain.
                require(member.offset == last_end and member.offset_data == member.offset + 512
                        and not member.pax_headers, "unsafe-archive", package=package, ordinal=ordinal)
                name = path_name(member.name, member.isdir())
                require(name not in seen, "unsafe-archive", package=package, ordinal=ordinal, name=name)
                seen.add(name)
                require(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE), "unsafe-archive", package=package, ordinal=ordinal, name=name)
                require(member.uid == 0 and member.gid == 0 and member.uname == "" and member.gname == ""
                        and member.linkname == "" and isinstance(member.mtime, (int, float))
                        and math.isfinite(member.mtime) and member.mode in (0o644, 0o755), "unsafe-archive", package=package, ordinal=ordinal)
                if member.isdir():
                    require(name in ancestors and member.size == 0, "undeclared-file", package=package, ordinal=ordinal, name=name)
                else:
                    require(not private_path(name), "private-file", package=package, ordinal=ordinal, name=name)
                    require(name.startswith("package/"), "unsafe-archive", package=package, ordinal=ordinal, name=name)
                    path = name[len("package/"):]
                    require(path in inventory, "undeclared-file", package=package, ordinal=ordinal, name=name)
                    number(member.size, LIMITS["fileBytes"])
                    require(member.size == inventory[path]["size"], "artifact-integrity", package=package, ordinal=ordinal)
                    stream = archive.extractfile(member)
                    require(stream is not None, "archive-corrupt", package=package)
                    total, hasher = 0, hashlib.sha256()
                    capture = bytearray() if path == "package.json" else None
                    if capture is not None:
                        number(member.size, LIMITS["packageJsonBytes"])
                    scanner = ContentScanner(roots, package)
                    with stream:
                        while True:
                            chunk = stream.read(LIMITS["chunkBytes"])
                            if not chunk:
                                break
                            total += len(chunk)
                            require(total <= member.size, "archive-corrupt", package=package)
                            scanner.feed(chunk)
                            hasher.update(chunk)
                            if capture is not None:
                                capture.extend(chunk)
                    require(total == member.size and hasher.hexdigest() == inventory[path]["sha256"], "artifact-integrity", package=package, ordinal=ordinal)
                    found.add(path)
                    if capture is not None:
                        metadata = parse_json(capture)
                last_end = member.offset_data + ((member.size + 511) // 512) * 512
    except (tarfile.TarError, OSError, EOFError, ValueError):
        raise Refusal("archive-corrupt", package=package) from None
    require(found == set(inventory), "inventory-mismatch", package=package)
    require(last_end <= len(data) - 1024 and not any(data[last_end:]), "archive-corrupt", package=package)
    return metadata


def package_metadata(metadata, record, inventory, records):
    require(isinstance(metadata, dict), "unsupported-schema")
    keys = {"name", "version", "description", "type", "license", "repository", "engines", "types", "exports", "files"}
    require(keys.issubset(metadata) and set(metadata).issubset(keys | {"dependencies"}), "unsupported-schema")
    require(metadata["name"] == record["name"] and metadata["version"] == record["version"]
            and metadata["type"] == "module" and metadata["license"] == "MIT"
            and metadata["types"] == "./dist/index.d.ts", "inventory-mismatch", package=record["name"])
    require(metadata["repository"] == {"type": "git", "url": "https://github.com/KRISHNAMMurarka/101.git"}
            and metadata["engines"] == {"node": ">=22.13.0"}, "unsupported-schema")
    text(metadata["description"], 1024)
    dependencies = metadata.get("dependencies", {})
    require(isinstance(dependencies, dict) and len(dependencies) <= len(NAMES), "unsupported-schema")
    for name, version in dependencies.items():
        require(name in records and version == records[name][0]["version"], "inventory-mismatch", package=record["name"])
    declared = ["dist", "LICENSE", "README.md"]
    if record["name"] in ("@101/device-model", "@101/connect"):
        declared.append("schema")
    if record["name"] == "@101/connect":
        declared.append("examples")
    require(metadata["files"] == declared, "inventory-mismatch", package=record["name"])
    exports = metadata["exports"]
    require(isinstance(exports, dict) and 1 <= len(exports) <= LIMITS["filesPerPackage"], "unsupported-schema")
    require(exports.get(".") == {"types": "./dist/index.d.ts", "import": "./dist/index.js"}, "inventory-mismatch", package=record["name"])
    for subpath, target in exports.items():
        if subpath == ".":
            continue
        if subpath == "./schema/device-descriptor.json":
            require(record["name"] in ("@101/device-model", "@101/connect") and target == "./schema/device-descriptor.json", "inventory-mismatch", package=record["name"])
        elif subpath == "./examples/telemetry-owner":
            require(record["name"] == "@101/connect" and target == "./" + TELEMETRY, "inventory-mismatch", package=record["name"])
        else:
            require(record["name"] == "@101/connect" and re.fullmatch(r"\./examples/[a-z0-9-]+", subpath), "unsupported-schema")
            base = subpath[len("./"):]
            require(target == {"types": "./" + base + ".d.ts", "import": "./" + base + ".js"}
                    and base + ".ts" in inventory, "inventory-mismatch", package=record["name"])
        targets = [target] if isinstance(target, str) else list(target.values()) if isinstance(target, dict) else []
        require(targets and all(isinstance(value, str) and value.startswith("./") and value[2:] in inventory for value in targets), "inventory-mismatch", package=record["name"])
    schema = "./schema/device-descriptor.json"
    if record["name"] in ("@101/device-model", "@101/connect"):
        require(schema in exports, "inventory-mismatch", package=record["name"])
    require((TELEMETRY in inventory) == ("./examples/telemetry-owner" in exports), "inventory-mismatch", package=record["name"])


def audit(options):
    roots = workspace_variants(options["workspace_roots"])
    base = ordinary_root(options["--artifact-root"])
    manifest_path = Path(os.path.abspath(options["--manifest"]))
    require(manifest_path.name == "manifest.json" and manifest_path.parent.resolve(strict=True) == base, "unsafe-file")
    manifest_bytes = regular_bytes(under_root(base, "manifest.json"), LIMITS["manifestBytes"])
    require(digest(manifest_bytes) == options["--manifest-sha256"], "artifact-integrity")
    manifest = parse_json(manifest_bytes)
    records = validate_manifest(manifest, options["--source-tree"])
    results = []
    for package in NAMES:
        record, relative, inventory = records[package]
        compressed = regular_bytes(under_root(base, relative), LIMITS["compressedTarBytes"])
        require(len(compressed) == record["bytes"] and digest(compressed) == record["sha256"], "artifact-integrity", package=package)
        scan_bytes(compressed, roots, package)
        metadata = inspect_tar(compressed, inventory, roots, package)
        package_metadata(metadata, record, inventory, records)
        results.append({"name": package, "files": len(inventory), "bytes": sum(file["size"] for file in inventory.values()),
                        "tarballSha256": record["sha256"],
                        "inventorySha256": digest(json.dumps(record["files"], sort_keys=True, separators=(",", ":")).encode())})
    # Re-read the immutable manifest identity after the complete sequential audit.
    require(digest(regular_bytes(under_root(base, "manifest.json"), LIMITS["manifestBytes"])) == options["--manifest-sha256"], "artifact-integrity")
    return {"artifacts": results, "files": sum(item["files"] for item in results)}


def output_path(value):
    path = Path(os.path.abspath(value))
    require(not os.path.lexists(path), "output-exists")
    try:
        parent = path.parent.resolve(strict=True)
        require(parent.is_dir(), "unsafe-file")
        return parent / path.name
    except OSError:
        raise Refusal("unsafe-file") from None


def write_output(path, data):
    descriptor = None
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            stream.write(data)
    except FileExistsError:
        raise Refusal("output-exists") from None
    except OSError:
        raise Refusal("unsafe-file") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def main(values):
    report = {"schemaVersion": 1, "auditProfile": PROFILE, "result": "fail", "reason": "unavailable",
              "sdkManifestSha256": None, "sourceTree": None, "toolSha256": None, "limits": LIMITS,
              "productPayloadExecution": False, "decoderOrAbiQualification": False, "releaseAccepted": False}
    output = None
    try:
        options = arguments(values)
        report["sdkManifestSha256"] = options["--manifest-sha256"]
        report["sourceTree"] = options["--source-tree"]
        tool_sha = digest(regular_bytes(Path(__file__), LIMITS["toolBytes"]))
        report["toolSha256"] = tool_sha
        output = output_path(options["--output"])
        require(tool_sha == options["--audit-tool-sha256"], "tool-identity")
        report.update(audit(options))
        report.update(result="pass", reason="ok")
    except Refusal as refusal:
        report["reason"] = refusal.reason
        if refusal.location:
            report["finding"] = refusal.location
    except Exception:
        # Do not serialize raw exceptions, caller roots, payloads or metadata.
        report["reason"] = "unavailable"
    data = (json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if len(data) > LIMITS["receiptBytes"]:
        report = {"schemaVersion": 1, "auditProfile": PROFILE, "result": "fail", "reason": "limit-exceeded",
                  "sdkManifestSha256": report["sdkManifestSha256"], "sourceTree": report["sourceTree"],
                  "toolSha256": report["toolSha256"], "releaseAccepted": False}
        data = (json.dumps(report, sort_keys=True) + "\n").encode()
    if output is not None:
        try:
            write_output(output, data)
        except Refusal as refusal:
            report.update(result="fail", reason=refusal.reason)
            data = (json.dumps(report, sort_keys=True) + "\n").encode()
    try:
        sys.stdout.buffer.write(data)
    except OSError:
        return 1
    return 0 if report["result"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
