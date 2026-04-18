/**
 * SeedSigner Integration
 *
 * Provides the SeedSignerWallet class and the dialog-level functions that
 * wire together watch-only address management, PSBT creation, animated QR
 * display, signed-PSBT scanning, and transaction broadcast.
 *
 * Wallet type 9 (SEEDSIGNER_WALLET_TYPE) is used for all SeedSigner entries.
 */

// ── SeedSignerWallet class ────────────────────────────────────────────────────

class SeedSignerWallet {
    /**
     * @param {string} xpub       Account-level xpub (m/44'/0'/0')
     * @param {string} network    'mainnet' | 'testnet'
     * @param {string} label      Human-readable wallet name
     * @param {number} addrCount  Number of addresses to derive on import
     */
    constructor(xpub, network, label, addrCount) {
        this.xpub         = xpub         || '';
        this.network      = network      || 'mainnet';
        this.label        = label        || 'SeedSigner Wallet';
        this.addrCount    = addrCount    || 10;
        this.addresses    = [];  // [{ address, path, index, pubkey }]
        this.balances     = {};  // address → [ {asset, quantity, …} ]
        this.utxos        = {};  // address → [ utxo ]
        this._scanInterval = null;
    }

    // Import and derive addresses, persist to wallet
    initialize(callback) {
        var result = importWatchOnlyWallet(
            this.xpub, this.label, this.network, this.addrCount
        );
        if (result.error) {
            if (callback) callback(result.error);
            return;
        }
        this.addresses = result.addresses;
        this.refreshBalance(callback);
    }

    // Refresh UTXOs and Counterparty balances for all managed addresses
    refreshBalance(callback) {
        var self    = this;
        var addrList = this.addresses.map(function (a) { return a.address; });
        var pending  = 2;

        prepareAddressesForPSBT(addrList, this.network, function (utxoMap) {
            self.utxos = utxoMap;
            pending--;
            if (pending === 0 && callback) callback(null);
        });

        var remaining = addrList.length;
        if (remaining === 0) {
            pending--;
            if (pending === 0 && callback) callback(null);
            return;
        }
        addrList.forEach(function (addr) {
            getCounterpartyBalances(addr, self.network, function (bals) {
                self.balances[addr] = bals;
                remaining--;
                if (remaining === 0) {
                    pending--;
                    if (pending === 0 && callback) callback(null);
                }
            });
        });
    }

    // Return combined BTC balance (satoshis) across all addresses
    getBalance() {
        var total = 0;
        Object.values(this.utxos).forEach(function (utxoList) {
            utxoList.forEach(function (u) { total += (u.value || 0); });
        });
        return total;
    }

    // Return all Counterparty asset balances across all addresses
    getAllAssetBalances() {
        var combined = {};
        Object.values(this.balances).forEach(function (bals) {
            bals.forEach(function (b) {
                var key = b.asset;
                combined[key] = (combined[key] || 0) + (b.quantity || 0);
            });
        });
        return combined;
    }

    // Prepare a send transaction and invoke the SeedSigner sign dialog.
    // Uses createSend / cpSend via the existing Counterparty workflow.
    prepareSendTransaction(destination, asset, amount, fee, memoText, memoIsHex, callback) {
        var self    = this;
        var source  = this.addresses.length > 0 ? this.addresses[0].address : '';
        var net     = this.network;

        if (!source) {
            if (callback) callback('No addresses available in this wallet');
            return;
        }

        createSend(net, source, destination, memoText || '', memoIsHex || false,
            asset, amount, fee, function (o) {
                var unsignedTx = getRawTransaction(o);
                if (!unsignedTx) {
                    if (callback) callback('Failed to create unsigned transaction');
                    return;
                }
                // Hand off to the PSBT → QR → scan → broadcast workflow
                self._signViaSeedSigner(source, unsignedTx, net, callback);
            }
        );
    }

    // Internal: run the full PSBT / QR signing workflow
    _signViaSeedSigner(source, unsignedTxHex, network, callback) {
        var self = this;
        createPSBTForSeedSigner(unsignedTxHex, source, network, function (err, psbtBase64) {
            if (err) {
                if (callback) callback('PSBT creation failed: ' + err);
                return;
            }
            // Show the SeedSigner sign dialog
            dialogSeedSignerSign(psbtBase64, network, function (signedTxHex) {
                if (!signedTxHex) {
                    if (callback) callback('Signing cancelled or failed');
                    return;
                }
                self.broadcastTransaction(signedTxHex, network, callback);
            });
        });
    }

    // Broadcast a signed raw transaction
    broadcastTransaction(signedTxHex, network, callback) {
        broadcastTransaction(network || this.network, signedTxHex, function (txid) {
            if (callback) callback(txid ? null : 'Broadcast failed', txid);
        });
    }

    // Poll the explorer for a transaction status
    getTransactionStatus(txid, callback) {
        var url = FW.EXPLORER_API + '/tx/' + txid;
        $.getJSON(url, function (data) {
            if (callback) callback(null, data);
        }).fail(function () {
            if (callback) callback('Could not fetch transaction status', null);
        });
    }
}

// ── Dialog: import SeedSigner xpub ───────────────────────────────────────────

