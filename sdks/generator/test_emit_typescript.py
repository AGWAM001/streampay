"""Synthetic coverage for TypeScript container and Result rendering."""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import emit_typescript  # noqa: E402
import ir  # noqa: E402
from test_ir import minimal_spec  # noqa: E402


class TypeScriptEmitterTest(unittest.TestCase):
    def render(self, raw: dict) -> str:
        spec = ir.parse_spec(raw)
        files = emit_typescript.outputs(
            spec, spec.fingerprint, [(1, "DemoError")]
        )
        return next(
            content for path, content in files.items() if path.name == "generated.ts"
        )

    def test_nested_container_types_keep_element_precedence(self) -> None:
        raw = minimal_spec()
        raw["functions"][0]["returns"] = {"vec": {"option": "u32"}}
        source = self.render(raw)
        self.assertIn(
            "): (number | null)[] {",
            source,
        )
        self.assertNotIn("number | null[]", source)

        raw = minimal_spec()
        raw["functions"][0]["args"][0]["type"] = {"vec": {"option": "u64"}}
        source = self.render(raw)
        self.assertIn("  id: (U64 | null)[];", source)
        self.assertIn(
            "xdr.ScVal.scvVec((args.id).map((item, index) =>",
            source,
        )

    def test_bare_and_vector_results_use_distinct_decoders(self) -> None:
        raw = minimal_spec()
        source = self.render(raw)
        self.assertIn(
            "return decodeResult(value, (item) => decodeDemoPayload(asNative(item)));",
            source,
        )
        self.assertNotIn(
            'return decodeResultVec(value, (item) => decodeDemoPayload(asNative(item)));',
            source,
        )
        self.assertIn('if (errorValue.type === "scvError")', source)
        self.assertIn("return { ok: decodeOk(value) };", source)

        raw = minimal_spec()
        raw["functions"][0]["returns"] = {
            "vec": copy.deepcopy(raw["functions"][0]["returns"])
        }
        source = self.render(raw)
        self.assertIn(
            'return decodeResultVec(value, (item) => decodeDemoPayload(asNative(item)), "read_demo");',
            source,
        )
        self.assertIn(
            'if (tagged.type !== "scvVec" || !Array.isArray(tagged.vec))',
            source,
        )

    def test_event_decoder_rejects_incorrect_topic_arity(self) -> None:
        source = self.render(minimal_spec())
        self.assertIn(
            'if (topics.length !== 2) throw new Error(`event demo_happened has ${topics.length} topics; expected 2`);',
            source,
        )


if __name__ == "__main__":
    unittest.main()
