"""Validated, immutable, language-agnostic StreamPay specification IR.

``streampay.spec.json`` remains the canonical wire format. This module is the
boundary between that JSON and every emitter: it parses the type grammar,
resolves named types, rejects duplicate declarations and exposes only ordered,
immutable values. Emitters never need to interpret unchecked dictionaries.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SPEC_PATH = ROOT / "sdks" / "spec" / "streampay.spec.json"
SUPPORTED_SCHEMAS = frozenset({"streampay-spec/v3"})
PRIMITIVES = frozenset(
    {
        "address",
        "bool",
        "i32",
        "u32",
        "i128",
        "u128",
        "u64",
        "string",
        "symbol",
        "bytes32",
        "bytes64",
        "void",
    }
)
INTEGER_RANGES = {
    "u32": (0, (1 << 32) - 1),
    "u64": (0, (1 << 64) - 1),
    "i128": (-(1 << 127), (1 << 127) - 1),
}

_SNAKE = re.compile(r"[a-z][a-z0-9_]*\Z")
_PASCAL = re.compile(r"[A-Z][A-Za-z0-9]*\Z")
_CONSTANT = re.compile(r"[A-Z][A-Z0-9_]*\Z")


class SpecError(ValueError):
    """The canonical spec is malformed or internally inconsistent."""


@dataclass(frozen=True)
class TypeRef:
    """A primitive, named type, or one of the three IR containers."""

    kind: str
    name: str | None = None
    item: TypeRef | None = None
    ok: TypeRef | None = None
    err: TypeRef | None = None

    @property
    def label(self) -> str:
        if self.kind in ("primitive", "named"):
            assert self.name is not None
            return self.name
        if self.kind == "vec":
            assert self.item is not None
            return "vec:" + self.item.label
        if self.kind == "option":
            assert self.item is not None
            return "option:" + self.item.label
        if self.kind == "result":
            assert self.ok is not None
            return "result:" + self.ok.label
        raise SpecError(f"unknown type kind {self.kind!r}")

    @property
    def is_void(self) -> bool:
        return self.kind == "primitive" and self.name == "void"

    def named_types(self) -> tuple[str, ...]:
        """Named references in traversal order, without duplicates."""
        found: list[str] = []

        def walk(value: TypeRef) -> None:
            if value.kind == "named":
                assert value.name is not None
                if value.name not in found:
                    found.append(value.name)
            elif value.kind in ("vec", "option"):
                assert value.item is not None
                walk(value.item)
            elif value.kind == "result":
                assert value.ok is not None and value.err is not None
                walk(value.ok)
                if value.err.kind == "named" and value.err.name not in found:
                    assert value.err.name is not None
                    found.append(value.err.name)

        walk(self)
        return tuple(found)


@dataclass(frozen=True)
class Field:
    name: str
    type: TypeRef
    doc: str = ""


@dataclass(frozen=True)
class Constant:
    name: str
    value: int
    type: str


@dataclass(frozen=True)
class EnumCase:
    name: str
    doc: str = ""
    value: int | None = None


@dataclass(frozen=True)
class EnumType:
    name: str
    encoding: str
    cases: tuple[EnumCase, ...]
    doc: str = ""


@dataclass(frozen=True)
class UnionCase:
    name: str
    types: tuple[TypeRef, ...]
    doc: str = ""


@dataclass(frozen=True)
class UnionType:
    name: str
    cases: tuple[UnionCase, ...]
    doc: str = ""


@dataclass(frozen=True)
class StructType:
    name: str
    fields: tuple[Field, ...]
    doc: str = ""


@dataclass(frozen=True)
class Function:
    name: str
    args: tuple[Field, ...]
    returns: TypeRef
    error: str | None
    mutating: bool
    doc: str = ""


@dataclass(frozen=True)
class Event:
    name: str
    topic: str
    topic_fields: tuple[Field, ...]
    data_fields: tuple[Field, ...]
    doc: str = ""


@dataclass(frozen=True)
class Contract:
    name: str
    crate: str
    version: str
    description: str


@dataclass(frozen=True)
class SpecIR:
    schema: str
    generator: str
    contract: Contract
    constants: tuple[Constant, ...]
    functions: tuple[Function, ...]
    structs: tuple[StructType, ...]
    enums: tuple[EnumType, ...]
    unions: tuple[UnionType, ...]
    events: tuple[Event, ...]
    fingerprint: str

    @property
    def read_functions(self) -> tuple[Function, ...]:
        return tuple(function for function in self.functions if not function.mutating)

    def function(self, name: str) -> Function:
        for function in self.functions:
            if function.name == name:
                return function
        raise KeyError(name)

    def event(self, topic: str) -> Event:
        for event in self.events:
            if event.topic == topic:
                return event
        raise KeyError(topic)

    def reachable_types(self, *, read_only: bool = False) -> tuple[tuple[StructType, ...], tuple[EnumType, ...], tuple[UnionType, ...]]:
        """Ordered type closure for all operations or the read-only surface."""
        structs = {item.name: item for item in self.structs}
        enums = {item.name: item for item in self.enums}
        unions = {item.name: item for item in self.unions}
        seen: set[str] = set()

        def walk(value: TypeRef) -> None:
            for name in value.named_types():
                if name in seen:
                    continue
                seen.add(name)
                if name in structs:
                    for field in structs[name].fields:
                        walk(field.type)
                elif name in unions:
                    for case in unions[name].cases:
                        for case_type in case.types:
                            walk(case_type)

        functions = self.read_functions if read_only else self.functions
        for function in functions:
            walk(function.returns)
            for arg in function.args:
                walk(arg.type)
        return (
            tuple(item for item in self.structs if item.name in seen),
            tuple(item for item in self.enums if item.name in seen),
            tuple(item for item in self.unions if item.name in seen),
        )


def _mapping(value: Any, label: str, required: set[str], optional: set[str] | None = None) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise SpecError(f"{label} must be an object")
    allowed = required | (optional or set())
    missing = sorted(required - value.keys())
    extra = sorted(value.keys() - allowed)
    if missing:
        raise SpecError(f"{label} is missing {', '.join(missing)}")
    if extra:
        raise SpecError(f"{label} has unknown field(s) {', '.join(extra)}")
    return value


def _list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise SpecError(f"{label} must be an array")
    return value


def _string(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise SpecError(f"{label} must be a string")
    return value


def _name(value: Any, label: str, pattern: re.Pattern[str]) -> str:
    name = _string(value, label)
    if not pattern.fullmatch(name):
        raise SpecError(f"{label} is not a valid identifier: {name!r}")
    return name


def _unique(items: list[str], label: str) -> None:
    seen: set[str] = set()
    for name in items:
        if name in seen:
            raise SpecError(f"duplicate {label} {name!r}")
        seen.add(name)


def _doc(value: Mapping[str, Any], label: str) -> str:
    return _string(value.get("doc", ""), f"{label}.doc")


def _field(value: Any, label: str) -> Field:
    entry = _mapping(value, label, {"name", "type"}, {"doc"})
    return Field(
        _name(entry["name"], f"{label}.name", _SNAKE),
        _type(entry["type"], f"{label}.type"),
        _doc(entry, label),
    )


def _type(value: Any, label: str) -> TypeRef:
    if isinstance(value, str):
        if value in PRIMITIVES:
            return TypeRef("primitive", name=value)
        return TypeRef("named", name=_name(value, label, _PASCAL))
    entry = _mapping(value, label, set(), {"vec", "option", "result"})
    if len(entry) != 1:
        raise SpecError(f"{label} must contain exactly one of vec, option, result")
    if "vec" in entry:
        return TypeRef("vec", item=_type(entry["vec"], f"{label}.vec"))
    if "option" in entry:
        return TypeRef("option", item=_type(entry["option"], f"{label}.option"))
    result = _mapping(entry["result"], f"{label}.result", {"ok", "err"})
    return TypeRef(
        "result",
        ok=_type(result["ok"], f"{label}.result.ok"),
        err=_type(result["err"], f"{label}.result.err"),
    )


def _constant(name: str, value: Any, label: str) -> Constant:
    constant_name = _name(name, f"{label} name", _CONSTANT)
    entry = _mapping(value, label, {"value", "type"})
    kind = _string(entry["type"], f"{label}.type")
    raw = entry["value"]
    if kind not in INTEGER_RANGES:
        raise SpecError(f"{label}.type must be one of {', '.join(sorted(INTEGER_RANGES))}")
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise SpecError(f"{label}.value must be an integer")
    lower, upper = INTEGER_RANGES[kind]
    if not lower <= raw <= upper:
        raise SpecError(f"{label}.value is outside the {kind} range")
    return Constant(constant_name, raw, kind)


def _enum(value: Any, label: str) -> EnumType:
    entry = _mapping(value, label, {"name", "encoding", "cases"}, {"doc"})
    name = _name(entry["name"], f"{label}.name", _PASCAL)
    encoding = _string(entry["encoding"], f"{label}.encoding")
    if encoding not in ("symbol", "u32"):
        raise SpecError(f"{label}.encoding must be 'symbol' or 'u32'")
    cases: list[EnumCase] = []
    for index, raw in enumerate(_list(entry["cases"], f"{label}.cases")):
        case_label = f"{label}.cases[{index}]"
        case = _mapping(raw, case_label, {"name"}, {"doc", "value"})
        case_name = _name(case["name"], f"{case_label}.name", _PASCAL)
        if encoding == "u32":
            if "value" not in case:
                raise SpecError(f"{case_label} needs a u32 discriminant")
            discriminant = case["value"]
            if isinstance(discriminant, bool) or not isinstance(discriminant, int) or not 0 <= discriminant < (1 << 32):
                raise SpecError(f"{case_label}.value must be a u32 integer")
        else:
            if "value" in case:
                raise SpecError(f"{case_label} cannot carry a discriminant")
            discriminant = None
        cases.append(EnumCase(case_name, _doc(case, case_label), discriminant))
    if not cases:
        raise SpecError(f"{label}.cases cannot be empty")
    _unique([case.name for case in cases], f"case in {name}")
    if encoding == "u32":
        _unique([str(case.value) for case in cases], f"discriminant in {name}")
    return EnumType(name, encoding, tuple(cases), _doc(entry, label))


def _union(value: Any, label: str) -> UnionType:
    entry = _mapping(value, label, {"name", "cases"}, {"doc"})
    name = _name(entry["name"], f"{label}.name", _PASCAL)
    cases: list[UnionCase] = []
    for index, raw in enumerate(_list(entry["cases"], f"{label}.cases")):
        case_label = f"{label}.cases[{index}]"
        case = _mapping(raw, case_label, {"name", "types"}, {"doc"})
        cases.append(
            UnionCase(
                _name(case["name"], f"{case_label}.name", _PASCAL),
                tuple(_type(item, f"{case_label}.types[{i}]") for i, item in enumerate(_list(case["types"], f"{case_label}.types"))),
                _doc(case, case_label),
            )
        )
    if not cases:
        raise SpecError(f"{label}.cases cannot be empty")
    _unique([case.name for case in cases], f"case in {name}")
    return UnionType(name, tuple(cases), _doc(entry, label))


def _struct(value: Any, label: str) -> StructType:
    entry = _mapping(value, label, {"name", "fields"}, {"doc"})
    name = _name(entry["name"], f"{label}.name", _PASCAL)
    fields = tuple(_field(raw, f"{label}.fields[{index}]") for index, raw in enumerate(_list(entry["fields"], f"{label}.fields")))
    _unique([field.name for field in fields], f"field in {name}")
    return StructType(name, fields, _doc(entry, label))


def _function(value: Any, label: str) -> Function:
    entry = _mapping(value, label, {"name", "args", "returns", "mutating"}, {"doc", "error"})
    name = _name(entry["name"], f"{label}.name", _SNAKE)
    args = tuple(_field(raw, f"{label}.args[{index}]") for index, raw in enumerate(_list(entry["args"], f"{label}.args")))
    _unique([arg.name for arg in args], f"argument in {name}")
    for arg in args:
        if arg.type.is_void:
            raise SpecError(f"{label}.args.{arg.name} cannot be void")
    if not isinstance(entry["mutating"], bool):
        raise SpecError(f"{label}.mutating must be a boolean")
    error = entry.get("error")
    if error is not None:
        error = _string(error, f"{label}.error")
    return Function(name, args, _type(entry["returns"], f"{label}.returns"), error, entry["mutating"], _doc(entry, label))


def _event(value: Any, label: str) -> Event:
    entry = _mapping(value, label, {"name", "topic", "topicFields", "dataFields"}, {"doc"})
    name = _name(entry["name"], f"{label}.name", _PASCAL)
    topics = tuple(_field(raw, f"{label}.topicFields[{index}]") for index, raw in enumerate(_list(entry["topicFields"], f"{label}.topicFields")))
    data = tuple(_field(raw, f"{label}.dataFields[{index}]") for index, raw in enumerate(_list(entry["dataFields"], f"{label}.dataFields")))
    _unique([field.name for field in topics + data], f"field in event {name}")
    return Event(name, _name(entry["topic"], f"{label}.topic", _SNAKE), topics, data, _doc(entry, label))


def spec_fingerprint(spec: Mapping[str, Any]) -> str:
    """The public spec digest, identical to check_contract_surface.fingerprint."""
    canonical = json.dumps(spec, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def parse_spec(value: SpecIR | Mapping[str, Any] | str | bytes) -> SpecIR:
    """Parse and validate a spec mapping, JSON text, or UTF-8 JSON bytes."""
    if isinstance(value, SpecIR):
        return value
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as error:
            raise SpecError(f"invalid spec JSON: {error}") from error
    raw = _mapping(
        value,
        "spec",
        {"schema", "generator", "contract", "constants", "functions", "structs", "enums", "unions", "events"},
    )
    schema = _string(raw["schema"], "spec.schema")
    if schema not in SUPPORTED_SCHEMAS:
        raise SpecError(f"unsupported spec schema {schema!r}")
    generator = _string(raw["generator"], "spec.generator")
    if generator != "sdks/generator/generate.py":
        raise SpecError(f"unexpected spec generator {generator!r}")

    contract_raw = _mapping(raw["contract"], "spec.contract", {"name", "crate", "version", "description"})
    contract = Contract(*(_string(contract_raw[key], f"spec.contract.{key}") for key in ("name", "crate", "version", "description")))
    if not contract.version:
        raise SpecError("spec.contract.version cannot be empty")

    constants_raw = raw["constants"]
    if not isinstance(constants_raw, Mapping):
        raise SpecError("spec.constants must be an object")
    constants = tuple(sorted((_constant(name, item, f"spec.constants.{name}") for name, item in constants_raw.items()), key=lambda item: item.name))
    functions = tuple(_function(item, f"spec.functions[{index}]") for index, item in enumerate(_list(raw["functions"], "spec.functions")))
    structs = tuple(_struct(item, f"spec.structs[{index}]") for index, item in enumerate(_list(raw["structs"], "spec.structs")))
    enums = tuple(_enum(item, f"spec.enums[{index}]") for index, item in enumerate(_list(raw["enums"], "spec.enums")))
    unions = tuple(_union(item, f"spec.unions[{index}]") for index, item in enumerate(_list(raw["unions"], "spec.unions")))
    events = tuple(_event(item, f"spec.events[{index}]") for index, item in enumerate(_list(raw["events"], "spec.events")))

    _unique([item.name for item in functions], "operation")
    _unique([item.name for item in structs + enums + unions], "type")
    _unique([item.name for item in events], "event name")
    _unique([item.topic for item in events], "event topic")
    known = {item.name for item in structs + enums + unions}

    def check_type(
        value: TypeRef,
        label: str,
        *,
        allow_void: bool = True,
        result_scope: str = "none",
    ) -> None:
        if value.kind == "named":
            assert value.name is not None
            if value.name not in known:
                raise SpecError(f"{label} references undefined type {value.name!r}")
        elif value.kind == "vec":
            assert value.item is not None
            if value.item.is_void:
                raise SpecError(f"{label} cannot contain void")
            child_scope = "return-vector" if result_scope == "return" else "none"
            check_type(value.item, label, result_scope=child_scope)
        elif value.kind == "option":
            assert value.item is not None
            if value.item.is_void:
                raise SpecError(f"{label} cannot contain void")
            check_type(value.item, label)
        elif value.kind == "result":
            if result_scope == "none":
                raise SpecError(
                    f"{label} cannot contain a result; results are return-only "
                    "and must be direct return values or direct vector elements"
                )
            assert value.ok is not None and value.err is not None
            if value.ok.is_void or value.err.kind != "named" or value.err.name not in ("StreamError", "unknown"):
                raise SpecError(f"{label} has an invalid result payload")
            check_type(value.ok, label)
        elif value.is_void and not allow_void:
            raise SpecError(f"{label} cannot be void")

    for function in functions:
        for arg in function.args:
            check_type(arg.type, f"operation {function.name}.{arg.name}", allow_void=False)
        check_type(function.returns, f"operation {function.name} return", result_scope="return")
        if function.error not in (None, "StreamError", "unknown"):
            raise SpecError(f"operation {function.name} has unknown error type {function.error!r}")
    for struct in structs:
        for field in struct.fields:
            check_type(field.type, f"struct {struct.name}.{field.name}", allow_void=False)
    for union in unions:
        for case in union.cases:
            for index, case_type in enumerate(case.types):
                check_type(case_type, f"union {union.name}.{case.name}[{index}]", allow_void=False)
    for event in events:
        for field in event.topic_fields + event.data_fields:
            check_type(field.type, f"event {event.name}.{field.name}", allow_void=False)

    return SpecIR(schema, generator, contract, constants, functions, structs, enums, unions, events, spec_fingerprint(raw))


def load_spec(path: Path = SPEC_PATH) -> SpecIR:
    """Read the canonical spec as UTF-8 and return its validated IR."""
    return parse_spec(path.read_text(encoding="utf-8"))
