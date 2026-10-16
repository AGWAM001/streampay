import { xdr, scValToNative } from '@stellar/stellar-sdk';
function parseScVal(val) {
    if (val instanceof xdr.ScVal) {
        return val;
    }
    if (typeof val === 'string') {
        return xdr.ScVal.fromXDR(val, 'base64');
    }
    if (typeof val === 'object' && val !== null && 'xdr' in val && typeof val.xdr === 'string') {
        return xdr.ScVal.fromXDR(val.xdr, 'base64');
    }
    throw new Error(`Cannot parse ScVal from: ${JSON.stringify(val)}`);
}
function normalizeNative(val) {
    if (typeof val === 'bigint') {
        return val.toString();
    }
    if (Array.isArray(val)) {
        return val.map(normalizeNative);
    }
    if (val !== null && typeof val === 'object') {
        if (val instanceof Map) {
            const obj = {};
            for (const [k, v] of val.entries()) {
                obj[String(k)] = normalizeNative(v);
            }
            return obj;
        }
        const obj = {};
        for (const [k, v] of Object.entries(val)) {
            obj[k] = normalizeNative(v);
        }
        return obj;
    }
    return val;
}
function safeToString(val) {
    if (typeof val === 'bigint')
        return val.toString();
    if (typeof val === 'number')
        return val.toString();
    if (typeof val === 'string')
        return val;
    return String(val ?? '');
}
function safeToNumber(val) {
    if (typeof val === 'number')
        return val;
    if (typeof val === 'bigint')
        return Number(val);
    if (typeof val === 'string')
        return Number(val);
    return 0;
}
function safeToBoolean(val) {
    if (typeof val === 'boolean')
        return val;
    return Boolean(val);
}
export function decodeEvent(event) {
    if (!event.topic || event.topic.length < 2) {
        return null;
    }
    let eventTypeSym = null;
    const topic0 = event.topic[0];
    if (topic0 !== undefined) {
        try {
            const parsedTopic0 = parseScVal(topic0);
            const native0 = scValToNative(parsedTopic0);
            if (typeof native0 === 'string') {
                eventTypeSym = native0;
            }
        }
        catch {
            return null;
        }
    }
    if (!eventTypeSym)
        return null;
    let streamId = null;
    const topic1 = event.topic[1];
    if (topic1 !== undefined) {
        try {
            const parsedTopic1 = parseScVal(topic1);
            const native1 = scValToNative(parsedTopic1);
            streamId = safeToString(native1);
        }
        catch {
            return null;
        }
    }
    if (!streamId)
        return null;
    let nativeData = {};
    try {
        const parsedVal = parseScVal(event.value);
        const nativeVal = scValToNative(parsedVal);
        const normalized = normalizeNative(nativeVal);
        if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
            nativeData = normalized;
        }
    }
    catch {
        return null;
    }
    switch (eventTypeSym) {
        case 'stream_created': {
            const payload = {
                stream_id: streamId,
                sender: safeToString(nativeData['sender']),
                recipient: safeToString(nativeData['recipient']),
                token: safeToString(nativeData['token']),
                deposit: safeToString(nativeData['deposit']),
                start_time: safeToNumber(nativeData['start_time']),
                end_time: safeToNumber(nativeData['end_time']),
                cancelable: safeToBoolean(nativeData['cancelable']),
            };
            return { eventType: 'stream_created', streamId, payload };
        }
        case 'withdrawn': {
            const payload = {
                stream_id: streamId,
                recipient: safeToString(nativeData['recipient']),
                amount: safeToString(nativeData['amount']),
                withdrawn_total: safeToString(nativeData['withdrawn_total']),
            };
            return { eventType: 'withdrawn', streamId, payload };
        }
        case 'stream_cancelled': {
            const payload = {
                stream_id: streamId,
                cancelled_by: safeToString(nativeData['cancelled_by']),
                recipient_amount: safeToString(nativeData['recipient_amount']),
                sender_amount: safeToString(nativeData['sender_amount']),
            };
            return { eventType: 'stream_cancelled', streamId, payload };
        }
        case 'stream_topped_up': {
            const payload = {
                stream_id: streamId,
                sender: safeToString(nativeData['sender']),
                amount: safeToString(nativeData['amount']),
                new_deposit: safeToString(nativeData['new_deposit']),
            };
            return { eventType: 'stream_topped_up', streamId, payload };
        }
        default:
            return null;
    }
}
