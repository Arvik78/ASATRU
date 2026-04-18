/**
 * SeedSigner PSBT (Partially Signed Bitcoin Transaction) module
 *
 * Creates PSBTs from unsigned Counterparty transactions, displays them as
 * animated QR codes for SeedSigner to sign, and scans the signed PSBT back
 * from the device via webcam.
 *
 * The PSBT binary format follows BIP 174.
 */

// ── helpers ──────────────────────────────────────────────────────────────────

// Encode a value as a Bitcoin-style varint and return a Buffer
function psbtVarInt(n) {
    var buf;
    if (n < 0xfd) {
        buf = buffer.Buffer.allocUnsafe(1);
        buf.writeUInt8(n, 0);
    } else if (n <= 0xffff) {
        buf = buffer.Buffer.allocUnsafe(3);
        buf.writeUInt8(0xfd, 0);
        buf.writeUInt16LE(n, 1);
    } else {
        buf = buffer.Buffer.allocUnsafe(5);
        buf.writeUInt8(0xfe, 0);
        buf.writeUInt32LE(n >>> 0, 1);
    }
    return buf;
}

// Return a Buffer containing a PSBT key-value pair
function psbtKV(key, value) {
    return buffer.Buffer.concat([
        psbtVarInt(key.length),
        key,
        psbtVarInt(value.length),
        value
    ]);
}

// Read a varint from `buf` at `offset`.  Returns { value, bytes }.
function readVarInt(buf, offset) {
    var first = buf.readUInt8(offset);
    if (first < 0xfd) return { value: first, bytes: 1 };
    if (first === 0xfd) return { value: buf.readUInt16LE(offset + 1), bytes: 3 };
    if (first === 0xfe) return { value: buf.readUInt32LE(offset + 1), bytes: 5 };
    // 0xff – 8-byte varint (low 32 bits only; transaction sizes are well within range)
    return { value: buf.readUInt32LE(offset + 1), bytes: 9 };
}

