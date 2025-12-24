# Megatorrent C++ Integration Status

This repository contains the C++ stubs required to integrate the Megatorrent Protocol v2 (Decentralized + Encrypted) into qBittorrent.

## Implemented Stubs
Location: `qbittorrent/src/base/megatorrent/`

### 1. `dht_client.h/cpp` (Decentralized Control)
*   **Purpose:** Replaces the deprecated WebSocket Tracker.
*   **Functionality:**
    *   `putManifest`: Stores signed Manifests as Mutable Items (BEP 44) in the DHT.
    *   `getManifest`: Retrieves Manifests by Public Key.
    *   `announceBlob`: Announces Blobs (InfoHash) to the DHT swarm.
    *   `findBlobPeers`: Looks up peers for a given Blob ID.
*   **Implementation Requirements:** Needs to be linked against `libtorrent-rasterbar`'s DHT APIs (`dht_put_item`, `dht_get_item`, `dht_announce`, `dht_get_peers`).

### 2. `secure_socket.h/cpp` (Encrypted Transport)
*   **Purpose:** Implements the custom Noise-like Encrypted Transport Protocol to hide traffic from ISPs.
*   **Functionality:**
    *   Performs Ephemeral ECDH Handshake (X25519).
    *   Derives Shared Secrets (BLAKE2b).
    *   Encrypts/Decrypts frames (ChaCha20-Poly1305).
*   **Implementation Requirements:** Needs to be linked against OpenSSL (`EVP_PKEY`, `EVP_CIPHER_chacha20_poly1305`, etc.). The provided code contains placeholder `Crypto::` namespace calls.

### 3. `manifest.h/cpp` (Data Structure)
*   **Purpose:** Parses and validates the JSON Manifest format.
*   **Functionality:**
    *   Ed25519 Signature Verification.
    *   JSON Serialization/Deserialization.
*   **Implementation Requirements:** Uses `QJsonDocument` (Qt) and requires OpenSSL for Ed25519 verification.

## Next Steps for C++ Developer
1.  **Link Dependencies:** Ensure `libtorrent` and `OpenSSL` are correctly linked in `CMakeLists.txt` (Already registered).
2.  **Fill Crypto Stubs:** Implement the functions in `secure_socket.cpp` using OpenSSL EVP APIs.
3.  **Fill DHT Stubs:** Connect `dht_client.cpp` to the `libtorrent` session instance available in qBittorrent (`Session::nativeSession()`).
