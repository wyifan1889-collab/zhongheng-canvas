import { createRequire } from "node:module";
import LibAV from "@libav.js/variant-obsolete";
import KaitaiStream from "kaitai-struct/KaitaiStream";
import { normalizeAudioProviderResult, type AudioProviderResponse, type AudioProviderResult } from "./audio-provider-result";

type ParsedMpegFrame = { _section: { offset: number; byteLength: number; nextFrameIndex?: number } };
const mp3Parser = createRequire(import.meta.url)("mp3-parser") as {
    readFrame(view: DataView, offset: number, requireNext: boolean): ParsedMpegFrame | null;
    readXingTag(view: DataView, offset: number): ParsedMpegFrame | null;
    readId3v2Tag(view: DataView, offset: number): ParsedMpegFrame | null;
};
type RiffParentData = { formType: number; subchunksSlot: { _io: KaitaiStream } };
type RiffEntry = { chunk: { id: number }; chunkData: { parentChunkData: RiffParentData } };
const Riff = createRequire(import.meta.url)("./vendor/audio-riff/Riff.cjs").Riff as {
    new(stream: KaitaiStream): { chunk: { id: number }; parentChunkData: RiffParentData };
    ChunkType: new(stream: KaitaiStream, parent: unknown, root: unknown) => RiffEntry;
    Fourcc: { RIFF: number; LIST: number };
};
type Runtime = Awaited<ReturnType<typeof LibAV.LibAV>>;
type PcmFrame = Awaited<ReturnType<Runtime["ff_copyout_frame"]>>;
type ProviderFailure = Exclude<AudioProviderResult, { status: "candidate" }>;

type IntegrityCode = "audio_integrity_failed" | "audio_packet_corrupt" | "audio_packet_incomplete"
    | "audio_pcm_invalid" | "audio_no_decoded_samples" | "audio_decoder_flush_incomplete" | "audio_integrity_cleanup_failed"
    | "audio_container_invalid" | "audio_source_uncovered";

export type AudioIntegrityResult = ProviderFailure
    | { status: "unknown"; code: IntegrityCode; upstreamStatus: 200; retryable: false }
    | {
        /** A media asset only; this is not a generation-task or billing success. */
        status: "verified";
        asset: { kind: "audio"; contentType: "audio/mpeg" | "audio/wav"; body: Uint8Array };
        usageEvidence: { status: "missing"; source: "audio_speech_binary" };
        technicalAudio: { source: "decoded_samples"; samplesPerChannel: number; sampleRate: number; channels: number; durationSeconds: number };
        validation: { decoder: "libav.js@6.10.9/FFmpeg9.0"; structure: "bounded-riff" | "contiguous-mpeg-spans";
            demuxEof: true; decoderEof: true; packets: number; frames: number };
    };

class IntegrityError extends Error {
    constructor(readonly code: IntegrityCode) { super(code); }
}
const reject = (code: IntegrityCode): AudioIntegrityResult => ({ status: "unknown", code, upstreamStatus: 200, retryable: false });

