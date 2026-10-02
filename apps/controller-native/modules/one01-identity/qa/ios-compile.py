"""Compile real Swift core + Expo registration against already installed APIs.

No generated app project is edited or built. Requires one existing Debug iOS
simulator ExpoModulesCore build; this verifies compilation, not bridge runtime.
"""
import glob
import os
import pathlib
import shlex
import subprocess
import tempfile

module = pathlib.Path(__file__).resolve().parents[1]
builds = glob.glob(os.path.expanduser(
    "~/Library/Developer/Xcode/DerivedData/101Link-*/Build/Products/Debug-iphonesimulator/ExpoModulesCore/ExpoModulesCore.swiftmodule/arm64-apple-ios-simulator.swiftmodule"))
if len(builds) != 1:
    raise SystemExit("One installed simulator ExpoModulesCore build is required")
build = pathlib.Path(builds[0]).parents[4]
products = build / "Products/Debug-iphonesimulator/ExpoModulesCore"
responses = glob.glob(str(build / "Intermediates.noindex/Pods.build/Debug-iphonesimulator/ExpoModulesCore.build/Objects-normal/arm64/*common-args.resp"))
if not responses:
    raise SystemExit("Installed Expo compiler header-search configuration is required")
flags = shlex.split(pathlib.Path(responses[0]).read_text())
headers = []
index = 0
while index < len(flags):
    flag = flags[index]
    if flag in ["-I", "-F", "-iquote", "-isystem", "-iframework", "-ivfsoverlay"]:
        headers += ["-Xcc", flag, "-Xcc", flags[index + 1]]
        index += 1
    elif flag.startswith(("-I", "-F", "-fmodule-map-file=")):
        headers += ["-Xcc", flag]
    index += 1
sdk = subprocess.check_output(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-path"], text=True).strip()
with tempfile.TemporaryDirectory(prefix="101-identity-swift-") as temporary:
    command = ["xcrun", "swiftc", "-emit-object", "-whole-module-optimization", "-parse-as-library",
               "-module-name", "One01Identity", "-target", "arm64-apple-ios16.4-simulator", "-sdk", sdk,
               "-I", str(products), "-Xcc", "-fmodule-map-file=" + str(products / "ExpoModulesCore.modulemap")]
    command += headers + [str(module / "ios/One01IdentityModule.swift"), str(module / "ios/One01IdentityStore.swift"),
                          "-o", str(pathlib.Path(temporary) / "One01Identity.o")]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        print(result.stderr)
        raise SystemExit(result.returncode)
    print("Swift Security core and real Expo registration compiled for iOS simulator; bridge runtime unverified")
