/**
 * Audio Reverse Player - Core Logic
 * Plays M4A/fMP4 audio in reverse using WebCodecs
 */
(function() {
    'use strict';

    /* ============================================================
     * Utilities & Logger
     * ============================================================ */
    const fourCC = (bytes, offset = 0) => String.fromCharCode(
        bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]
    );
    const u16 = (v, o) => v.getUint16(o, false);
    const u32 = (v, o) => v.getUint32(o, false);
    const u64 = (v, o) => Number(v.getBigUint64(o, false));
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    function formatTime(seconds) {
        if (!Number.isFinite(seconds)) return "00:00";
        seconds = Math.max(0, seconds);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return h > 0
            ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
            : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }

    class Logger {
        constructor(element) { this.element = element; }
        log(...args) {
            const line = args.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ");
            this.element.textContent += line + "\n";
            this.element.scrollTop = this.element.scrollHeight;
        }
        clear() { this.element.textContent = ""; }
    }

    /* ============================================================
     * HTTP Range Reader (with parallel HEAD + adaptive metadata fetch)
     * ============================================================ */
    class HttpRangeReader {
        constructor(url) {
            this.url = url;
            this.size = null;
            this._headPromise = null;
        }

        async requestRange(start, end) {
            const response = await fetch(this.url, {
                headers: { "Range": `bytes=${start}-${end}` },
                cache: "no-store"
            });
            if (!(response.status === 206 || response.status === 200)) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }
            return new Uint8Array(await response.arrayBuffer());
        }

        // 并行 HEAD + 乐观预取，自适应退避
        async fetchMetadata(initialChunk = 128 * 1024, maxChunk = 1024 * 1024) {
            // 1. 启动 HEAD 请求（不阻塞）
            this._headPromise = fetch(this.url, { method: 'HEAD', cache: 'no-store' })
                .then(r => parseInt(r.headers.get('Content-Length') || '0', 10))
                .catch(() => 0);

            // 2. 乐观预取初始 chunk
            let chunk = await this.requestRange(0, initialChunk - 1);
            if (this._hasMoovAndSidx(chunk)) {
                this.size = await this._headPromise;
                return chunk;
            }

            // 3. 等待 HEAD 结果，按总大小动态估算下一步
            this.size = await this._headPromise;
            let nextChunk = initialChunk;
            
            // 自适应：总大小越大，moov 可能越靠后
            // 经验：moov 约占总大小 0.1%-0.5%，上限 1MB
            const estimated = this.size > 0 
                ? Math.min(maxChunk, Math.max(initialChunk * 2, this.size * 0.005))
                : initialChunk * 2;

            for (let attempt = 0; attempt < 5; attempt++) {
                nextChunk = Math.min(estimated * Math.pow(2, attempt), maxChunk);
                const more = await this.requestRange(chunk.byteLength, chunk.byteLength + nextChunk - 1);
                chunk = this._concatUint8(chunk, more);
                if (this._hasMoovAndSidx(chunk)) break;
            }
            return chunk;
        }

        _hasMoovAndSidx(bytes) {
            const boxes = BoxReader.parseBoxes(bytes);
            return boxes.some(b => b.type === "moov") && boxes.some(b => b.type === "sidx");
        }

        _concatUint8(a, b) {
            const c = new Uint8Array(a.length + b.length);
            c.set(a, 0);
            c.set(b, a.length);
            return c;
        }
    }

    /* ============================================================
     * ISO BMFF & MP4 Metadata Parsers
     * ============================================================ */
    class BoxReader {
        static parseBoxes(bytes, baseOffset = 0) {
            const result = [];
            let p = 0;
            while (p + 8 <= bytes.byteLength) {
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                let size = u32(view, p);
                const type = fourCC(bytes, p + 4);
                let headerSize = 8;
                if (size === 1) {
                    if (p + 16 > bytes.byteLength) break;
                    size = u64(view, p + 8);
                    headerSize = 16;
                } else if (size === 0) {
                    size = bytes.byteLength - p;
                }
                if (size < headerSize || p + size > bytes.byteLength) break;
                result.push({ type, offset: baseOffset + p, size, headerSize, localOffset: p });
                p += size;
            }
            return result;
        }
        static find(bytes, type) { return this.parseBoxes(bytes).find(b => b.type === type); }
    }

    class Mp4Metadata {
        constructor() {
            this.trackId = null;
            this.timescale = null;
            this.sampleRate = null;
            this.channels = null;
            this.codec = null;
            this.decoderConfig = null;
        }

        parseMoov(bytes) {
            const top = BoxReader.parseBoxes(bytes);
            const moov = top.find(b => b.type === "moov");
            if (!moov) throw new Error("moov not found");

            const moovPayload = bytes.subarray(moov.localOffset + moov.headerSize, moov.localOffset + moov.size);
            const traks = BoxReader.parseBoxes(moovPayload).filter(b => b.type === "trak");

            for (const trak of traks) {
                const trakPayload = moovPayload.subarray(trak.localOffset + trak.headerSize, trak.localOffset + trak.size);
                const children = BoxReader.parseBoxes(trakPayload);
                const mdia = children.find(b => b.type === "mdia");
                if (!mdia) continue;

                const mdiaPayload = trakPayload.subarray(mdia.localOffset + mdia.headerSize, mdia.localOffset + mdia.size);
                const mdiaChildren = BoxReader.parseBoxes(mdiaPayload);
                const hdlr = mdiaChildren.find(b => b.type === "hdlr");
                if (!hdlr) continue;

                const hdlrPayload = mdiaPayload.subarray(hdlr.localOffset + hdlr.headerSize, hdlr.localOffset + hdlr.size);
                if (hdlrPayload.length >= 12 && fourCC(hdlrPayload, 8) === "soun") {
                    const mdhd = mdiaChildren.find(b => b.type === "mdhd");
                    if (mdhd) {
                        const p = mdiaPayload.subarray(mdhd.localOffset + mdhd.headerSize, mdhd.localOffset + mdhd.size);
                        const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
                        this.timescale = p[0] === 0 ? u32(view, 12) : u32(view, 20);
                    }

                    const minf = mdiaChildren.find(b => b.type === "minf");
                    const minfPayload = mdiaPayload.subarray(minf.localOffset + minf.headerSize, minf.localOffset + minf.size);
                    const stbl = BoxReader.parseBoxes(minfPayload).find(b => b.type === "stbl");
                    const stblPayload = minfPayload.subarray(stbl.localOffset + stbl.headerSize, stbl.localOffset + stbl.size);
                    const stsd = BoxReader.parseBoxes(stblPayload).find(b => b.type === "stsd");
                    const stsdPayload = stblPayload.subarray(stsd.localOffset + stsd.headerSize, stsd.localOffset + stsd.size);

                    this.parseStsdPayload(stsdPayload);
                    if (this.codec) return;
                }
            }
            throw new Error("未找到 valid AAC audio track");
        }

        parseStsdPayload(payload) {
            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            let p = 8;
            const entryCount = u32(view, 4);
            for (let i = 0; i < entryCount; i++) {
                const size = u32(view, p);
                const type = fourCC(payload, p + 4);
                if (type === "mp4a") {
                    this.channels = u16(view, p + 24);
                    this.sampleRate = u32(view, p + 32) / 65536;
                    this.codec = "mp4a.40.2";

                    const entryPayload = payload.subarray(p + 36, p + size);
                    const esds = BoxReader.parseBoxes(entryPayload).find(b => b.type === "esds");
                    if (esds) {
                        const esdsPayload = entryPayload.subarray(esds.localOffset + esds.headerSize, esds.localOffset + esds.size);
                        this.decoderConfig = parseESDSDecoderSpecificInfo(esdsPayload);
                    }
                    return;
                }
                p += size;
            }
        }
    }

    function parseESDSDecoderSpecificInfo(bytes) {
        if (!bytes || bytes.length < 4) return null;
        let p = 4; // 跳过 version (1 byte) 和 flags (3 bytes)

        while (p < bytes.length) {
            const tag = bytes[p++];
            let length = 0;
            let count = 0;

            // 解析变长 length (ES_Descriptor / DecoderConfigDescriptor)
            while (p < bytes.length && count < 4) {
                const b = bytes[p++];
                length = (length << 7) | (b & 0x7f);
                count++;
                if (!(b & 0x80)) break;
            }

            if (tag === 0x03) {
                // ES_Descriptor: 跳过 ES_ID (2 bytes) + priority (1 byte)
                p += 3;
            } else if (tag === 0x04) {
                // DecoderConfigDescriptor: 跳过 objectTypeIndex(1), streamType(1), bufferSizeDB(3), maxBitrate(4), avgBitrate(4) -> 共 13 bytes
                p += 13;
            } else if (tag === 0x05) {
                // DecoderSpecificInfo: 找到 AAC AudioSpecificConfig 数据
                if (p + length <= bytes.length) {
                    return new Uint8Array(bytes.buffer, bytes.byteOffset + p, length);
                }
                break;
            } else {
                p += length;
            }
        }
        return null;
    }

    class SidxParser {
        static parse(bytes) {
            const sidx = BoxReader.find(bytes, "sidx");
            if (!sidx) throw new Error("sidx box not found");

            const payload = bytes.subarray(sidx.localOffset + sidx.headerSize, sidx.localOffset + sidx.size);
            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            const version = payload[0];
            const timescale = u32(view, 8);

            let p = 12;
            let earliestPresentationTime = version === 0 ? u32(view, p) : u64(view, p);
            p += version === 0 ? 4 : 8;
            let firstOffset = version === 0 ? u32(view, p) : u64(view, p);
            p += (version === 0 ? 4 : 8) + 2;

            const referenceCount = u16(view, p);
            p += 2;

            const entries = [];
            let offset = sidx.offset + sidx.size + firstOffset;
            let time = earliestPresentationTime;

            for (let i = 0; i < referenceCount; i++) {
                const refInfo = u32(view, p);
                const duration = u32(view, p + 4);
                p += 12;

                const referencedSize = refInfo & 0x7fffffff;
                entries.push({ index: i, offset, size: referencedSize, duration, time });
                offset += referencedSize;
                time += duration;
            }

            return { timescale, entries };
        }
    }

    class Fmp4Parser {
        static parseFragment(bytes, fragmentOffset, metadata) {
            const boxes = BoxReader.parseBoxes(bytes, fragmentOffset);
            const moof = boxes.find(b => b.type === "moof");
            if (!moof) throw new Error("Fragment 中没有 moof");

            const moofPayload = bytes.subarray(moof.localOffset + moof.headerSize, moof.localOffset + moof.size);
            const traf = BoxReader.parseBoxes(moofPayload).find(b => b.type === "traf");
            const trafPayload = moofPayload.subarray(traf.localOffset + traf.headerSize, traf.localOffset + traf.size);
            const trafChildren = BoxReader.parseBoxes(trafPayload);

            const tfhd = trafChildren.find(b => b.type === "tfhd");
            const tfhdPayload = trafPayload.subarray(tfhd.localOffset + tfhd.headerSize, tfhd.localOffset + tfhd.size);
            const tfhdView = new DataView(tfhdPayload.buffer, tfhdPayload.byteOffset, tfhdPayload.byteLength);
            const tfhdFlags = u32(tfhdView, 0) & 0xFFFFFF;

            let p = 8;
            let baseDataOffset = (tfhdFlags & 0x000001) ? u64(tfhdView, p) : null;
            if (tfhdFlags & 0x000001) p += 8;
            if (tfhdFlags & 0x000002) p += 4;
            let defaultSampleDuration = (tfhdFlags & 0x000008) ? u32(tfhdView, p) : null;
            if (tfhdFlags & 0x000008) p += 4;
            let defaultSampleSize = (tfhdFlags & 0x000010) ? u32(tfhdView, p) : null;

            const tfdt = trafChildren.find(b => b.type === "tfdt");
            let decodeTime = 0;
            if (tfdt) {
                const tfdtPayload = trafPayload.subarray(tfdt.localOffset + tfdt.headerSize, tfdt.localOffset + tfdt.size);
                decodeTime = tfdtPayload[0] === 1 
                    ? u64(new DataView(tfdtPayload.buffer, tfdtPayload.byteOffset), 4) 
                    : u32(new DataView(tfdtPayload.buffer, tfdtPayload.byteOffset), 4);
            }

            const trun = trafChildren.find(b => b.type === "trun");
            const trunPayload = trafPayload.subarray(trun.localOffset + trun.headerSize, trun.localOffset + trun.size);
            const trunView = new DataView(trunPayload.buffer, trunPayload.byteOffset, trunPayload.byteLength);
            const trunFlags = u32(trunView, 0) & 0xFFFFFF;
            const sampleCount = u32(trunView, 4);

            p = 8;
            let dataOffset = (trunFlags & 0x000001) ? trunView.getInt32(p, false) : null;
            if (trunFlags & 0x000001) p += 4;
            if (trunFlags & 0x000004) p += 4;

            let sampleDataFileOffset = baseDataOffset != null 
                ? baseDataOffset + (dataOffset || 0) 
                : moof.offset + (dataOffset != null ? dataOffset : moof.size);
            let localDataOffset = sampleDataFileOffset - fragmentOffset;
            if (localDataOffset < 0 || localDataOffset >= bytes.length) {
                localDataOffset = moof.localOffset + moof.size;
            }

            const samples = [];
            let currentDataOffset = localDataOffset;
            let currentDecodeTime = decodeTime;

            for (let i = 0; i < sampleCount; i++) {
                let duration = (trunFlags & 0x000100) ? u32(trunView, p) : defaultSampleDuration;
                if (trunFlags & 0x000100) p += 4;
                let size = (trunFlags & 0x000200) ? u32(trunView, p) : defaultSampleSize;
                if (trunFlags & 0x000200) p += 4;
                if (trunFlags & 0x000400) p += 4;
                if (trunFlags & 0x000800) p += 4;

                samples.push({
                    data: bytes.slice(currentDataOffset, currentDataOffset + size),
                    duration,
                    decodeTime: currentDecodeTime
                });
                currentDataOffset += size;
                currentDecodeTime += duration;
            }

            return { samples };
        }
    }

    /* ============================================================
     * PCM Process & WebCodecs Decoder
     * ============================================================ */
    function reversePCMPlanar(channels) {
        for (const channel of channels) {
            let i = 0, j = channel.length - 1;
            while (i < j) {
                const tmp = channel[i];
                channel[i] = channel[j];
                channel[j] = tmp;
                i++; j--;
            }
        }
    }

    function audioDataToPlanar(audioData) {
        const channels = audioData.numberOfChannels;
        const frames = audioData.numberOfFrames;
        const result = [];
        for (let c = 0; c < channels; c++) {
            const plane = new Float32Array(frames);
            audioData.copyTo(plane, { planeIndex: c, format: "f32-planar" });
            result.push(plane);
        }
        return { channels: result, frames, sampleRate: audioData.sampleRate };
    }

    class PipelineDecoder {
        constructor(metadata) {
            this.metadata = metadata;
        }

        async decodeFragment(fragment) {
            return new Promise((resolve, reject) => {
                const outputChunks = [];
                const decoder = new AudioDecoder({
                    output: data => outputChunks.push(data),
                    error: err => reject(err)
                });

                // 1. 构建基础配置
                const config = {
                    codec: this.metadata.codec || "mp4a.40.2",
                    sampleRate: Math.round(this.metadata.sampleRate),
                    numberOfChannels: this.metadata.channels
                };

                // 2. 严格校验 description 必须是有效 ArrayBufferView (Uint8Array)
                if (
                    this.metadata.decoderConfig &&
                    this.metadata.decoderConfig instanceof Uint8Array &&
                    this.metadata.decoderConfig.byteLength > 0
                ) {
                    config.description = this.metadata.decoderConfig;
                }

                // 3. 配置 AudioDecoder
                decoder.configure(config);

                const timestampBase = fragment.samples.length ? fragment.samples[0].decodeTime : 0;
                const timescale = this.metadata.timescale;

                for (const sample of fragment.samples) {
                    const chunk = new EncodedAudioChunk({
                        type: "key",
                        timestamp: Math.round((sample.decodeTime - timestampBase) * 1000000 / timescale),
                        duration: Math.round(sample.duration * 1000000 / timescale),
                        data: sample.data
                    });
                    decoder.decode(chunk);
                }

                decoder.flush().then(() => {
                    let totalFrames = 0;
                    const pcmBlocks = [];
                    for (const data of outputChunks) {
                        const pcm = audioDataToPlanar(data);
                        pcmBlocks.push(pcm);
                        totalFrames += pcm.frames;
                        data.close();
                    }

                    if (!totalFrames) {
                        decoder.close();
                        return resolve(null);
                    }

                    const channelCount = pcmBlocks[0].channels.length;
                    const merged = Array.from({ length: channelCount }, () => new Float32Array(totalFrames));
                    let writePos = 0;
                    for (const block of pcmBlocks) {
                        for (let c = 0; c < channelCount; c++) {
                            merged[c].set(block.channels[c], writePos);
                        }
                        writePos += block.frames;
                    }

                    reversePCMPlanar(merged);
                    decoder.close();
                    resolve({ channels: merged, frames: totalFrames, sampleRate: pcmBlocks[0].sampleRate });
                }).catch(reject);
            });
        }
    }

    /* ============================================================
     * Audio Renderer (Buffer-Based Continuous Playback)
     * ============================================================ */
    class AudioRenderer {
        constructor() {
            this.context = null;
            this.nextTime = 0;
            this.sources = new Set();
            this.pendingFrames = 0;
        }

        init(sampleRate) {
            this.sampleRate = sampleRate;
            this.context = new AudioContext({ sampleRate });
            this.nextTime = this.context.currentTime + 0.05;
        }

        async resume() {
            if (this.context && this.context.state !== "running") {
                await this.context.resume();
                this.nextTime = this.context.currentTime + 0.05;
            }
        }

        push(channels, frames) {
            if (!this.context || !frames) return;

            const buffer = this.context.createBuffer(channels.length, frames, this.sampleRate);
            for (let c = 0; c < channels.length; c++) {
                buffer.getChannelData(c).set(channels[c]);
            }

            const source = this.context.createBufferSource();
            source.buffer = buffer;
            source.connect(this.context.destination);

            const now = this.context.currentTime;
            if (this.nextTime < now + 0.02) {
                this.nextTime = now + 0.02;
            }

            source.start(this.nextTime);
            this.nextTime += frames / this.sampleRate;
            this.pendingFrames += frames;
            this.sources.add(source);

            source.onended = () => {
                this.sources.delete(source);
                this.pendingFrames = Math.max(0, this.pendingFrames - frames);
                try { source.disconnect(); } catch { }
            };
        }

        stop() {
            for (const s of this.sources) {
                try { s.stop(); s.disconnect(); } catch { }
            }
            this.sources.clear();
            this.pendingFrames = 0;
            if (this.context) this.nextTime = this.context.currentTime + 0.05;
        }

        async close() {
            this.stop();
            if (this.context) {
                try { await this.context.close(); } catch { }
                this.context = null;
            }
        }
    }

    /* ============================================================
     * Reverse Pipeline Player Manager
     * ============================================================ */
    class PipelineReversePlayer {
        constructor(logger, ui) {
            this.logger = logger;
            this.ui = ui;

            this.CONCURRENCY = 4;
            this.MAX_BUFFERED_FRAMES = 48000 * 8;

            this.reader = null;
            this.metadata = null;
            this.fragments = [];
            this.renderer = null;
            this.decoder = null;

            this.playing = false;
            this.totalDuration = 0;
            this.playedApprox = 0;

            this.nextDownloadIndex = -1;
            this.nextPlayIndex = -1;
            this.pcmBufferMap = new Map();
            this.activeTasks = 0;
            this.timerId = null;
        }

        async load(url) {
            await this.stop();
            this.logger.clear();
            this.ui.info.textContent = "正在加载...";

            this.reader = new HttpRangeReader(url);
            
            // 并行 HEAD + 自适应元数据获取
            const metadataBytes = await this.reader.fetchMetadata();
            
            this.metadata = new Mp4Metadata();
            this.metadata.parseMoov(metadataBytes);

            const sidx = SidxParser.parse(metadataBytes);
            this.fragments = sidx.entries;
            if (sidx.timescale) this.metadata.timescale = sidx.timescale;

            this.totalDuration = this.fragments.reduce((sum, x) => sum + x.duration / this.metadata.timescale, 0);

            this.renderer = new AudioRenderer();
            this.renderer.init(Math.round(this.metadata.sampleRate));
            this.decoder = new PipelineDecoder(this.metadata);

            this.resetCursor();
            this.ui.info.textContent = `${this.fragments.length} fragments · ${this.metadata.sampleRate} Hz · ${formatTime(this.totalDuration)}`;
            this.ui.play.disabled = false;
            this.ui.stop.disabled = false;
            this.ui.pause.disabled = true;
            this.updateProgress();

            this.logger.log("流水线初始化完成，准备就绪。");
        }

        resetCursor() {
            this.nextDownloadIndex = this.fragments.length - 1;
            this.nextPlayIndex = this.fragments.length - 1;
            this.playedApprox = 0;
            this.pcmBufferMap.clear();
        }

        async play() {
            if (!this.renderer) return;
            await this.renderer.resume();

            if (this.playing) return;
            this.playing = true;

            this.ui.play.disabled = true;
            this.ui.play.textContent = "Playing...";
            this.ui.pause.disabled = false;
            this.logger.log("PLAY (流水线启动)");

            this.timerId = setInterval(() => this.schedulePipeline(), 30);
        }

        pause() {
            if (!this.playing) return;
            this.playing = false;
            if (this.timerId) clearInterval(this.timerId);
            this.ui.play.disabled = false;
            this.ui.play.textContent = "Resume";
            this.ui.pause.disabled = true;
            this.logger.log("PAUSE");
        }

        async stop() {
            this.playing = false;
            if (this.timerId) clearInterval(this.timerId);

            if (this.renderer) await this.renderer.close();
            this.renderer = null;
            this.decoder = null;

            this.resetCursor();
            this.ui.play.disabled = false;
            this.ui.play.textContent = "Play";
            this.ui.pause.disabled = true;
            this.ui.stop.disabled = true;
            this.ui.info.textContent = "未加载文件";
            this.updateProgress();
        }

        schedulePipeline() {
            if (!this.playing) return;

            // 1. 串行播放调度 (Consume)
            while (this.pcmBufferMap.has(this.nextPlayIndex)) {
                if (this.renderer.pendingFrames > this.MAX_BUFFERED_FRAMES) break;

                const currentIndex = this.nextPlayIndex;
                const pcm = this.pcmBufferMap.get(currentIndex);
                this.pcmBufferMap.delete(currentIndex);

                if (pcm) {
                    this.renderer.push(pcm.channels, pcm.frames);
                    this.playedApprox += pcm.frames / pcm.sampleRate;
                    this.updateProgress();
                }

                this.nextPlayIndex--;

                if (this.nextPlayIndex < 0) {
                    this.logger.log("Reverse 播放完成。");
                    this.pause();
                    return;
                }
            }

            // 2. 并行下载与解码调度 (Produce)
            while (
                this.activeTasks < this.CONCURRENCY &&
                this.nextDownloadIndex >= 0 &&
                this.pcmBufferMap.size < 12
            ) {
                const indexToFetch = this.nextDownloadIndex--;
                this.activeTasks++;
                this.fetchAndDecodeFragment(indexToFetch).finally(() => {
                    this.activeTasks--;
                });
            }
        }

        async fetchAndDecodeFragment(index) {
            try {
                const fragment = this.fragments[index];
                const bytes = await this.reader.requestRange(fragment.offset, fragment.offset + fragment.size - 1);
                if (!this.playing) return;

                const parsed = Fmp4Parser.parseFragment(bytes, fragment.offset, this.metadata);
                const pcm = await this.decoder.decodeFragment(parsed);
                this.pcmBufferMap.set(index, pcm);
            } catch (error) {
                this.logger.log(`Fragment ${index} 渲染异常:`, error.message || String(error));
                this.pcmBufferMap.set(index, null);
            }
        }

        updateProgress() {
            const position = Math.max(0, this.totalDuration - this.playedApprox);
            const percentage = this.totalDuration > 0 ? ((this.totalDuration - position) / this.totalDuration) * 100 : 0;

            this.ui.progress.style.width = clamp(percentage, 0, 100) + "%";
            this.ui.time.textContent = `${formatTime(position)} / ${formatTime(this.totalDuration)}`;
        }
    }

    // 暴露给全局
    window.AudioReversePlayer = {
        Logger,
        PipelineReversePlayer,
        formatTime
    };
})();