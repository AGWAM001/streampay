"""Contract-event decoding helpers."""
from __future__ import annotations

from ._generated import StreamPayEvent, decode_event
from .errors import StreamPayError
from .xdr import XdrError, read_contract_event_b64

__all__ = ["decode_event_xdr", "decode_events"]


def decode_event_xdr(
    encoded: str, expected_contract_id: str | None = None
) -> StreamPayEvent | None:
    """Decodes a base64 event, optionally rejecting a different contract."""
    try:
        return decode_event(read_contract_event_b64(encoded), expected_contract_id)
    except (XdrError, KeyError, ValueError) as error:
        raise StreamPayError.decode(str(error)) from error


def decode_events(
    encoded: list[str], expected_contract_id: str | None = None
) -> list[StreamPayEvent]:
    """Decodes a batch of events, dropping events outside the interface.

    Malformed XDR fails the batch rather than being skipped: indexers need to
    know when their feed is corrupt.
    """
    decoded: list[StreamPayEvent] = []
    for item in encoded:
        event = decode_event_xdr(item, expected_contract_id)
        if event is not None:
            decoded.append(event)
    return decoded
