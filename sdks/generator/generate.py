#!/usr/bin/env python3
"""Generate StreamPay client code from the canonical spec.

Inputs
  * ``sdks/spec/streampay.spec.json`` — parsed and validated by ``ir.py`` into
    an immutable, language-agnostic IR.
  * ``frontend/lib/errors.ts`` — the canonical error catalog (itself generated
    from ``contracts/streaming-payments/src/errors.rs`` and gated in CI). No
    language target keeps a second error table.

Targets
  Each language target is an ``emit_<language>.py`` module next to this file
  exposing ``PACKAGE_DIR`` and ``outputs(spec, fingerprint, errors)``. Every
  declared target must have its package directory in the checkout.

Outputs
  Every emitted code artifact is hashed by relative POSIX path into
  ``sdks/generator/GENERATED_FINGERPRINT``. Both the artifact bytes and that
  manifest are checked by ``--check``; writes are explicitly UTF-8 with LF
  newlines. ``FINGERPRINT_CARRIERS`` remains for hand-written packages that only
  need their public spec digest stamped.

The output is deterministic, so ``--check`` is a valid CI gate: regeneration
must be a no-op.

Usage
  python3 sdks/generator/generate.py           # write generated files
  python3 sdks/generator/generate.py --check   # fail if outputs are stale
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import re
import sys
from collections.abc import Mapping
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import ir  # noqa: E402
from check_contract_surface import fingerprint  # noqa: E402,F401

ROOT = HERE.parents[1]
SPEC_PATH = ROOT / "sdks" / "spec" / "streampay.spec.json"
CATALOG_PATH = ROOT / "frontend" / "lib" / "errors.ts"
GENERATED_FINGERPRINT = HERE / "GENERATED_FINGERPRINT"
GENERATION_SCHEMA = "streampay-generation/v1"

# Python is now emitted from the IR rather than maintained as a hand-written
# subset. Keep the hook for packages that intentionally only carry a digest.
FINGERPRINT_CARRIERS: tuple[Path, ...] = ()


def carriers(digest: str) -> dict[Path, str]:
    """The carrier files with their spec-digest stamp rewritten to ``digest``."""
    stamped: dict[Path, str] = {}
    for path in FINGERPRINT_CARRIERS:
        text, hits = re.subn(
            r'^SPEC_FINGERPRINT = "[0-9a-f]{64}"',
            f'SPEC_FINGERPRINT = "{digest}"',
            path.read_text(encoding="utf-8"),
            count=1,
            flags=re.MULTILINE,
        )
        if hits != 1:
            raise ValueError(
                f"{path} no longer declares SPEC_FINGERPRINT as a 64-hex constant — "
                "update it or remove the file from FINGERPRINT_CARRIERS"
            )
        stamped[path] = text
    return stamped


def load_spec(path: Path = SPEC_PATH) -> ir.SpecIR:
    """Read the canonical UTF-8 spec and return its validated IR."""
    return ir.load_spec(path)


def load_error_catalog(path: Path = CATALOG_PATH) -> list[tuple[int, str]]:
    """Read ``(code, name)`` pairs from the canonical error catalog.

    The SDKs must not keep a second error table: codes and names come from
    ``frontend/lib/errors.ts``, which CI already gates against ``errors.rs``.
    """
    text = path.read_text(encoding="utf-8")
    entries = [
        (int(code), name)
        for code, name in re.findall(
            r"^\s*(\d+):\s*\{\s*code:\s*\d+,\s*name:\s*\"(\w+)\"",
            text,
            re.MULTILINE,
        )
    ]
    if not entries:
        raise ValueError(f"could not read the error catalog from {path}")
    if len({code for code, _ in entries}) != len(entries):
        raise ValueError("duplicate error codes in the catalog")
    if len({name for _, name in entries}) != len(entries):
        raise ValueError("duplicate error names in the catalog")
    return sorted(entries)


def emitters() -> list[object]:
    """All declared language emitters, requiring every package in the checkout."""
    found = []
    for path in sorted(HERE.glob("emit_*.py")):
        module = importlib.import_module(path.stem)
        package = Path(module.PACKAGE_DIR)
        if not package.is_dir():
            raise ValueError(f"generator target {path.stem} is missing package {package}")
        found.append(module)
    if not found:
        raise ValueError("no SDK generator targets were declared")
    return found


def _ordered(targets: Mapping[Path, str], root: Path = ROOT) -> dict[Path, str]:
    return dict(sorted(targets.items(), key=lambda item: item[0].relative_to(root).as_posix()))


def outputs(spec: ir.SpecIR | Mapping | None = None) -> dict[Path, str]:
    """Render every present language target from one validated IR instance."""
    parsed = load_spec() if spec is None else ir.parse_spec(spec)
    digest = parsed.fingerprint
    errors = load_error_catalog()
    targets: dict[Path, str] = {}
    for module in emitters():
        for path, content in module.outputs(parsed, digest, errors).items():
            if path in targets:
                raise ValueError(f"multiple emitters own {path.relative_to(ROOT).as_posix()}")
            targets[path] = content
    for path, content in carriers(digest).items():
        if path in targets:
            raise ValueError(f"an emitter and carrier both own {path.relative_to(ROOT).as_posix()}")
        targets[path] = content
    return _ordered(targets)


def _artifacts(targets: Mapping[Path, str], root: Path = ROOT) -> list[tuple[str, str]]:
    """Sorted ``(relative POSIX path, content sha256)`` records."""
    return [
        (
            path.relative_to(root).as_posix(),
            hashlib.sha256(content.encode("utf-8")).hexdigest(),
        )
        for path, content in _ordered(targets, root).items()
    ]


def generation_fingerprint(
    targets: Mapping[Path, str], spec_fingerprint: str, root: Path = ROOT
) -> str:
    """Hash the spec revision and every emitted code artifact, never host paths."""
    digest = hashlib.sha256()
    digest.update(GENERATION_SCHEMA.encode("ascii"))
    digest.update(b"\0")
    digest.update(spec_fingerprint.encode("ascii"))
    for path, content_hash in _artifacts(targets, root):
        digest.update(b"\0")
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(content_hash.encode("ascii"))
    return digest.hexdigest()


def generation_manifest(
    targets: Mapping[Path, str], spec_fingerprint: str, root: Path = ROOT
) -> str:
    """Deterministic JSON manifest for the generated code artifacts."""
    manifest = {
        "schema": GENERATION_SCHEMA,
        "specFingerprint": spec_fingerprint,
        "artifacts": [
            {"path": path, "sha256": content_hash}
            for path, content_hash in _artifacts(targets, root)
        ],
        "sha256": generation_fingerprint(targets, spec_fingerprint, root),
    }
    return json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"


def _all_outputs(
    targets: Mapping[Path, str], spec_fingerprint: str, root: Path = ROOT
) -> dict[Path, str]:
    rendered = dict(targets)
    rendered[root / GENERATED_FINGERPRINT.relative_to(ROOT)] = generation_manifest(
        targets, spec_fingerprint, root
    )
    return _ordered(rendered, root)


def write_outputs(
    targets: Mapping[Path, str], spec_fingerprint: str, root: Path = ROOT
) -> None:
    """Write code artifacts and their manifest as exact UTF-8/LF bytes."""
    for path, content in _all_outputs(targets, spec_fingerprint, root).items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")


def check_outputs(
    targets: Mapping[Path, str], spec_fingerprint: str, root: Path = ROOT
) -> list[str]:
    """Return relative paths whose committed bytes or manifest are stale."""
    stale: list[str] = []
    for path, content in _all_outputs(targets, spec_fingerprint, root).items():
        expected = content.encode("utf-8")
        existing = path.read_bytes() if path.exists() else b""
        if existing != expected:
            stale.append(path.relative_to(root).as_posix())
    return stale


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail when the committed files differ from the generator output",
    )
    args = parser.parse_args()

    spec = load_spec()
    targets = outputs(spec)
    if args.check:
        stale = check_outputs(targets, spec.fingerprint)
        for path in stale:
            print(f"stale generated artifact: {path}", file=sys.stderr)
        if stale:
            print(
                "generated clients are stale; run `python3 sdks/generator/generate.py`",
                file=sys.stderr,
            )
            return 1
        print(
            f"generated clients match the spec: {len(spec.functions)} operations, "
            f"{len(targets)} code artifact(s) + fingerprint, "
            f"sha256 {spec.fingerprint[:12]}…"
        )
        return 0

    write_outputs(targets, spec.fingerprint)
    for path in _all_outputs(targets, spec.fingerprint):
        print(f"wrote {path.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
