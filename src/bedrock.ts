import type http from "node:http";

/**
 * AWS Bedrock pass-through (Claude Code with CLAUDE_CODE_USE_BEDROCK).
 *
 * Bedrock carries the Anthropic Messages body with the model and stream mode
 * moved into the PATH (`/model/<id>/invoke[-with-response-stream]`) and
 * streams `application/vnd.amazon.eventstream` binary frames whose `chunk`
 * events wrap one Anthropic stream event each (`{"bytes": base64}`).
 *
 * The pipeline stays Anthropic-only: handle() normalizes the inbound body
 * (model/stream back into the body) and re-encodes whatever SSE it writes to
 * the client as event-stream frames; fetchWithTimeout() moves model/stream
 * back into the path on every upstream call (main forward, compress-loop
 * re-requests, summary calls) and decodes the event-stream response into
 * Anthropic SSE. Authorization is forwarded untouched — bearer-token auth
 * (AWS_BEARER_TOKEN_BEDROCK) needs no re-signing, SigV4 would not survive a
 * body rewrite.
 */

export const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";
export const EVENTSTREAM_CONTENT_TYPE = "application/vnd.amazon.eventstream";

const INVOKE_RE = /^(.*\/model\/)([^/]+)\/(invoke|invoke-with-response-stream)$/;

export interface BedrockInvoke {
    modelId: string;
    stream: boolean;
}

export function bedrockInvokePath(urlPath: string): BedrockInvoke | null {
    const m = INVOKE_RE.exec(urlPath);
    if (!m) return null;
    let modelId: string;
    try {
        modelId = decodeURIComponent(m[2]);
    } catch {
        return null;
    }
    if (!modelId) return null;
    return { modelId, stream: m[3] === "invoke-with-response-stream" };
}

function parseObject(text: string): Record<string, unknown> | null {
    try {
        const v: unknown = JSON.parse(text);
        return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/** Inbound: Bedrock body → Anthropic Messages body (model + stream from the
 *  path). Returns null when the body is not a JSON object (left untouched). */
export function normalizeBedrockRequest(body: Buffer, invoke: BedrockInvoke): Buffer | null {
    const obj = parseObject(body.toString("utf8"));
    if (!obj) return null;
    return Buffer.from(JSON.stringify({ model: invoke.modelId, ...obj, stream: invoke.stream }), "utf8");
}

/** Same characters Claude Code's Bedrock client leaves unescaped in the path. */
function encodeModelSegment(model: string): string {
    return model.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]+/g, encodeURIComponent);
}

/** Outbound: Anthropic-shaped body on a Bedrock invoke URL → Bedrock shape.
 *  Only fires when the body carries `model` (i.e. it was normalized, or it is
 *  one of bili's own summary calls); a raw Bedrock body is left untouched. */
export function bedrockOutbound(url: string, body: unknown): { url: string; body: string } | undefined {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return undefined;
    }
    const m = INVOKE_RE.exec(u.pathname);
    if (!m) return undefined;
    const text = typeof body === "string" ? body : body instanceof Uint8Array ? Buffer.from(body).toString("utf8") : undefined;
    if (text === undefined) return undefined;
    const obj = parseObject(text);
    if (!obj || typeof obj.model !== "string" || !obj.model) return undefined;
    const model = obj.model;
    const stream = obj.stream === true;
    delete obj.model;
    delete obj.stream;
    if (obj.anthropic_version === undefined) obj.anthropic_version = BEDROCK_ANTHROPIC_VERSION;
    let current: string | undefined;
    try {
        current = decodeURIComponent(m[2]);
    } catch {
        current = undefined;
    }
    const segment = current === model ? m[2] : encodeModelSegment(model);
    u.pathname = `${m[1]}${segment}/${stream ? "invoke-with-response-stream" : "invoke"}`;
    return { url: u.toString(), body: JSON.stringify(obj) };
}

const RUNTIME_HOST_RE = /^bedrock-runtime(-fips)?\.([a-z0-9-]+)\.amazonaws\.com$/;
const CONTROL_PLANE_PATH_RE = /^\/(inference-profiles|foundation-models)(\/|$)/;

/** Claude Code's Bedrock control-plane client (ListInferenceProfiles for model
 *  discovery) shares ANTHROPIC_BEDROCK_BASE_URL with the runtime client, so in
 *  Bedrock mode those calls reach the proxy aimed at bedrock-runtime, which
 *  answers 404 UnknownOperationException. Route them to the regional control
 *  plane host (Host header included); undefined for every other request. */