/** Parse one bounded RIFF chunk at a time, without expanding metadata or retaining a chunk tree. */
function completeRiff(bytes: Uint8Array): void {
    try {
        const stream = new KaitaiStream(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        const root = new Riff(stream);
        // WAVE FourCC, as decoded by the official generated parser.
        if (root.chunk.id !== Riff.Fourcc.RIFF || root.parentChunkData.formType !== 0x45564157 || !stream.isEof()) {
            throw new IntegrityError("audio_container_invalid");
        }
        const stack = [root.parentChunkData.subchunksSlot._io];
        while (stack.length) {
            const childStream = stack[stack.length - 1];
            if (childStream.isEof()) { stack.pop(); continue; }
            // Use the generated chunk constructor, not its eager subchunks[]
            // convenience getter. The runtime returns bounded zero-copy views.
            const entry = new Riff.ChunkType(childStream, null, root);
            if (entry.chunk.id === Riff.Fourcc.LIST) stack.push(entry.chunkData.parentChunkData.subchunksSlot._io);
        }
    } catch {
        throw new IntegrityError("audio_container_invalid");
    }
}

/** Account for metadata exactly at the current source position; never search past unknown bytes. */
function mpegMetadataUntil(view: DataView, offset: number, end: number): number {
    try {
        while (offset < end) {
            const parsed = mp3Parser.readXingTag(view, offset) ?? mp3Parser.readId3v2Tag(view, offset);
            const section = parsed?._section;
            if (!section || section.offset !== offset || !Number.isSafeInteger(section.byteLength) || section.byteLength <= 0 ||
                offset + section.byteLength > end) throw new IntegrityError("audio_source_uncovered");
            offset += section.byteLength;
        }
        if (offset !== end) throw new IntegrityError("audio_source_uncovered");
        return offset;
    } catch {
        throw new IntegrityError("audio_source_uncovered");
    }
}

/** Bind each complete MP3 packet to contiguous, identical original-source bytes. */
function completeMp3Packet(source: Uint8Array, view: DataView, offset: number, position: number, bytes: Uint8Array): number {
    if (!Number.isSafeInteger(position) || position < offset || position > source.byteLength) throw new IntegrityError("audio_source_uncovered");
    offset = mpegMetadataUntil(view, offset, position);
    try {
        const parsed = mp3Parser.readFrame(view, offset, false) ?? mp3Parser.readXingTag(view, offset);
        const section = parsed?._section;
        if (!section || section.offset !== offset || !Number.isSafeInteger(section.byteLength) || section.byteLength <= 0 ||
            section.byteLength !== bytes.byteLength || section.nextFrameIndex !== offset + bytes.byteLength ||
            offset + bytes.byteLength > source.byteLength) throw new IntegrityError("audio_packet_incomplete");
    } catch {
        // Includes the mature parser's RangeError on a residual packet.
        throw new IntegrityError("audio_packet_incomplete");
    }
    for (let index = 0; index < bytes.byteLength; index++) if (source[offset + index] !== bytes[index]) throw new IntegrityError("audio_source_uncovered");
    return offset + bytes.byteLength;
}

/**
 * Consume one MP3/WAV through local FFmpeg demux/decoder EOF, discarding PCM
 * after each frame. There is no network I/O, persistent output, PCM budget or
 * new duration/concurrency/timeout policy. A1's caller-supplied file cap applies.
 * A legal MP3 ending on a frame boundary cannot prove the upstream intended
 * length without trusted transport/total-length evidence.
 */
export async function validateAudioIntegrity(input: AudioProviderResponse): Promise<AudioIntegrityResult> {
    const candidate = await normalizeAudioProviderResult(input);
    if (candidate.status !== "candidate") return candidate;

    let lib: Runtime | undefined;
    let formatContext = 0, openOptions = 0, context = 0, packet = 0, frame = 0, wroteFile = false;
    let outcome: AudioIntegrityResult = reject("audio_integrity_failed");
    const filename = `audio-input.${candidate.format}`;
    try {
        if (candidate.format === "wav") completeRiff(candidate.candidateBytes);
        if (!LibAV.isWebAssemblySupported()) throw new IntegrityError("audio_integrity_failed");
        // Local sibling JS/WASM only. No worker, thread pool or host file mount.
        lib = await LibAV.LibAV({ noworker: true, nothreads: true });
        await lib.writeFile(filename, candidate.candidateBytes);
        wroteFile = true;
        const strict = "crccheck+bitstream+buffer+explode";
        const demuxer = await lib.av_find_input_format(candidate.format);
        if (!demuxer) throw new IntegrityError("audio_integrity_failed");
        openOptions = await lib.av_dict_set_js(0, "err_detect", strict, 0);
        if (!openOptions) throw new IntegrityError("audio_integrity_failed");
        formatContext = await lib.avformat_open_input_js(filename, demuxer, openOptions);
        if (!formatContext) throw new IntegrityError("audio_integrity_failed");
        // FFmpeg avformat_open_input consumes this recognized option and frees
        // its original dictionary on success; on failure we still own it.
        openOptions = 0;
        if (await lib.avformat_find_stream_info(formatContext, 0) < 0) throw new IntegrityError("audio_integrity_failed");
        let streamIndex = -1, codecParameters = 0;
        const streamCount = await lib.AVFormatContext_nb_streams(formatContext);
        for (let index = 0; index < streamCount; index++) {
            const stream = await lib.AVFormatContext_streams_a(formatContext, index);
            const parameters = await lib.AVStream_codecpar(stream);
            if (await lib.AVCodecParameters_codec_type(parameters) !== lib.AVMEDIA_TYPE_AUDIO) continue;
            if (streamIndex !== -1) throw new IntegrityError("audio_integrity_failed");
            streamIndex = index; codecParameters = parameters;
        }
        if (streamIndex === -1) throw new IntegrityError("audio_integrity_failed");
        const codec = await lib.avcodec_find_decoder(await lib.AVCodecParameters_codec_id(codecParameters));
        if (!codec) throw new IntegrityError("audio_integrity_failed");
        context = await lib.avcodec_alloc_context3(codec);
        if (!context || await lib.avcodec_parameters_to_context(context, codecParameters) < 0) throw new IntegrityError("audio_integrity_failed");
        if (await lib.av_opt_set(context, "err_detect", strict, 0) < 0) throw new IntegrityError("audio_integrity_failed");
        // MP3 copies err_recognition into decoder-private state at open time.
        // Setting it after ff_init_decoder would be too late despite a 0 return.
        if (await lib.avcodec_open2_js(context, codec, 0) < 0) throw new IntegrityError("audio_integrity_failed");
        packet = await lib.av_packet_alloc();
        frame = await lib.av_frame_alloc();
        if (!packet || !frame) throw new IntegrityError("audio_integrity_failed");

        let samples = 0, sampleRate = 0, channels = 0, packets = 0, frames = 0, sourceOffset = 0;
        const sourceView = new DataView(candidate.candidateBytes.buffer, candidate.candidateBytes.byteOffset, candidate.candidateBytes.byteLength);
        function consume(pcm: PcmFrame): void {
            const count = pcm.nb_samples ?? 0;
            const rate = pcm.sample_rate ?? 0;
            const channelCount = lib!.ff_channels(pcm);
            if (!Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(rate) || rate <= 0 ||
                !Number.isSafeInteger(channelCount) || channelCount <= 0 || !Number.isSafeInteger(samples + count) ||
                (sampleRate !== 0 && sampleRate !== rate) || (channels !== 0 && channels !== channelCount)) {
                throw new IntegrityError("audio_pcm_invalid");
            }
            const planes: ArrayLike<number>[] = Array.isArray(pcm.data) ? pcm.data : [pcm.data];
            const expected = Array.isArray(pcm.data) ? count : count * channelCount;
            if (planes.length !== (Array.isArray(pcm.data) ? channelCount : 1)) throw new IntegrityError("audio_pcm_invalid");
            for (const plane of planes) {
                if (!ArrayBuffer.isView(plane) || plane instanceof DataView || plane.length !== expected) throw new IntegrityError("audio_pcm_invalid");
                for (let index = 0; index < plane.length; index++) if (!Number.isFinite(plane[index])) throw new IntegrityError("audio_pcm_invalid");
            }
            samples += count; sampleRate = rate; channels = channelCount; frames++;
        }
        async function drain(flushing: boolean): Promise<void> {
            while (true) {
                const code = await lib!.avcodec_receive_frame(context, frame);
                if (code === lib!.AVERROR_EOF) {
                    if (!flushing) throw new IntegrityError("audio_integrity_failed");
                    return;
                }
                if (code === -lib!.EAGAIN) {
                    if (flushing) throw new IntegrityError("audio_decoder_flush_incomplete");
                    return;
                }
                if (code < 0) throw new IntegrityError("audio_integrity_failed");
                // AV_FRAME_FLAG_CORRUPT = 1, FFmpeg 9 libavutil/frame.h.
                if ((await lib!.AVFrame_flags(frame)) & 1) throw new IntegrityError("audio_pcm_invalid");
                consume(await lib!.ff_copyout_frame(frame));
                await lib!.av_frame_unref(frame);
            }
        }
        while (true) {
            const code = await lib.av_read_frame(formatContext, packet);
            if (code === lib.AVERROR_EOF) break;
            if (code < 0) throw new IntegrityError("audio_integrity_failed");
            const data = await lib.ff_copyout_packet(packet);
            if ((data.flags ?? 0) & lib.AV_PKT_FLAG_CORRUPT) throw new IntegrityError("audio_packet_corrupt");
            if (data.stream_index === streamIndex) {
                if (candidate.format === "mp3") {
                    const position = lib.i64tof64(await lib.AVPacket_pos(packet), await lib.AVPacket_poshi(packet));
                    sourceOffset = completeMp3Packet(candidate.candidateBytes, sourceView, sourceOffset, position, data.data);
                }
                if (await lib.avcodec_send_packet(context, packet) < 0) throw new IntegrityError("audio_integrity_failed");
                packets++;
                await drain(false);
            }
            await lib.av_packet_unref(packet);
        }
        if (candidate.format === "mp3") mpegMetadataUntil(sourceView, sourceOffset, candidate.candidateBytes.byteLength);
        if (await lib.avcodec_send_packet(context, 0) < 0) throw new IntegrityError("audio_decoder_flush_incomplete");
        await drain(true);
        if (samples <= 0 || sampleRate <= 0 || packets === 0) throw new IntegrityError("audio_no_decoded_samples");
        outcome = {
            status: "verified", asset: { kind: "audio", contentType: candidate.contentType, body: candidate.candidateBytes },
            usageEvidence: { status: "missing", source: "audio_speech_binary" },
            technicalAudio: { source: "decoded_samples", samplesPerChannel: samples, sampleRate, channels, durationSeconds: samples / sampleRate },
            validation: { decoder: "libav.js@6.10.9/FFmpeg9.0",
                structure: candidate.format === "wav" ? "bounded-riff" : "contiguous-mpeg-spans",
                demuxEof: true, decoderEof: true, packets, frames },
        };
    } catch (error) {
        outcome = reject(error instanceof IntegrityError ? error.code : "audio_integrity_failed");
    } finally {
        if (lib) {
            let cleaned = true;
            try { if (frame) await lib.av_frame_free_js(frame); } catch { cleaned = false; }
            try { if (packet) await lib.av_packet_free_js(packet); } catch { cleaned = false; }
            try { if (context) await lib.avcodec_free_context_js(context); } catch { cleaned = false; }
            try { if (formatContext) await lib.avformat_close_input_js(formatContext); } catch { cleaned = false; }
            try { if (openOptions) await lib.av_dict_free_js(openOptions); } catch { cleaned = false; }
            try { if (wroteFile) await lib.unlink(filename); } catch { cleaned = false; }
            try { lib.terminate(); } catch { cleaned = false; }
            if (!cleaned) outcome = reject("audio_integrity_cleanup_failed");
        }
    }
    return outcome;
}
