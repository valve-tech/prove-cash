#!/usr/bin/env python3
"""
`app/` and `sdk/` must pin the same TypeScript.

The app reaches the SDK through a `file:../sdk` link, and each side resolves its own copy of
viem. viem names `typescript` as an optional peer dependency, and TypeScript folds the
resolved compiler version into the package identity it uses to decide whether two copies are
the same package. One compiler on each side makes the two ids read
`viem@2.55.13+typescript@6.0.3` and `viem@2.55.13+typescript@7.0.2`. One package becomes two
type realms, and no client type is assignable across the link any more.

Nothing else states this rule, and Dependabot bumps one package at a time, so the two
versions drift on their own. The drift cost a whole investigation once: `tsc -b` failed with
12 errors and the scripts project with about 90, and not one of them named typescript. They
named viem and `Client_Base`. This is the gate that says the real word.

It reads the pinned range from both `package.json` files and the resolved version from both
`package-lock.json` files. The range is what a person edits; the resolved version is what
TypeScript actually folds into the identity, and two different ranges are not the only way to
end up with two compilers.

Run it from anywhere. Exit 0 when both sides agree.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGES = ("app", "sdk")

WHY = (
    "app/package.json and sdk/package.json must pin the same typescript version, because\n"
    "       viem declares typescript as an optional peer dependency and TypeScript folds the\n"
    "       resolved compiler into viem's package identity. Two compilers make two viem type\n"
    "       realms across the file:../sdk link, and the errors that follow name viem and\n"
    "       Client_Base rather than typescript. Bump both packages, or neither."
)


def die(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def load(path: Path) -> dict:
    if not path.exists():
        die(f"{path.relative_to(ROOT)} is missing, so this gate can promise nothing.")
    return json.loads(path.read_text())


def pinned_range(package: str) -> str:
    """The typescript range `package/package.json` asks for."""
    manifest = load(ROOT / package / "package.json")
    version = manifest.get("devDependencies", {}).get("typescript")
    if version is None:
        die(
            f"{package}/package.json names no typescript in devDependencies.\n"
            f"       {WHY}"
        )
    return version


def resolved_version(package: str) -> str:
    """The typescript version `package/package-lock.json` installs."""
    lock = load(ROOT / package / "package-lock.json")
    entry = lock.get("packages", {}).get("node_modules/typescript")
    if entry is None or "version" not in entry:
        die(
            f"{package}/package-lock.json records no resolved typescript.\n"
            f"       Run `npm install` in {package}/ and commit the lockfile."
        )
    return entry["version"]


def main() -> None:
    ranges = {p: pinned_range(p) for p in PACKAGES}
    resolved = {p: resolved_version(p) for p in PACKAGES}

    if len(set(ranges.values())) != 1:
        for package, version in ranges.items():
            print(f"  {package}/package.json pins typescript {version}")
        die(WHY)

    if len(set(resolved.values())) != 1:
        for package, version in resolved.items():
            print(f"  {package}/package-lock.json resolves typescript {version}")
        die(
            "the two lockfiles install different typescript versions, even though both\n"
            f"       manifests ask for {ranges['app']}.\n"
            f"       {WHY}"
        )

    print(
        f"OK: app and sdk both pin typescript {ranges['app']} "
        f"and both resolve {resolved['app']}."
    )


if __name__ == "__main__":
    main()