export function bedrockControlPlane(url: string, headers: RequestInit["headers"]): { url: string; headers: RequestInit["headers"] } | undefined {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return undefined;
    }
    const m = RUNTIME_HOST_RE.exec(u.hostname);
    if (!m || !CONTROL_PLANE_PATH_RE.test(u.pathname)) return undefined;
    u.hostname = `bedrock${m[1] ?? ""}.${m[2]}.amazonaws.com`;
    let outHeaders = headers;
    if (headers && typeof headers === "object" && !Array.isArray(headers) && !(headers instanceof Headers)) {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() !== "host" && typeof v === "string") h[k] = v;
        h.host = u.host;
        outHeaders = h;
    }
    return { url: u.toString(), headers: outHeaders };
}

// --- AWS event-stream codec (prelude + headers + payload, CRC32 on both) ---

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[i] = c >>> 0;
    }
    return t;
})();

export function crc32(buf: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

export type EventStreamHeaderValue = string | number | bigint | boolean | Buffer;

export interface EventStreamFrame {
    headers: Record<string, EventStreamHeaderValue>;
    payload: Buffer;
}

export function encodeEventStreamFrame(headers: Record<string, string>, payload: Buffer): Buffer {
    const parts: Buffer[] = [];
    for (const [name, value] of Object.entries(headers)) {
        const n = Buffer.from(name, "utf8");
        const v = Buffer.from(value, "utf8");
        const h = Buffer.alloc(1 + n.length + 1 + 2);
        h.writeUInt8(n.length, 0);
        n.copy(h, 1);
        h.writeUInt8(7, 1 + n.length);
        h.writeUInt16BE(v.length, 2 + n.length);
        parts.push(h, v);
    }
    const hdr = Buffer.concat(parts);
    const total = 12 + hdr.length + payload.length + 4;
    const out = Buffer.alloc(total);
    out.writeUInt32BE(total, 0);
    out.writeUInt32BE(hdr.length, 4);
    out.writeUInt32BE(crc32(out.subarray(0, 8)), 8);
    hdr.copy(out, 12);
    payload.copy(out, 12 + hdr.length);
    out.writeUInt32BE(crc32(out.subarray(0, total - 4)), total - 4);
    return out;
}

function decodeHeaders(buf: Buffer): Record<string, EventStreamHeaderValue> {
    const out: Record<string, EventStreamHeaderValue> = {};
    let o = 0;
    while (o < buf.length) {
        const nameLen = buf.readUInt8(o);
        const name = buf.toString("utf8", o + 1, o + 1 + nameLen);
        o += 1 + nameLen;
        const type = buf.readUInt8(o);
        o += 1;
        switch (type) {
            case 0: out[name] = true; break;
            case 1: out[name] = false; break;
            case 2: out[name] = buf.readInt8(o); o += 1; break;
            case 3: out[name] = buf.readInt16BE(o); o += 2; break;
            case 4: out[name] = buf.readInt32BE(o); o += 4; break;
            case 5: out[name] = buf.readBigInt64BE(o); o += 8; break;
            case 6: case 7: {
                const len = buf.readUInt16BE(o);
                const v = buf.subarray(o + 2, o + 2 + len);
                out[name] = type === 7 ? v.toString("utf8") : Buffer.from(v);
                o += 2 + len;
                break;
            }
            case 8: out[name] = buf.readBigInt64BE(o); o += 8; break;
            case 9: out[name] = Buffer.from(buf.subarray(o, o + 16)); o += 16; break;
            default: throw new Error(`bedrock event-stream: unknown header value type ${type}`);
        }
    }
    return out;
}

export class EventStreamDecoder {
    private buf: Buffer = Buffer.alloc(0);

    push(chunk: Uint8Array): EventStreamFrame[] {
        this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
        const frames: EventStreamFrame[] = [];
        while (this.buf.length >= 12) {
            const total = this.buf.readUInt32BE(0);
            const hdrLen = this.buf.readUInt32BE(4);
            if (crc32(this.buf.subarray(0, 8)) !== this.buf.readUInt32BE(8)) throw new Error("bedrock event-stream: prelude CRC mismatch");
            if (total < 16 || hdrLen > total - 16) throw new Error(`bedrock event-stream: invalid frame length ${total}`);
            if (this.buf.length < total) break;
            const frame = this.buf.subarray(0, total);
            if (crc32(frame.subarray(0, total - 4)) !== frame.readUInt32BE(total - 4)) throw new Error("bedrock event-stream: message CRC mismatch");
            frames.push({
                headers: decodeHeaders(frame.subarray(12, 12 + hdrLen)),
                payload: Buffer.from(frame.subarray(12 + hdrLen, total - 4)),
            });
            this.buf = this.buf.subarray(total);
        }
        return frames;
    }

    get pending(): number {
        return this.buf.length;
    }
}

function sseEvent(type: string, data: string): string {
    return `event: ${type}\ndata: ${data}\n\n`;
}

/** One decoded frame → Anthropic SSE text. `chunk` events carry the Anthropic
 *  event verbatim; exception/error frames become an in-band `error` event whose
 *  `error.type` keeps the Bedrock exception name (so the client-side encoder
 *  can restore the exception frame); other event types are skipped, as the
 *  Bedrock SDK itself skips them. */
export function frameToSse(frame: EventStreamFrame): string {
    const messageType = String(frame.headers[":message-type"] ?? "event");
    const text = frame.payload.toString("utf8");
    if (messageType === "exception") {
        const type = String(frame.headers[":exception-type"] ?? "UnknownException");
        const obj = parseObject(text);
        const { message, ...rest } = obj ?? {};
        return sseEvent("error", JSON.stringify({ type: "error", error: { ...rest, type, message: typeof message === "string" ? message : text } }));
    }
    if (messageType === "error") {
        const type = String(frame.headers[":error-code"] ?? "UnknownError");
        const message = String(frame.headers[":error-message"] ?? text);
        return sseEvent("error", JSON.stringify({ type: "error", error: { type, message } }));
    }
    if (frame.headers[":event-type"] !== "chunk") return "";
    const bytes = parseObject(text)?.bytes;
    if (typeof bytes !== "string") throw new Error("bedrock event-stream: chunk event without bytes");
    const data = Buffer.from(bytes, "base64").toString("utf8");
    const type = parseObject(data)?.type;
    if (typeof type !== "string") throw new Error("bedrock event-stream: chunk is not an Anthropic stream event");
    return sseEvent(type, data);
}

export function eventStreamToSse(): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new EventStreamDecoder();
    const enc = new TextEncoder();
    return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            for (const frame of decoder.push(chunk)) {
                const sse = frameToSse(frame);
                if (sse) controller.enqueue(enc.encode(sse));
            }
        },
        flush() {
            if (decoder.pending > 0) throw new Error(`bedrock event-stream: truncated frame (${decoder.pending} trailing bytes)`);
        },
    });
}

