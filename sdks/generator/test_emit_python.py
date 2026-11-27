"""Coverage for the generated Python bindings and codecs."""
from __future__ import annotations

import struct
import sys
import unittest
from dataclasses import FrozenInstanceError
from pathlib import Path
from typing import get_args

GENERATOR = Path(__file__).resolve().parent
PYTHON = GENERATOR.parent / "python"
sys.path.insert(0, str(GENERATOR))
sys.path.insert(0, str(PYTHON))

import emit_python  # noqa: E402
import generate  # noqa: E402
import ir  # noqa: E402
import streampay._generated as generated  # noqa: E402
from streampay.xdr import (  # noqa: E402
    ContractEvent,
    Reader,
    ScVal,
    XdrError,
    encode_scval,
    read_scval,
)

ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"


class PythonEmitterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.spec = generate.load_spec()
        cls.targets = generate.outputs(cls.spec)
        cls.source = next(
            content
            for path, content in cls.targets.items()
            if path.name == "_generated.py"
        )

    def sample(self, type_ref, stack: tuple[str, ...] = ()):
        if type_ref.kind == "result":
            return self.sample(type_ref.ok, stack)
        if type_ref.kind == "option":
            return self.sample(type_ref.item, stack)
        if type_ref.kind == "vec":
            return [self.sample(type_ref.item, stack)]
        if type_ref.kind == "primitive":
            return {
                "address": ADDRESS,
                "bool": True,
                "i32": -2,
                "u32": 2,
                "i128": -2,
                "u128": 2,
                "u64": 2,
                "string": "demo",
                "symbol": "Demo",
                "bytes32": bytes(range(32)),
                "bytes64": bytes(range(64)),
                "void": None,
            }[type_ref.name]
        name = type_ref.name
        if name in stack:
            raise AssertionError(f"recursive sample required for {name}")
        if name in generated._ENUM_TYPES:
            return next(iter(generated._ENUM_TYPES[name]))
        if name in generated._STRUCT_TYPES:
            struct = generated._STRUCT_TYPES[name]
            struct_ir = next(item for item in self.spec.structs if item.name == name)
            return struct(
                **{
                    field.name: self.sample(field.type, stack + (name,))
                    for field in struct_ir.fields
                }
            )
        if name in generated._UNION_TYPES:
            _, case_type, _ = generated._UNION_TYPES[name][0]
            # The registry stores labels, so use the IR case to preserve nested types.
            union = next(item for item in self.spec.unions if item.name == name)
            case = union.cases[0]
            values = [self.sample(item, stack + (name,)) for item in case.types]
            return case_type(values[0] if len(values) == 1 else tuple(values))
        raise AssertionError(f"unknown generated type {name}")

    def test_generated_source_is_utf8_and_compiles(self) -> None:
        compile(self.source, "_generated.py", "exec")
        self.assertIn(generated.SPEC_FINGERPRINT, self.source)
        self.assertIn("—", self.source)
        self.assertNotIn("\r", self.source)

    def test_all_operations_and_only_read_methods_are_generated(self) -> None:
        expected_methods = {
            emit_python.camel(function.name): function.name
            for function in self.spec.functions
        }
        self.assertEqual(generated.METHODS, expected_methods)
        self.assertEqual(len(generated.FUNCTIONS), 122)
        read_names = {function.name for function in self.spec.read_functions}
        emitted = {
            name
            for name, value in generated.ReadOnlyMethods.__dict__.items()
            if callable(value) and name != "_read"
        }
        self.assertEqual(emitted, read_names)
        self.assertEqual(len(emitted), 41)

    def test_every_argument_codec_and_result_decoder_roundtrips(self) -> None:
        for function in self.spec.functions:
            with self.subTest(operation=function.name):
                if function.args:
                    args_type = getattr(
                        generated, emit_python.pascal(function.name) + "Args"
                    )
                    args = args_type(
                        **{
                            item.name: self.sample(item.type)
                            for item in function.args
                        }
                    )
                    encoded_args = args.to_scvals()
                    self.assertEqual(len(encoded_args), len(function.args))
                sample = self.sample(function.returns)
                if function.returns.label.startswith("vec:result:"):
                    inner = function.returns.label[len("vec:result:") :]
                    encoded_result = ScVal(
                        "vec", [generated._encode_value(inner, item) for item in sample]
                    )
                else:
                    encoded_result = generated._encode_value(
                        function.returns.ok.label
                        if function.returns.kind == "result"
                        else function.returns.label,
                        sample,
                    )
                decoder = getattr(generated, f"decode_{function.name}_result")
                self.assertEqual(decoder(encoded_result), sample)

    def test_all_event_types_and_canonical_error_names_are_present(self) -> None:
        self.assertEqual(
            set(get_args(generated.StreamPayEvent)),
            {getattr(generated, event.name + "Event") for event in self.spec.events},
        )
        errors = dict(generate.load_error_catalog())
        self.assertEqual(generated.CONTRACT_ERROR_NAMES, errors)
        for union in self.spec.unions:
            with self.subTest(union=union.name):
                self.assertEqual(
                    set(get_args(getattr(generated, union.name))),
                    {getattr(generated, union.name + case.name) for case in union.cases},
                )
        for code, name in errors.items():
            with self.subTest(error=name):
                self.assertIs(generated.contract_error(code), generated.StreamError[name.upper()])
                self.assertEqual(generated.contract_error_name(code), name)
        self.assertIsNone(generated.contract_error(-1))
        self.assertIsNone(generated.contract_error_name(-1))
        self.assertEqual(
            generated.decode_event(ContractEvent("C...", "foreign", [], {}, 0)), None
        )

    def test_event_decoder_enforces_contract_identity_and_event_category(self) -> None:
        event = ContractEvent(
            "CEXPECTED",
            "stream_created",
            [ScVal("u64", 1)],
            {
                "sender": ScVal("address", ADDRESS),
                "recipient": ScVal("address", ADDRESS),
                "token": ScVal("address", ADDRESS),
                "deposit": ScVal("i128", 10),
                "start_time": ScVal("u64", 1),
                "end_time": ScVal("u64", 2),
                "cancelable": ScVal("bool", True),
            },
            1,
        )
        self.assertEqual(
            generated.decode_event(event, "COTHER"),
            None,
        )
        self.assertEqual(
            generated.decode_event(
                ContractEvent("CEXPECTED", "stream_created", [], {}, 2),
                "CEXPECTED",
            ),
            None,
        )
        decoded = generated.decode_event(event, "CEXPECTED")
        self.assertIsInstance(decoded, generated.StreamCreatedEvent)
        self.assertEqual(decoded.contract_id, "CEXPECTED")
        self.assertEqual(decoded.stream_id, 1)

    def test_result_errors_use_the_canonical_mapping(self) -> None:
        code = generate.load_error_catalog()[0][0]
        self.assertIs(
            generated.decode_schema_version_result(ScVal("error", code)),
            generated.contract_error(code),
        )
        with self.assertRaises(XdrError):
            generated.decode_schema_version_result(ScVal("error", 1_000_000))

    def test_symbol_enums_keep_wire_case_names_and_values_are_frozen(self) -> None:
        for enum in generated._ENUM_TYPES.values():
            for member in enum:
                with self.subTest(enum=enum.__name__, variant=member.name):
                    self.assertIs(enum.from_scval(member.to_scval()), member)
        value = generated.StreamStatus.ACTIVE
        self.assertEqual(value.to_scval(), ScVal("vec", [ScVal("symbol", "Active")]))
        stream = self.sample(self.spec.function("get_stream").returns)
        with self.assertRaises(FrozenInstanceError):
            stream.id = 99  # type: ignore[misc]

    def test_map_encoding_uses_semantic_scval_order_not_xdr_bytes(self) -> None:
        entries = [
            (ScVal("symbol", "aa"), ScVal("u32", 1)),
            (ScVal("symbol", "b"), ScVal("u32", 2)),
        ]
        expected = struct.pack(">iiI", 17, 1, 2) + b"".join(
            encode_scval(key) + encode_scval(item)
            for key, item in entries
        )
        self.assertEqual(encode_scval(ScVal("map", entries)), expected)

        typed_entries = [
            (ScVal("symbol", "a"), ScVal("void")),
            (ScVal("u32", 9), ScVal("void")),
            (ScVal("i32", -1), ScVal("void")),
            (ScVal("bool", True), ScVal("void")),
        ]
        decoded = read_scval(Reader(encode_scval(ScVal("map", typed_entries))))
        self.assertEqual(
            [key.kind for key, _ in decoded.value],
            ["bool", "u32", "i32", "symbol"],
        )

    def test_every_generated_struct_map_has_canonical_symbol_key_order(self) -> None:
        for struct in self.spec.structs:
            with self.subTest(struct=struct.name):
                value = self.sample(ir.TypeRef("named", name=struct.name))
                decoded = read_scval(Reader(encode_scval(value.to_scval())))
                keys = [str(key.value) for key, _ in decoded.value]
                self.assertEqual(keys, sorted(field.name for field in struct.fields))

    def test_multi_payload_union_rejects_short_and_extra_values(self) -> None:
        _, case_type, _ = generated._UNION_TYPES["GovernanceAction"][1]
        policy_type = next(
            item for item in self.spec.structs if item.name == "StreamPolicy"
        )
        policy = self.sample(ir.TypeRef("named", name=policy_type.name))
        valid = case_type((None, policy))
        self.assertEqual(
            generated._decode_named(
                "GovernanceAction", generated._encode_named("GovernanceAction", valid)
            ),
            valid,
        )
        for values in ((), (None,), (None, policy, policy)):
            with self.subTest(values=values):
                with self.assertRaisesRegex(XdrError, "expected 2 payload values"):
                    generated._encode_named(
                        "GovernanceAction", case_type(values)
                    )

    def test_fixed_width_bytes_roundtrip_and_reject_other_widths(self) -> None:
        for width in (32, 64):
            with self.subTest(width=width):
                label = f"bytes{width}"
                value = bytes(range(width))
                self.assertEqual(generated._decode_value(label, generated._encode_value(label, value)), value)
                with self.assertRaises(XdrError):
                    generated._encode_value(label, value[:-1])

    def test_read_mixin_uses_the_existing_client_transport_hook(self) -> None:
        class Reader(generated.ReadOnlyMethods):
            def __init__(self) -> None:
                self.calls = []

            def _read(self, method, args, decode):
                self.calls.append((method, args, decode))
                return decode(ScVal("u32", 2))

        reader = Reader()
        self.assertEqual(reader.schema_version(), 2)
        method, args, decoder = reader.calls[0]
        self.assertEqual(method, "schema_version")
        self.assertEqual(args, [])
        self.assertIs(decoder, generated.decode_schema_version_result)


if __name__ == "__main__":
    unittest.main()
