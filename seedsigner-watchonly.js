/**
 * SeedSigner Watch-Only Wallet
 *
 * Supports importing an xpub from a SeedSigner QR code and deriving
 * BIP44 P2PKH addresses (m/44'/0'/0'/0/index) from it.
 *
 * Wallet type 9 is reserved for SeedSigner watch-only addresses.
 */

var SEEDSIGNER_WALLET_TYPE = 9;

// Validate an xpub string using the bundled bitcoinjs bip32 module
function validateXpub(xpub, network) {
    var net = (network === 'testnet') ? bitcoinjs.networks.testnet : bitcoinjs.networks.bitcoin;
    try {
        bitcoinjs.bip32.fromBase58(xpub, net);
        return true;
    } catch (e) {
        return false;
    }
}

// Derive BIP44 P2PKH addresses from an account-level xpub
// (m/44'/0'/0' for mainnet).  The xpub covers the external chain so child
// paths are simply 0/index.
// Returns an array of { address, path, index, pubkey } objects.
function deriveAddresses(xpub, count, network, startIndex) {
    var net = (network === 'testnet') ? bitcoinjs.networks.testnet : bitcoinjs.networks.bitcoin;
    var node = bitcoinjs.bip32.fromBase58(xpub, net);
    count = count || 10;
    startIndex = startIndex || 0;
    var addresses = [];
    for (var i = startIndex; i < startIndex + count; i++) {
        var child  = node.derive(0).derive(i);
        var p2pkh  = bitcoinjs.payments.p2pkh({ pubkey: child.publicKey, network: net });
        addresses.push({
            address: p2pkh.address,
            path:    "m/44'/0'/0'/0/" + i,
            index:   i,
            pubkey:  child.publicKey.toString('hex')
        });
    }
    return addresses;
}

// Return the derived public key buffer for a specific child index
function getChildPubKey(xpub, index, network) {
    var net  = (network === 'testnet') ? bitcoinjs.networks.testnet : bitcoinjs.networks.bitcoin;
    var node = bitcoinjs.bip32.fromBase58(xpub, net);
    return node.derive(0).derive(index).publicKey;
}

// Import a watch-only wallet from an xpub string.
// Derives `addressCount` addresses and registers them in the wallet with
// type SEEDSIGNER_WALLET_TYPE (9), storing the xpub on each entry so that
// PSBT creation can later look it up.
function importWatchOnlyWallet(xpub, label, network, addressCount) {
    network      = network      || 'mainnet';
    label        = label        || 'SeedSigner Wallet';
    addressCount = addressCount || 10;

    if (!validateXpub(xpub, network)) {
        return { error: 'Invalid xpub – please check the value and try again.' };
    }

    var addresses = deriveAddresses(xpub, addressCount, network, 0);
    var added     = 0;

    addresses.forEach(function (addrInfo) {
        var result = addWalletAddress(
            network,
            addrInfo.address,
            label + ' #' + addrInfo.index,
            SEEDSIGNER_WALLET_TYPE,
            addrInfo.index,
            addrInfo.path
        );
        if (result) {
            // Attach xpub so PSBT creation can derive the signing key later
            result.xpub = xpub;
            added++;
        }
    });

    // Persist
    ls.setItem('walletAddresses', JSON.stringify(FW.WALLET_ADDRESSES));

    return { success: true, addresses: addresses, added: added };
}

// Scan an xpub QR code using the device webcam.
// Calls callback(xpub) once a valid xpub is found, or callback(null) on error.
function scanXpubQR(videoElementId, canvasElementId, network, callback) {
    var video = document.getElementById(videoElementId);
    var canvas = document.getElementById(canvasElementId);
    var ctx    = canvas.getContext('2d');
    var scanInterval;

    function processFrame() {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.height = video.videoHeight;
            canvas.width  = video.videoWidth;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

            if (typeof jsQR === 'function') {
                var code = jsQR(imageData.data, imageData.width, imageData.height, {
                    inversionAttempts: 'dontInvert'
                });
                if (code && code.data) {
                    var data = code.data.trim();
                    // Accept bare xpub / ypub / zpub strings
                    if (/^[xyz]pub[A-Za-z0-9]+$/.test(data) && validateXpub(data, network)) {
                        clearInterval(scanInterval);
                        stopWebcam(videoElementId);
                        if (callback) callback(data);
                    }
                }
            }
        }
    }

    scanInterval = setInterval(processFrame, 150);
    return scanInterval;
}