/** Upstream response: event-stream → text/event-stream so every existing
 *  Anthropic SSE consumer runs unchanged. Non-stream / error bodies pass. */
export function bedrockResponseToSse(response: Response): Response {
    const ct = response.headers.get("content-type") ?? "";
    if (!response.body || !ct.includes(EVENTSTREAM_CONTENT_TYPE)) return response;
    const headers = new Headers(response.headers);
    headers.set("content-type", "text/event-stream");
    headers.delete("content-length");
    return new Response(response.body.pipeThrough(eventStreamToSse()), {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

const CHUNK_HEADERS = { ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" };

/** One SSE event block → event-stream frame. An `error` event whose type is a
 *  Bedrock exception name is restored as an exception frame; every other
 *  event (bili's own in-band errors included) rides a `chunk`, which the
 *  client unwraps into the same SSE event. Comment-only blocks (keep-alives)
 *  become an unknown event type the Bedrock SDK skips. */
export function sseBlockToFrame(block: string): Buffer | null {
    const dataLines: string[] = [];
    let comment = false;
    for (const line of block.split("\n")) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith(":")) comment = true;
    }
    if (dataLines.length === 0) {
        return comment ? encodeEventStreamFrame({ ":event-type": "bili-keepalive", ":content-type": "application/json", ":message-type": "event" }, Buffer.from("{}")) : null;
    }
    const data = dataLines.join("\n");
    const obj = parseObject(data);
    const err = obj?.type === "error" && obj.error && typeof obj.error === "object" ? obj.error as Record<string, unknown> : undefined;
    if (err && typeof err.type === "string" && /Exception$/.test(err.type)) {
        const { type, ...payload } = err;
        return encodeEventStreamFrame(
            { ":exception-type": type, ":content-type": "application/json", ":message-type": "exception" },
            Buffer.from(JSON.stringify(payload), "utf8"),
        );
    }
    return encodeEventStreamFrame(CHUNK_HEADERS, Buffer.from(JSON.stringify({ bytes: Buffer.from(data, "utf8").toString("base64") }), "utf8"));
}

export class SseToEventStream {
    private text = "";
    private readonly decoder = new TextDecoder();

    push(chunk: Uint8Array | string): Buffer {
        this.text += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
        this.text = this.text.replace(/\r\n|\r/g, "\n");
        const frames: Buffer[] = [];
        let idx: number;
        while ((idx = this.text.indexOf("\n\n")) >= 0) {
            const block = this.text.slice(0, idx);
            this.text = this.text.slice(idx + 2);
            const f = sseBlockToFrame(block);
            if (f) frames.push(f);
        }
        return Buffer.concat(frames);
    }

    flush(): Buffer {
        const rest = this.text + this.decoder.decode();
        this.text = "";
        const f = rest.trim() ? sseBlockToFrame(rest.trim()) : null;
        return f ?? Buffer.alloc(0);
    }
}

type WriteCb = (err?: Error | null) => void;

function toChunk(chunk: unknown, encoding: unknown): Uint8Array | string | undefined {
    if (chunk === undefined || chunk === null || typeof chunk === "function") return undefined;
    if (typeof chunk === "string") return typeof encoding === "string" && encoding !== "utf8" && encoding !== "utf-8" ? Buffer.from(chunk, encoding as BufferEncoding) : chunk;
    if (chunk instanceof Uint8Array) return chunk;
    return undefined;
}

function lastCallback(args: unknown[]): WriteCb | undefined {
    const last = args[args.length - 1];
    return typeof last === "function" ? last as WriteCb : undefined;
}

/** Client side: a 2xx text/event-stream response written by the pipeline is
 *  re-encoded as Bedrock event-stream frames. JSON bodies (errors, /invoke)
 *  pass untouched. Installed only on requests handle() normalized. */
export function installBedrockResponseEncoder(res: http.ServerResponse): void {
    let encoder: SseToEventStream | undefined;
    const origWriteHead = res.writeHead.bind(res) as (...args: unknown[]) => http.ServerResponse;
    const origWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
    const origEnd = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;
    res.writeHead = ((statusCode: number, ...rest: unknown[]) => {
        const hi = typeof rest[0] === "string" ? 1 : 0;
        const raw = rest[hi];
        if (Array.isArray(raw)) return origWriteHead(statusCode, ...rest);
        const headers = raw && typeof raw === "object" ? { ...(raw as http.OutgoingHttpHeaders) } : undefined;
        const ctKey = headers ? Object.keys(headers).find((k) => k.toLowerCase() === "content-type") : undefined;
        const ct = String((ctKey && headers ? headers[ctKey] : undefined) ?? res.getHeader("content-type") ?? "");
        if (statusCode >= 200 && statusCode < 300 && ct.includes("text/event-stream")) {
            encoder = new SseToEventStream();
            res.removeHeader("content-length");
            if (headers) {
                for (const k of Object.keys(headers)) if (k.toLowerCase() === "content-length" || k.toLowerCase() === "content-type") delete headers[k];
                headers["content-type"] = EVENTSTREAM_CONTENT_TYPE;
            } else {
                res.setHeader("content-type", EVENTSTREAM_CONTENT_TYPE);
            }
            const args = [...rest];
            if (headers) args[hi] = headers;
            return origWriteHead(statusCode, ...args);
        }
        return origWriteHead(statusCode, ...rest);
    }) as typeof res.writeHead;
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (!res.headersSent) res.writeHead(res.statusCode);
        if (!encoder) return origWrite(chunk, ...rest);
        const data = toChunk(chunk, rest[0]);
        const frames = data === undefined ? Buffer.alloc(0) : encoder.push(data);
        const cb = lastCallback(rest);
        if (frames.length === 0) {
            if (cb) process.nextTick(cb);
            return !res.writableNeedDrain;
        }
        return cb ? origWrite(frames, cb) : origWrite(frames);
    }) as typeof res.write;
    res.end = ((...args: unknown[]) => {
        if (!res.headersSent && args.length > 0 && typeof args[0] !== "function") res.writeHead(res.statusCode);
        if (!encoder) return origEnd(...args);
        const chunk = typeof args[0] === "function" ? undefined : args[0];
        const data = toChunk(chunk, args[1]);
        const frames = Buffer.concat([data === undefined ? Buffer.alloc(0) : encoder.push(data), encoder.flush()]);
        const cb = lastCallback(args);
        if (frames.length === 0) return cb ? origEnd(cb) : origEnd();
        return cb ? origEnd(frames, cb) : origEnd(frames);
    }) as typeof res.end;
}
