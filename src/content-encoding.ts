import { createBrotliDecompress, createGunzip, createInflate, createInflateRaw } from "node:zlib";
import type { Duplex } from "node:stream";
import { Decompress as ZstdDecompress } from "fzstd";

/** Raised when a request body's DECOMPRESSED size would exceed the configured
 *  limit (decompression-bomb guard). Kept distinct from a corrupt/unsupported
 *  body so callers reject an oversized payload (413) while relaying genuinely
 *  undecodable ones verbatim (#619). */
export class DecompressedTooLargeError extends Error {
    constructor(public readonly limit: number) {
        super(`decompressed request exceeds ${limit} bytes`);
        this.name = "DecompressedTooLargeError";
    }
}

/** Stream-decompress under a hard byte cap: rejects with DecompressedTooLargeError
 *  the instant output exceeds `max`, so a bomb never inflates in memory and the
 *  cap is enforced deterministically per codec. node's one-shot `maxOutputLength`
 *  instead reports overflow opaquely (ERR_BUFFER_TOO_LARGE for gzip/br; an
 *  ambiguous Z_DATA_ERROR for deflate that cannot be told apart from a corrupt
 *  stream), so counting the stream ourselves is the only reliable signal. */
function streamDecode(factory: () => Duplex, input: Buffer, max: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const decoder = factory();
        decoder.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > max) {
                decoder.destroy();
                reject(new DecompressedTooLargeError(max));
                return;
            }
            chunks.push(chunk);
        });
        decoder.on("end", () => resolve(Buffer.concat(chunks, size)));
        decoder.on("error", (err: Error) => reject(err));
        decoder.end(input);
    });
}

async function decodeZstd(input: Buffer, max: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    const decoder = new ZstdDecompress((chunk) => {
        size += chunk.byteLength;
        if (size > max) throw new DecompressedTooLargeError(max);
        chunks.push(Buffer.from(chunk));
    });
    decoder.push(input, true);
    return Buffer.concat(chunks, size);
}

async function decodeOne(coding: string, input: Buffer, max: number): Promise<Buffer> {
    if (coding === "gzip" || coding === "x-gzip") return streamDecode(createGunzip, input, max);
    if (coding === "br") return streamDecode(createBrotliDecompress, input, max);
    if (coding === "zstd") return decodeZstd(input, max);
    if (coding === "deflate") {
        try {
            return await streamDecode(createInflate, input, max);
        } catch (err) {
            if (err instanceof DecompressedTooLargeError) throw err;
            return streamDecode(createInflateRaw, input, max);
        }
    }
    throw new Error(`unsupported request content-encoding: ${coding}`);
}

export async function decodeRequestBody(
    contentEncoding: string | undefined,
    input: Buffer,
    maxOutputBytes: number,
): Promise<{ body: Buffer; decoded: boolean }> {
    const codings = (contentEncoding ?? "")
        .split(",")
        .map((coding) => coding.trim().toLowerCase())
        .filter((coding) => coding && coding !== "identity");
    if (codings.length === 0) return { body: input, decoded: false };
    let body = input;
    for (const coding of codings.reverse()) {
        body = await decodeOne(coding, body, maxOutputBytes);
        if (body.byteLength > maxOutputBytes) throw new DecompressedTooLargeError(maxOutputBytes);
    }
    return { body, decoded: true };
}