// Open a dialog that lets the user paste or scan an xpub and imports the
// resulting watch-only addresses into the wallet.
function dialogImportSeedSignerXpub() {
    if (dialogCheckLocked('add SeedSigner addresses')) return;

    BootstrapDialog.show({
        type:            'type-default',
        id:              'dialog-seedsigner-import',
        closeByBackdrop: false,
        title:           '<i class="fa fa-fw fa-qrcode"></i> Import SeedSigner xpub',
        message:         $('<div></div>').load('html/address/import-seedsigner.html')
    });
}

// ── Dialog: SeedSigner sign workflow ─────────────────────────────────────────

// Show the animated PSBT QR, wait for the user to scan the signed PSBT back,
// then call callback(signedTxHex) or callback(null) on cancel.
function dialogSeedSignerSign(psbtBase64, network, callback) {
    BootstrapDialog.show({
        type:            'type-default',
        id:              'dialog-seedsigner-sign',
        closeByBackdrop: false,
        title:           '<i class="fa fa-fw fa-qrcode"></i> Sign with SeedSigner',
        message:         $('<div></div>').load('html/sign/seedsigner.html'),
        onshown: function (dialog) {
            // Give the HTML a moment to load before we interact with it
            setTimeout(function () {
                // Display the PSBT QR
                showPSBTQR(psbtBase64, 'seedsigner-psbt-qr');

                // Wire up "Scan signed PSBT" button
                $('#btn-seedsigner-scan').off('click').on('click', function () {
                    $('#seedsigner-scan-area').show();
                    $('#seedsigner-status').text('Starting webcam…');
                    startWebcam('seedsigner-video', function (err) {
                        if (err) {
                            $('#seedsigner-status').text('Webcam error: ' + err);
                            return;
                        }
                        $('#seedsigner-status').text('Point your webcam at the SeedSigner screen');
                        scanSignedPSBT(
                            'seedsigner-video',
                            'seedsigner-canvas',
                            'seedsigner-status',
                            function (scannedPsbtBase64) {
                                $('#seedsigner-status').text('Decoding signed PSBT…');
                                stopPSBTQR('seedsigner-psbt-qr');
                                var signedTxHex = extractSignedTxFromPSBT(scannedPsbtBase64);
                                if (signedTxHex) {
                                    $('#seedsigner-status').text('PSBT decoded – ready to broadcast.');
                                    dialog.close();
                                    if (callback) callback(signedTxHex);
                                } else {
                                    $('#seedsigner-status').text(
                                        'Could not decode signed PSBT. Please try again.'
                                    );
                                }
                            }
                        );
                    });
                });

                // Cancel button
                $('#btn-seedsigner-cancel').off('click').on('click', function () {
                    stopWebcam('seedsigner-video');
                    stopPSBTQR('seedsigner-psbt-qr');
                    dialog.close();
                    if (callback) callback(null);
                });
            }, 300);
        },
        onhide: function () {
            stopWebcam('seedsigner-video');
            stopPSBTQR('seedsigner-psbt-qr');
        }
    });
}

// ── High-level workflow helpers ───────────────────────────────────────────────

// Full send workflow for a SeedSigner address:
//   createSend → PSBT → QR → scan → broadcast
// Mirrors cpSend but routes signing through SeedSigner.
function seedSignerSend(network, source, destination, memo, memoIsHex, asset, amount, fee, callback) {
    var cb = (typeof callback === 'function') ? callback : false;
    updateTransactionStatus('pending', 'Generating Counterparty transaction…');

    createSend(network, source, destination, memo, memoIsHex, asset, amount, fee, function (o) {
        var unsignedTx = getRawTransaction(o);
        if (!unsignedTx) {
            updateTransactionStatus('error', 'Error generating transaction!');
            if (cb) cb(null);
            return;
        }

        updateTransactionStatus('pending', 'Creating PSBT for SeedSigner…');
        createPSBTForSeedSigner(unsignedTx, source, network, function (err, psbtBase64) {
            if (err) {
                updateTransactionStatus('error', 'PSBT creation failed: ' + err);
                if (cb) cb(null);
                return;
            }

            updateTransactionStatus('pending', 'Waiting for SeedSigner signature…');
            dialogSeedSignerSign(psbtBase64, network, function (signedTxHex) {
                if (!signedTxHex) {
                    updateTransactionStatus('error', 'Signing cancelled or failed.');
                    if (cb) cb(null);
                    return;
                }

                updateTransactionStatus('pending', 'Broadcasting signed transaction…');
                broadcastTransaction(network, signedTxHex, function (txid) {
                    if (txid) {
                        updateTransactionStatus('success', 'Transaction broadcast!');
                        if (cb) cb(txid);
                    } else {
                        updateTransactionStatus('error', 'Broadcast failed!');
                        if (cb) cb(null);
                    }
                });
            });
        });
    });
}

// Import a wallet from a seed phrase (compatibility shim – not used for
// SeedSigner but kept so existing callers don't break)
async function importWallet(seed) {
    console.warn('importWallet: use importWatchOnlyWallet(xpub, …) for SeedSigner wallets');
    return null;
}

// Exports (Node.js / test environments)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SeedSignerWallet,
        dialogImportSeedSignerXpub,
        dialogSeedSignerSign,
        seedSignerSend,
        importWallet
    };
}