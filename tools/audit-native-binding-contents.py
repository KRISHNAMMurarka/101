"""Read-only, manifest-bound content audit for normalized-pointer native bindings.

This checks packaged content, not binary semantics, ABI, signing or installation.
Only the explicit receipt is written. No archive member is extracted or executed.
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
import zipfile
import zlib


PROFILE = "normalized-pointer-bindings/1"
AUDIT_PROFILE = "native-binding-content-audit/1"
LANGUAGES = ("swift", "kotlin", "c")
TARGETS = ["swift-macos-arm64", "c-macos-arm64", "kotlin-jvm-jdk21"]
EXCLUSIONS = ["native-runtime-lifecycle", "resource-grants", "identity",
              "transport-authentication", "physical-effects", "ios", "android",
              "cross-toolchain-abi", "public-distribution"]
COMMON_FILES = {"LICENSE", "artifact.json", "assets/device-descriptor.schema.json",
                "assets/normalized-pointer-v1.json", "assets/profile.json",
                "examples/normalized-pointer.mjs"}
EXTRA_FILES = {
    "swift": {"examples/PointerConsumer.swift", "lib/One01PointerWire.abi.json",
              "lib/One01PointerWire.swiftdoc", "lib/One01PointerWire.swiftmodule",
              "lib/libOne01PointerWire.dylib",
              "source/Package.swift", "source/Sources/One01PointerWire/PointerWire.swift",
              "source/Tests/One01PointerWireTests/PointerWireTests.swift"},
    "kotlin": {"examples/PointerConsumer.kt", "lib/one01-pointer-wire.jar", "source/PointerWire.kt"},
    "c": {"examples/pointer-consumer.c", "include/one01_pointer_wire.h",
          "lib/libone01_pointer_wire.a", "source/one01_pointer_wire.c"},
}
JAR_FILES = {"META-INF/MANIFEST.MF", "META-INF/main.kotlin_module",
             "com/oneohone/pointerwire/PointerLane.class",
             "com/oneohone/pointerwire/PointerSample.class",
             "com/oneohone/pointerwire/PointerWire.class"}
PRODUCER_PATHS = {"packages/device-web/src/wire.ts", "packages/device-web/src/binding.ts",
                  "packages/device-web/src/pointer-provider.ts", "packages/device-model/src/input-profile.ts"}
LIMITS = {"manifestBytes": 1048576, "filesPerLanguage": 64, "tarMembers": 128,
          "pathBytes": 512, "compressedTarBytes": 2097152, "decodedTarBytes": 16777216,
          "fileBytes": 4194304, "jarBytes": 1048576, "jarEntries": 64,
          "jarDecodedBytes": 4194304, "metadataBytes": 4096, "chunkBytes": 65536,
          "receiptBytes": 1048576, "workspaceVariants": 4}
SHA256 = re.compile(r"^[0-9a-f]{64}$")
TREE = re.compile(r"^[0-9a-f]{40}$")
PRIVATE_NAME = re.compile(
    r"^(?:\.env(?:\..*)?|\.npmrc|\.git|\.ssh|node_modules|receipts|credentials?\.json|"
    r"secrets?\.json|google-services\.json|GoogleService-Info\.plist)$", re.IGNORECASE)
PRIVATE_EXTENSION = re.compile(r"\.(?:pem|p12|mobileprovision|key|jks|keystore|pfx)$", re.IGNORECASE)
PRIVATE_KEY = re.compile(br"-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----")
TEMPORARY_SOURCE = b"101-pointer-source-"


class Refusal(Exception):
    def __init__(self, reason, language=None, path=None, marker=None, ordinal=None, name=None):
        super().__init__(reason)
        self.reason = reason
        self.location = {}
        if language in LANGUAGES:
            self.location["language"] = language
            if path in COMMON_FILES | EXTRA_FILES[language]:
                self.location["relativePath"] = language + "/" + path
        if marker in ("private-key", "workspace-root", "producer-temporary-source"):
            self.location["marker"] = marker
        if type(ordinal) is int and 0 <= ordinal <= LIMITS["tarMembers"]:
            self.location["memberOrdinal"] = ordinal
        if isinstance(name, str):
            self.location["memberPathSha256"] = digest(name.encode("utf-8", errors="replace"))


def require(condition, reason, **location):
    if not condition:
        raise Refusal(reason, **location)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def size(value, maximum, minimum=0):
    require(type(value) is int and value >= minimum, "unsupported-schema")
    require(value <= maximum, "limit-exceeded")
    return value


def sha(value, reason="unsupported-schema"):
    require(isinstance(value, str) and SHA256.fullmatch(value), reason)
    return value


def parse_json(data, reason):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, reason)
            result[key] = value
        return result

    def constant(_value):
        raise Refusal(reason)

    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    except Refusal:
        raise
    except (UnicodeError, ValueError, RecursionError):
        raise Refusal(reason) from None


def arguments(values):
    allowed = {"--manifest", "--manifest-sha256", "--artifact-root", "--output"}
    result = {"workspace_roots": []}
    require(len(values) % 2 == 0 and len(values) <= 16, "invalid-arguments")
    for index in range(0, len(values), 2):
        flag, value = values[index:index + 2]
        require(isinstance(value, str) and 0 < len(value.encode("utf-8")) <= 2048
                and not any(ord(character) < 32 for character in value), "invalid-arguments")
        if flag == "--workspace-root":
            result["workspace_roots"].append(value)
        else:
            require(flag in allowed and flag not in result, "invalid-arguments")
            result[flag] = value
    require(allowed.issubset(result), "invalid-arguments")
    require(SHA256.fullmatch(result["--manifest-sha256"]), "invalid-arguments")
    require(1 <= len(result["workspace_roots"]) <= LIMITS["workspaceVariants"], "invalid-arguments")
    return result


def workspace_variants(roots):
    variants = set()
    for value in roots:
        require(os.path.isabs(value), "invalid-arguments")
        logical = os.path.abspath(value)
        require(logical != os.path.sep, "invalid-arguments")
        try:
            real = str(Path(logical).resolve(strict=True))
            require(Path(real).is_dir(), "invalid-arguments")
        except (OSError, RuntimeError):
            raise Refusal("invalid-arguments") from None
        variants.update((logical, real))
    require(len(variants) <= LIMITS["workspaceVariants"], "invalid-arguments")
    return tuple(value.encode("utf-8") for value in sorted(variants))


def ordinary_root(value):
    path = Path(os.path.abspath(value))
    try:
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode), "unsafe-file")
        return path.resolve(strict=True)
    except OSError:
        raise Refusal("unsafe-file") from None


def under_root(base, relative):
    path = base
    try:
        for component in relative.split("/"):
            path = path / component
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
        size(before.st_size, maximum)
        data = bytearray()
        while True:
            chunk = os.read(descriptor, LIMITS["chunkBytes"])
            if not chunk:
                break
            require(len(data) + len(chunk) <= maximum, "limit-exceeded")
            data.extend(chunk)
        after = os.fstat(descriptor)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), "artifact-integrity")
        require(len(data) == before.st_size, "artifact-integrity")
        return bytes(data)
    except OSError:
        raise Refusal("unsafe-file") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def logical_name(name, tar=False, directory=False):
    require(isinstance(name, str), "unsafe-archive")
    require(len(name.encode("utf-8")) <= LIMITS["pathBytes"], "limit-exceeded")
    if tar and directory and name in (".", "./"):
        return ""
    if tar and name.startswith("./"):
        name = name[2:]
    if directory and name.endswith("/"):
        name = name[:-1]
    require(bool(name) and not name.startswith("/") and not re.match(r"^[A-Za-z]:", name)
            and "\\" not in name and not any(ord(character) < 32 or ord(character) == 127 for character in name)
            and all(part not in ("", ".", "..") for part in name.split("/")), "unsafe-archive")
    return name


def private_path(name):
    return any(PRIVATE_NAME.fullmatch(part) or PRIVATE_EXTENSION.search(part) for part in name.split("/"))


class ContentScanner:
    def __init__(self, roots, language=None, path=None):
        self.roots = roots
        self.language = language
        self.path = path
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
            raise Refusal("private-content", language=self.language, path=self.path, marker=marker)
        self.tail = data[-self.overlap:]


def scan_bytes(data, roots, language, path):
    scanner = ContentScanner(roots, language, path)
    for offset in range(0, len(data), LIMITS["chunkBytes"]):
        scanner.feed(data[offset:offset + LIMITS["chunkBytes"]])


def validate_manifest(manifest):
    keys = {"schemaVersion", "profile", "version", "source", "sdk", "toolchains",
            "qualifiedTargets", "authority", "exclusions", "artifacts"}
    require(isinstance(manifest, dict) and set(manifest) == keys, "unsupported-schema")
    require(type(manifest["schemaVersion"]) is int and manifest["schemaVersion"] == 1
            and manifest["profile"] == PROFILE and manifest["version"] == "1.0.0"
            and manifest["authority"] == "inert-codec-only", "unsupported-schema")
    source, sdk = manifest["source"], manifest["sdk"]
    require(isinstance(source, dict) and set(source) == {"tree", "sha256"}, "unsupported-schema")
    require(isinstance(source["tree"], str) and TREE.fullmatch(source["tree"]), "unsupported-schema")
    require(isinstance(source["sha256"], dict) and 4 <= len(source["sha256"]) <= 64, "unsupported-schema")
    for path, value in source["sha256"].items():
        logical_name(path)
        sha(value)
    require(isinstance(sdk, dict) and set(sdk) == {"sourceTree", "manifestSha256", "selectedProducerSha256"}, "unsupported-schema")
    require(isinstance(sdk["sourceTree"], str) and TREE.fullmatch(sdk["sourceTree"]), "unsupported-schema")
    sha(sdk["manifestSha256"])
    require(isinstance(sdk["selectedProducerSha256"], dict) and set(sdk["selectedProducerSha256"]) == PRODUCER_PATHS, "unsupported-schema")
    for value in sdk["selectedProducerSha256"].values():
        sha(value)
    require(manifest["qualifiedTargets"] == TARGETS and manifest["exclusions"] == EXCLUSIONS, "unsupported-schema")
    require(isinstance(manifest["toolchains"], dict) and set(manifest["toolchains"]) == set(LANGUAGES), "unsupported-schema")
    require(isinstance(manifest["artifacts"], list) and len(manifest["artifacts"]) == 3, "unsupported-schema")
    records = {}
    for record in manifest["artifacts"]:
        require(isinstance(record, dict) and set(record) == {"language", "directory", "files", "tarball"}, "unsupported-schema")
        language = record["language"]
        require(isinstance(language, str) and language in LANGUAGES and language not in records, "unsupported-schema")
        require(record["directory"] == language, "unsupported-schema")
        require(isinstance(record["files"], list) and 1 <= len(record["files"]) <= LIMITS["filesPerLanguage"], "unsupported-schema")
        files = {}
        for file in record["files"]:
            require(isinstance(file, dict) and set(file) == {"path", "bytes", "sha256"}, "unsupported-schema")
            path = logical_name(file["path"])
            require(not private_path(path), "private-file", language=language)
            require(path not in files, "inventory-mismatch", language=language)
            size(file["bytes"], LIMITS["fileBytes"], 1)
            sha(file["sha256"])
            files[path] = file
        require(set(files) == COMMON_FILES | EXTRA_FILES[language], "inventory-mismatch", language=language)
        tarball = record["tarball"]
        require(isinstance(tarball, dict) and set(tarball) == {"path", "bytes", "sha256"}, "unsupported-schema")
        require(tarball["path"] == "tarballs/one01-pointer-" + language + "-1.0.0.tgz", "unsupported-schema")
        size(tarball["bytes"], LIMITS["compressedTarBytes"], 1)
        sha(tarball["sha256"])
        records[language] = (record, files)
    return records


def tar_metadata(member, roots, language, path, ordinal):
    require(isinstance(member.pax_headers, dict), "forbidden-metadata", language=language, path=path)
    require(not member.pax_headers, "forbidden-metadata", language=language, path=path)
    total = 0
    for value in list(member.pax_headers.values()) + [member.uname, member.gname, member.linkname]:
        require(isinstance(value, str), "forbidden-metadata", language=language, path=path)
        data = value.encode("utf-8")
        total += len(data)
        require(total <= LIMITS["metadataBytes"], "limit-exceeded", language=language, path=path)
        scan_bytes(data, roots, language, path)
    require(type(member.uid) is int and 0 <= member.uid <= 2147483647
            and type(member.gid) is int and 0 <= member.gid <= 2147483647
            and isinstance(member.mtime, (int, float)) and math.isfinite(member.mtime), "forbidden-metadata",
            language=language, path=path, ordinal=ordinal)


def decoded_tar(compressed):
    data = bytearray()
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode="rb") as stream:
            while True:
                chunk = stream.read(LIMITS["chunkBytes"])
                if not chunk:
                    break
                require(len(data) + len(chunk) <= LIMITS["decodedTarBytes"], "limit-exceeded")
                data.extend(chunk)
    except (OSError, EOFError, ValueError, zlib.error):
        raise Refusal("archive-corrupt") from None
    return bytes(data)


def inspect_tar(compressed, expected, roots, language):
    # Bounded decoded staging ensures gzip trailers and bytes after tar EOF are
    # checked too. TarInfo offsets are public parser metadata; no header parser.
    data = decoded_tar(compressed)
    # Include physical extension payloads and padding in the bounded scan.
    # Standard-library normalization must not erase bytes before inspection.
    scan_bytes(data, roots, language, None)
    payloads, seen = {}, set()
    ancestors = {""}
    for path in expected:
        parts = path.split("/")
        ancestors.update("/".join(parts[:index]) for index in range(1, len(parts)))
    last_payload_end = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r|") as archive:
            for ordinal, member in enumerate(archive):
                require(ordinal < LIMITS["tarMembers"], "limit-exceeded", language=language)
                # The producer emits plain USTAR. Public parser offsets reveal
                # any consumed GNU/local/global PAX records without a header parser.
                require(member.offset == last_payload_end and member.offset_data == member.offset + 512,
                        "forbidden-metadata", language=language, ordinal=ordinal)
                name = logical_name(member.name, tar=True, directory=member.isdir())
                require(name not in seen, "unsafe-archive", language=language, ordinal=ordinal, name=name)
                seen.add(name)
                require(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE),
                        "unsafe-archive", language=language, ordinal=ordinal, name=name)
                if member.isdir():
                    require(name in ancestors and member.size == 0, "undeclared-file", language=language, ordinal=ordinal, name=name)
                    tar_metadata(member, roots, language, None, ordinal)
                else:
                    require(not private_path(name), "private-file", language=language, ordinal=ordinal, name=name)
                    require(name in expected, "undeclared-file", language=language, ordinal=ordinal, name=name)
                    tar_metadata(member, roots, language, name, ordinal)
                    size(member.size, LIMITS["fileBytes"], 1)
                    require(member.size == expected[name]["bytes"], "artifact-integrity", language=language, path=name)
                    stream = archive.extractfile(member)
                    require(stream is not None, "archive-corrupt", language=language, path=name)
                    content = bytearray()
                    scanner = ContentScanner(roots, language, name)
                    with stream:
                        while True:
                            chunk = stream.read(LIMITS["chunkBytes"])
                            if not chunk:
                                break
                            require(len(content) + len(chunk) <= member.size, "archive-corrupt", language=language, path=name)
                            scanner.feed(chunk)
                            content.extend(chunk)
                    require(len(content) == member.size and digest(content) == expected[name]["sha256"], "artifact-integrity", language=language, path=name)
                    payloads[name] = bytes(content)
                last_payload_end = max(last_payload_end, member.offset_data + ((member.size + 511) // 512) * 512)
    except (tarfile.TarError, OSError, EOFError, ValueError):
        raise Refusal("archive-corrupt", language=language) from None
    require(set(payloads) == set(expected), "inventory-mismatch", language=language)
    require(last_payload_end <= len(data) - 1024 and not any(data[last_payload_end:]), "archive-corrupt", language=language)
    return payloads


def inspect_jar(data, roots):
    require(len(data) <= LIMITS["jarBytes"], "limit-exceeded", language="kotlin", path="lib/one01-pointer-wire.jar")
    inventory = []
    try:
        with zipfile.ZipFile(io.BytesIO(data), "r") as archive:
            members = archive.infolist()
            require(len(members) <= LIMITS["jarEntries"], "limit-exceeded", language="kotlin")
            seen, total = set(), 0
            for ordinal, member in enumerate(members):
                name = logical_name(member.filename)
                require(name not in seen, "unsafe-archive", language="kotlin", ordinal=ordinal, name=name)
                seen.add(name)
                require(not private_path(name), "private-file", language="kotlin", ordinal=ordinal, name=name)
                file_type = stat.S_IFMT(member.external_attr >> 16)
                require(not member.is_dir() and file_type in (0, stat.S_IFREG), "unsafe-archive", language="kotlin", ordinal=ordinal, name=name)
                require(not (member.flag_bits & 65), "unsafe-archive", language="kotlin", ordinal=ordinal, name=name)
                require(member.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "unsupported-compression", language="kotlin")
                require(name in JAR_FILES, "undeclared-file", language="kotlin", ordinal=ordinal, name=name)
                size(member.file_size, LIMITS["jarDecodedBytes"], 1)
                total += member.file_size
                require(total <= LIMITS["jarDecodedBytes"], "limit-exceeded", language="kotlin")
                scanner = ContentScanner(roots, "kotlin", "lib/one01-pointer-wire.jar")
                actual, hasher = 0, hashlib.sha256()
                with archive.open(member, "r") as stream:
                    while True:
                        chunk = stream.read(LIMITS["chunkBytes"])
                        if not chunk:
                            break
                        actual += len(chunk)
                        require(actual <= member.file_size, "archive-corrupt", language="kotlin")
                        scanner.feed(chunk)
                        hasher.update(chunk)
                require(actual == member.file_size, "archive-corrupt", language="kotlin")
                inventory.append({"path": name, "bytes": actual, "sha256": hasher.hexdigest()})
            require(seen == JAR_FILES, "inventory-mismatch", language="kotlin")
    except (zipfile.BadZipFile, OSError, EOFError, ValueError, RuntimeError, NotImplementedError, zlib.error):
        raise Refusal("archive-corrupt", language="kotlin", path="lib/one01-pointer-wire.jar") from None
    inventory.sort(key=lambda item: item["path"])
    return {"entries": len(inventory), "bytes": total, "inventorySha256": digest(json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode())}


def packaged_metadata(payloads, manifest, language):
    metadata = parse_json(payloads["artifact.json"], "metadata-invalid")
    keys = {"schemaVersion", "profile", "version", "language", "target", "toolchain", "sourceTree",
            "authority", "runtimeDependencies", "fixtureSha256", "profileSha256", "schemaSha256",
            "licenseSha256", "sdkManifestSha256", "selectedProducerSha256"}
    require(isinstance(metadata, dict) and set(metadata) == keys, "metadata-invalid", language=language, path="artifact.json")
    target = {"swift": "macos-arm64", "c": "macos-arm64", "kotlin": "jvm-jdk21"}[language]
    require(type(metadata["schemaVersion"]) is int and metadata["schemaVersion"] == 1
            and metadata["profile"] == PROFILE and metadata["version"] == "1.0.0"
            and metadata["language"] == language and metadata["target"] == target
            and metadata["sourceTree"] == manifest["source"]["tree"]
            and metadata["authority"] == "inert-codec-only"
            and metadata["toolchain"] == manifest["toolchains"][language]
            and metadata["sdkManifestSha256"] == manifest["sdk"]["manifestSha256"]
            and metadata["selectedProducerSha256"] == manifest["sdk"]["selectedProducerSha256"],
            "metadata-invalid", language=language, path="artifact.json")
    profile = parse_json(payloads["assets/profile.json"], "metadata-invalid")
    profile_keys = {"schemaVersion", "profile", "version", "codec", "packetBytes", "byteOrder", "lane",
                    "inputProfile", "capability", "coordinateAbsoluteError", "limits", "authority",
                    "qualifiedTargets", "excluded", "runtimeDependencies"}
    profile_limits = {"positiveFixtures": 32, "negativeFixtures": 64, "invalidEncodeFixtures": 16,
                      "fixtureBytes": 49152, "consumerCommands": 128, "consumerLineBytes": 4096}
    require(isinstance(profile, dict) and set(profile) == profile_keys
            and type(profile.get("schemaVersion")) is int and profile.get("schemaVersion") == 1 and profile.get("profile") == PROFILE
            and profile.get("version") == "1.0.0" and profile.get("codec") == "normalized-pointer/1"
            and profile.get("packetBytes") == 48 and profile.get("byteOrder") == "big-endian"
            and profile.get("lane") == "disposable" and profile.get("authority") == "inert-codec-only"
            and profile.get("inputProfile") == "app:pointer/1" and profile.get("capability") == "position"
            and profile.get("limits") == profile_limits
            and profile.get("qualifiedTargets") == TARGETS and profile.get("excluded") == EXCLUSIONS
            and isinstance(profile.get("runtimeDependencies"), dict) and set(profile["runtimeDependencies"]) == set(LANGUAGES)
            and metadata["runtimeDependencies"] == profile["runtimeDependencies"].get(language),
            "metadata-invalid", language=language, path="assets/profile.json")
    asset_pairs = [("LICENSE", "licenseSha256", "LICENSE"),
                   ("assets/profile.json", "profileSha256", "bindings/normalized-pointer/profile.json"),
                   ("assets/normalized-pointer-v1.json", "fixtureSha256", "bindings/normalized-pointer/fixtures/normalized-pointer-v1.json"),
                   ("assets/device-descriptor.schema.json", "schemaSha256", "schemas/device-descriptor.schema.json")]
    for path, field, source_path in asset_pairs:
        require(metadata[field] == digest(payloads[path]) == manifest["source"]["sha256"].get(source_path),
                "metadata-invalid", language=language, path=path)
    require(len(payloads["assets/normalized-pointer-v1.json"]) <= 49152, "limit-exceeded", language=language)
    fixtures = parse_json(payloads["assets/normalized-pointer-v1.json"], "metadata-invalid")
    require(isinstance(fixtures, dict) and type(fixtures.get("schemaVersion")) is int and fixtures.get("schemaVersion") == 1
            and fixtures.get("profile") == PROFILE and fixtures.get("codec") == "normalized-pointer/1",
            "metadata-invalid", language=language, path="assets/normalized-pointer-v1.json")


def audit(options):
    roots = workspace_variants(options["workspace_roots"])
    base = ordinary_root(options["--artifact-root"])
    manifest_path = Path(os.path.abspath(options["--manifest"]))
    require(manifest_path.parent.resolve(strict=True) == base, "unsafe-file")
    manifest_bytes = regular_bytes(manifest_path, LIMITS["manifestBytes"])
    require(digest(manifest_bytes) == options["--manifest-sha256"], "artifact-integrity")
    manifest = parse_json(manifest_bytes, "unsupported-schema")
    records = validate_manifest(manifest)
    results = []
    for language in LANGUAGES:
        record, expected = records[language]
        compressed = regular_bytes(under_root(base, record["tarball"]["path"]), LIMITS["compressedTarBytes"])
        require(len(compressed) == record["tarball"]["bytes"] and digest(compressed) == record["tarball"]["sha256"], "artifact-integrity", language=language)
        scan_bytes(compressed, roots, language, None)
        payloads = inspect_tar(compressed, expected, roots, language)
        packaged_metadata(payloads, manifest, language)
        result = {"language": language, "files": len(payloads), "bytes": sum(map(len, payloads.values())),
                  "tarballSha256": record["tarball"]["sha256"],
                  "inventorySha256": digest(json.dumps(record["files"], sort_keys=True, separators=(",", ":")).encode())}
        if language == "kotlin":
            result["jar"] = inspect_jar(payloads["lib/one01-pointer-wire.jar"], roots)
        results.append(result)
    return {"sourceTree": manifest["source"]["tree"], "artifacts": results, "files": sum(item["files"] for item in results),
            "artifactDeclaredQualifiedTargets": TARGETS, "exclusions": EXCLUSIONS, "authority": "inert-codec-only"}


def receipt_path(value):
    logical = Path(os.path.abspath(value))
    require(not os.path.lexists(logical), "output-exists")
    try:
        parent = logical.parent.resolve(strict=True)
        require(parent.is_dir(), "unsafe-file")
    except OSError:
        raise Refusal("unsafe-file") from None
    return parent / logical.name


def write_receipt(path, data):
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
    report = {"schemaVersion": 1, "auditProfile": AUDIT_PROFILE, "result": "fail", "reason": "unavailable",
              "bindingManifestSha256": None, "releaseAccepted": False, "limits": LIMITS,
              "nativeBindingBuildOrExecution": False, "decoderOrAbiQualification": False}
    output = None
    try:
        options = arguments(values)
        report["bindingManifestSha256"] = options["--manifest-sha256"]
        output = receipt_path(options["--output"])
        report["toolSha256"] = digest(Path(__file__).read_bytes())
        report.update(audit(options))
        report.update(result="pass", reason="ok")
    except Refusal as refusal:
        report["reason"] = refusal.reason
        if refusal.location:
            report["finding"] = refusal.location
    except Exception:
        # Never serialize exception text, caller values, headers or payloads.
        report["reason"] = "unavailable"
    data = (json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if len(data) > LIMITS["receiptBytes"]:
        report = {"schemaVersion": 1, "auditProfile": AUDIT_PROFILE, "result": "fail", "reason": "limit-exceeded",
                  "bindingManifestSha256": report["bindingManifestSha256"], "releaseAccepted": False}
        data = (json.dumps(report, sort_keys=True) + "\n").encode()
    if output is not None:
        try:
            write_receipt(output, data)
        except Refusal as refusal:
            report.update(result="fail", reason=refusal.reason)
            data = (json.dumps(report, sort_keys=True) + "\n").encode()
    sys.stdout.buffer.write(data)
    return 0 if report["result"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