// Fetch UTXOs for a single address via the Counterparty explorer API
function checkBalance(address, network, callback) {
    getUTXOs(network, address, function (utxos) {
        if (callback) callback(utxos || []);
    });
}

// Fetch Counterparty token balances for a watch-only address
function getCounterpartyBalances(address, network, callback) {
    var netId = (network === 'testnet') ? 2 : 1;
    var url   = getExplorerAPI(netId) + '/api/balances/' + address;
    $.getJSON(url, function (data) {
        if (callback) callback(data || []);
    }).fail(function () {
        if (callback) callback([]);
    });
}

// Fetch UTXOs for multiple addresses and return a combined map
function prepareAddressesForPSBT(addresses, network, callback) {
    var result  = {};
    var pending = addresses.length;
    if (pending === 0) { if (callback) callback({}); return; }

    addresses.forEach(function (addr) {
        getUTXOs(network, addr, function (utxos) {
            result[addr] = utxos || [];
            pending--;
            if (pending === 0 && callback) callback(result);
        });
    });
}

// Return metadata stored for an xpub (e.g. first address, label)
function getXpubInfo(xpub, network) {
    var addresses = deriveAddresses(xpub, 1, network, 0);
    return {
        xpub:    xpub,
        network: network || 'mainnet',
        firstAddress: addresses[0] ? addresses[0].address : null
    };
}

// Persist a list of {address, path, index, pubkey} objects (already stored via
// addWalletAddress – this helper is kept for compatibility).
function storeWalletAddresses(addresses) {
    ls.setItem('walletAddresses', JSON.stringify(FW.WALLET_ADDRESSES));
}

// Check whether a given address belongs to a SeedSigner watch-only wallet
function isSeedSignerWallet(address) {
    var info = getWalletAddressInfo(address);
    return !!(info && info.type === SEEDSIGNER_WALLET_TYPE);
}

// Return the xpub stored on a SeedSigner wallet address entry
function getSeedSignerXpub(address) {
    var info = getWalletAddressInfo(address);
    return (info && info.type === SEEDSIGNER_WALLET_TYPE) ? (info.xpub || null) : null;
}

// Return derivation info needed for PSBT creation
function getAddressDerivationInfo(address, network) {
    var info = getWalletAddressInfo(address);
    if (!info || info.type !== SEEDSIGNER_WALLET_TYPE || !info.xpub) return null;

    var net   = (network === 'testnet') ? bitcoinjs.networks.testnet : bitcoinjs.networks.bitcoin;
    var node  = bitcoinjs.bip32.fromBase58(info.xpub, net);
    var index = (info.index !== undefined && info.index !== null) ? parseInt(info.index) : 0;
    var child = node.derive(0).derive(index);

    return {
        address: address,
        path:    info.path || ("m/44'/0'/0'/0/" + index),
        pubkey:  child.publicKey,
        index:   index,
        xpub:    info.xpub
    };
}

// High-level convenience: import wallet from xpub and check balances
function importWatchOnlyFlow(xpub, label, network, addressCount, callback) {
    var result = importWatchOnlyWallet(xpub, label, network, addressCount);
    if (result.error) {
        if (callback) callback(result);
        return;
    }
    var addrs = result.addresses.map(function (a) { return a.address; });
    prepareAddressesForPSBT(addrs, network, function (utxoMap) {
        result.utxos = utxoMap;
        if (callback) callback(result);
    });
}

// Exports (for Node.js / testing environments)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SEEDSIGNER_WALLET_TYPE,
        validateXpub,
        deriveAddresses,
        getChildPubKey,
        importWatchOnlyWallet,
        scanXpubQR,
        checkBalance,
        getCounterpartyBalances,
        prepareAddressesForPSBT,
        getXpubInfo,
        storeWalletAddresses,
        isSeedSignerWallet,
        getSeedSignerXpub,
        getAddressDerivationInfo,
        importWatchOnlyFlow
    };
}