// Encode a BIP 32 derivation path string (e.g. "m/44'/0'/0'/0/0") as the
// sequence of uint32-LE path elements used inside PSBT records.
function encodeBip32Path(path) {
    var parts = path.replace(/^m\//, '').split('/');
    var buf   = buffer.Buffer.allocUnsafe(parts.length * 4);
    parts.forEach(function (part, i) {
        var hardened = part.charAt(part.length - 1) === "'";
        var index    = parseInt(hardened ? part.slice(0, -1) : part, 10);
        if (hardened) index = (index + 0x80000000) >>> 0;
        buf.writeUInt32LE(index >>> 0, i * 4);
    });
    return buf;
}

// ── PSBT creation ─────────────────────────────────────────────────────────────

// Build a BIP 174 PSBT Buffer from a raw unsigned transaction and per-input
// metadata.
//
// inputs: array aligned with tx.ins, each element may have:
//   { prevTxHex, path, pubkey (Buffer or hex string), fingerprint (Buffer or hex, 4 bytes) }
function createPSBTFromUnsignedTx(unsignedTxHex, inputs) {
    var buf = buffer.Buffer;

    // Parse and sanitise the unsigned tx (empty scriptSigs required by BIP 174)
    var tx = bitcoinjs.Transaction.fromHex(unsignedTxHex);
    for (var i = 0; i < tx.ins.length; i++) {
        tx.ins[i].script  = buf.alloc(0);
        tx.ins[i].witness = [];
    }
    var cleanTx = buf.from(tx.toHex(), 'hex');

    // ── Global map ──────────────────────────────────────────────────────────
    var parts = [
        buf.from('70736274ff', 'hex'),                           // magic
        psbtKV(buf.from([0x00]), cleanTx),                       // PSBT_GLOBAL_UNSIGNED_TX
        buf.from([0x00])                                         // separator
    ];

    // ── Per-input maps ───────────────────────────────────────────────────────
    for (var i = 0; i < tx.ins.length; i++) {
        var inputMap = [];
        var inp      = inputs ? inputs[i] : null;

        if (inp) {
            // PSBT_IN_NON_WITNESS_UTXO (type 0x00 key-type byte)
            if (inp.prevTxHex) {
                inputMap.push(psbtKV(
                    buf.from([0x00, 0x01]),
                    buf.from(inp.prevTxHex, 'hex')
                ));
            }

            // PSBT_IN_BIP32_DERIVATION (type 0x06)
            if (inp.pubkey && inp.path) {
                var pubkeyBuf = (typeof inp.pubkey === 'string')
                    ? buf.from(inp.pubkey, 'hex')
                    : inp.pubkey;
                var fpBuf = inp.fingerprint
                    ? (typeof inp.fingerprint === 'string'
                        ? buf.from(inp.fingerprint, 'hex')
                        : inp.fingerprint)
                    : buf.alloc(4);   // unknown master fingerprint → 00000000
                var pathBuf = encodeBip32Path(inp.path);
                inputMap.push(psbtKV(
                    buf.concat([buf.from([0x06]), pubkeyBuf]),
                    buf.concat([fpBuf, pathBuf])
                ));
            }
        }

        inputMap.push(buf.from([0x00])); // separator
        parts.push(buf.concat(inputMap));
    }

    // ── Per-output maps (empty – just separators) ────────────────────────────
    for (var i = 0; i < tx.outs.length; i++) {
        parts.push(buf.from([0x00]));
    }

    return buf.concat(parts);
}

// High-level helper: build a PSBT for a SeedSigner address from an unsigned
// Counterparty transaction.  Fetches the required previous transactions from
// the Counterparty explorer API.
//
// callback(error, psbtBase64)
function createPSBTForSeedSigner(unsignedTxHex, address, network, callback) {
    var net      = (network === 'testnet') ? 'testnet' : 'mainnet';
    var derivInfo = getAddressDerivationInfo(address, net);

    if (!derivInfo) {
        if (callback) callback('Cannot find derivation info for address: ' + address, null);
        return;
    }

    // Parse the unsigned tx and collect input txids
    var tx      = bitcoinjs.Transaction.fromHex(unsignedTxHex);
    var inputIds = [];
    for (var i = 0; i < tx.ins.length; i++) {
        // bitcoinjs stores hashes in internal byte-order; reverse for display
        var txid = tx.ins[i].hash.slice().reverse().toString('hex');
        inputIds.push({ txid: txid, vout: tx.ins[i].index, inputIndex: i });
    }

    if (inputIds.length === 0) {
        if (callback) callback('No inputs found in transaction', null);
        return;
    }

    // Fetch all previous transactions in parallel
    var prevTxs = {};
    var pending = inputIds.length;

    inputIds.forEach(function (inp) {
        getTx(net, inp.txid, function (txInfo) {
            if (txInfo && txInfo.hex) prevTxs[inp.txid] = txInfo.hex;
            pending--;
            if (pending === 0) {
                var inputs = inputIds.map(function (inp) {
                    return {
                        txid:       inp.txid,
                        vout:       inp.vout,
                        prevTxHex:  prevTxs[inp.txid] || null,
                        path:       derivInfo.path,
                        pubkey:     derivInfo.pubkey,
                        fingerprint: buffer.Buffer.alloc(4)
                    };
                });

                try {
                    var psbt       = createPSBTFromUnsignedTx(unsignedTxHex, inputs);
                    var psbtBase64 = psbt.toString('base64');
                    if (callback) callback(null, psbtBase64);
                } catch (e) {
                    if (callback) callback('Error creating PSBT: ' + e.message, null);
                }
            }
        });
    });
}

// ── PSBT parsing ──────────────────────────────────────────────────────────────

// Parse a signed PSBT (base64) returned by SeedSigner and return the final
// broadcast-ready raw transaction hex, or null on failure.
function extractSignedTxFromPSBT(psbtBase64) {
    try {
        var buf  = buffer.Buffer;
        var psbt = buf.from(psbtBase64, 'base64');

        // Verify magic 'psbt' + 0xff
        if (psbt.slice(0, 5).toString('hex') !== '70736274ff') {
            throw new Error('Invalid PSBT magic bytes');
        }

        var offset = 5;

        // ── Parse global map ─────────────────────────────────────────────────
        var globalTxHex = null;
        while (offset < psbt.length) {
            var kl = readVarInt(psbt, offset); offset += kl.bytes;
            if (kl.value === 0) break;
            var key = psbt.slice(offset, offset + kl.value); offset += kl.value;
            var vl  = readVarInt(psbt, offset); offset += vl.bytes;
            var val = psbt.slice(offset, offset + vl.value); offset += vl.value;
            if (key[0] === 0x00) globalTxHex = val.toString('hex');
        }
        if (!globalTxHex) throw new Error('PSBT missing global unsigned transaction');

        var globalTx = bitcoinjs.Transaction.fromHex(globalTxHex);
        var numInputs = globalTx.ins.length;

        // ── Parse per-input maps ─────────────────────────────────────────────
        var inputData = [];
        for (var i = 0; i < numInputs; i++) {
            var inp = { partialSigs: {}, finalScriptSig: null, nonWitnessUtxo: null };
            while (offset < psbt.length) {
                var kl = readVarInt(psbt, offset); offset += kl.bytes;
                if (kl.value === 0) break;
                var key = psbt.slice(offset, offset + kl.value); offset += kl.value;
                var vl  = readVarInt(psbt, offset); offset += vl.bytes;
                var val = psbt.slice(offset, offset + vl.value); offset += vl.value;
                var kt  = key[0];
                if (kt === 0x00) inp.nonWitnessUtxo  = val.toString('hex');
                if (kt === 0x02) inp.partialSigs[key.slice(1).toString('hex')] = val;
                if (kt === 0x07) inp.finalScriptSig  = val;
            }
            inputData.push(inp);
        }

        // ── Reconstruct the final signed transaction ─────────────────────────
        var finalTx    = bitcoinjs.Transaction.fromHex(globalTxHex);
        var allSigned  = true;

        for (var i = 0; i < numInputs; i++) {
            var id = inputData[i];
            if (id.finalScriptSig) {
                finalTx.ins[i].script = id.finalScriptSig;
            } else if (Object.keys(id.partialSigs).length > 0) {
                // P2PKH: scriptSig = <DER sig> <pubkey>
                var pubkeyHex = Object.keys(id.partialSigs)[0];
                var sig       = id.partialSigs[pubkeyHex];
                var pubkey    = buf.from(pubkeyHex, 'hex');
                finalTx.ins[i].script = bitcoinjs.script.compile([sig, pubkey]);
            } else {
                allSigned = false;
            }
        }

        if (!allSigned) throw new Error('Not all inputs are signed');

        return finalTx.toHex();
    } catch (e) {
        console.log('extractSignedTxFromPSBT error:', e);
        return null;
    }
}

// ── QR display ────────────────────────────────────────────────────────────────

// Show the PSBT as an animated sequence of QR codes inside `containerId`.
// Large PSBTs are split into 200-character chunks prefixed with "pNofM:".
function showPSBTQR(psbtBase64, containerId) {
    var container  = $('#' + containerId);
    container.empty();

    var chunkSize  = 200;
    var chunks     = [];
    for (var i = 0; i < psbtBase64.length; i += chunkSize) {
        chunks.push(psbtBase64.slice(i, i + chunkSize));
    }
    var total       = chunks.length;
    var current     = 0;

    var wrapper    = $('<div class="text-center"></div>');
    var qrHolder   = $('<div id="psbt-qr-holder"></div>');
    var statusLine = $('<div class="small text-muted" style="margin-top:6px;"></div>');
    wrapper.append(qrHolder).append(statusLine);
    container.append(wrapper);

    function renderChunk(idx) {
        qrHolder.empty();
        var data = (total > 1)
            ? ('p' + (idx + 1) + 'of' + total + ':' + chunks[idx])
            : psbtBase64;

        var qrDiv = $('<div></div>');
        qrHolder.append(qrDiv);
        qrDiv.qrcode({
            text:         data,
            width:        260,
            height:       260,
            correctLevel: 0   // Level L – lowest error correction, most data capacity
        });
        statusLine.text(
            total > 1
                ? 'Frame ' + (idx + 1) + ' / ' + total + ' – keep QR in view of SeedSigner'
                : 'Scan this QR code with SeedSigner'
        );
    }

    renderChunk(0);

    if (total > 1) {
        var interval = setInterval(function () {
            current = (current + 1) % total;
            renderChunk(current);
        }, 600);
        container.data('psbtQrInterval', interval);
    }
}

// Stop the animated QR display and clean up
function stopPSBTQR(containerId) {
    var container = $('#' + containerId);
    var interval  = container.data('psbtQrInterval');
    if (interval) {
        clearInterval(interval);
        container.removeData('psbtQrInterval');
    }
}

// ── Webcam scanning ───────────────────────────────────────────────────────────

// Start the device webcam and attach the stream to a <video> element.
// callback(error, stream)
function startWebcam(videoElementId, callback) {
    var video = document.getElementById(videoElementId);
    if (!video) { if (callback) callback('Video element not found', null); return; }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        .then(function (stream) {
            video.srcObject = stream;
            video.setAttribute('playsinline', true);
            video.play();
            if (callback) callback(null, stream);
        })
        .catch(function (err) {
            if (callback) callback(err.message || String(err), null);
        });
}

// Stop the webcam attached to a <video> element
function stopWebcam(videoElementId) {
    var video = document.getElementById(videoElementId);
    if (video && video.srcObject) {
        video.srcObject.getTracks().forEach(function (t) { t.stop(); });
        video.srcObject = null;
    }
}

// Scan a signed PSBT QR code (or animated sequence of QR codes) from the
// webcam.  Requires jsQR to be loaded on the page.
//
// callback(psbtBase64) is called once all chunks are received.
// Returns the scan interval ID so the caller can cancel if needed.
function scanSignedPSBT(videoElementId, canvasElementId, statusElementId, callback) {
    var video  = document.getElementById(videoElementId);
    var canvas = document.getElementById(canvasElementId);
    var ctx    = canvas.getContext('2d');
    var chunks = {};
    var totalChunks = 0;
    var lastData    = '';
    var scanInterval;

    function processFrame() {
        if (!video || video.readyState !== video.HAVE_ENOUGH_DATA) return;

        canvas.height = video.videoHeight;
        canvas.width  = video.videoWidth;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        if (typeof jsQR !== 'function') {
            if (statusElementId) {
                $('#' + statusElementId).text('jsQR library not loaded – cannot scan QR codes.');
            }
            return;
        }

        var code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert'
        });

        if (code && code.data && code.data !== lastData) {
            lastData = code.data;
            var data        = code.data.trim();
            var chunkMatch  = data.match(/^p(\d+)of(\d+):(.+)$/);

            if (chunkMatch) {
                var partNum  = parseInt(chunkMatch[1], 10);
                var total    = parseInt(chunkMatch[2], 10);
                var content  = chunkMatch[3];
                totalChunks  = total;
                chunks[partNum] = content;

                if (statusElementId) {
                    $('#' + statusElementId).text(
                        'Received frame ' + Object.keys(chunks).length + ' of ' + total
                    );
                }

                if (Object.keys(chunks).length === totalChunks) {
                    var complete = '';
                    for (var i = 1; i <= totalChunks; i++) complete += (chunks[i] || '');
                    clearInterval(scanInterval);
                    stopWebcam(videoElementId);
                    if (callback) callback(complete);
                }
            } else {
                // Single-frame PSBT
                clearInterval(scanInterval);
                stopWebcam(videoElementId);
                if (callback) callback(data);
            }
        }
    }

    scanInterval = setInterval(processFrame, 150);
    return scanInterval;
}

// Exports (Node.js / test environments)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        psbtVarInt,
        psbtKV,
        readVarInt,
        encodeBip32Path,
        createPSBTFromUnsignedTx,
        createPSBTForSeedSigner,
        extractSignedTxFromPSBT,
        showPSBTQR,
        stopPSBTQR,
        startWebcam,
        stopWebcam,
        scanSignedPSBT
    };
}
