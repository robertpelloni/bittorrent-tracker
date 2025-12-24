# Megatorrent Protocol Specification (Final)

**Status:** Reference Implementation Complete
**Version:** 1.0.0

## Overview
Megatorrent is a decentralized, anonymous, and resilient content distribution protocol designed as a successor to BitTorrent. It eliminates central points of failure (trackers) and obfuscates traffic to prevent censorship and surveillance.

---

## 1. Decentralized Control Plane
Megatorrent uses the Mainline BitTorrent DHT (BEP 44) for all control operations.

### 1.1 Identity
*   **Users:** Identified by Ed25519 Public Keys.
*   **Channels:** A channel is simply a stream of updates signed by a specific Identity.

### 1.2 Manifests (Mutable Items)
*   Content metadata is stored in a JSON **Manifest**.
*   Manifests are published to the DHT as Mutable Items (`salt` optional, `seq` monotonic).
*   **Structure:**
    ```json
    {
      "publicKey": "<Ed25519 PubKey>",
      "sequence": <Timestamp>,
      "signature": "<Ed25519 Sig>",
      "collections": [ ... ],
      "encrypted": false // or true
    }
    ```
*   **Private Channels:** If `encrypted: true`, the content payload is encrypted with ChaCha20-Poly1305 using a shared secret (Read Key).

### 1.3 Blob Discovery
*   Files are split into chunks, encrypted, and hashed to create **Blobs**.
*   **Blob ID:** SHA256(EncryptedBlob).
*   **Announcement:** Peers announce Blob IDs to the DHT via standard `announce_peer`.
*   **Lookup:** Peers find locations via `get_peers` (DHT) or PEX.

---

## 2. Encrypted Transport (Anonymity)
All peer-to-peer traffic is wrapped in a custom encrypted transport layer to prevent Deep Packet Inspection (DPI) and traffic analysis.

### 2.1 Handshake (Noise-IK Simplified)
1.  **Client:** Generates Ephemeral X25519 (`EphPub`). Sends to Server.
2.  **Server:** Generates Ephemeral X25519. Sends to Client.
3.  **Key Derivation:** Both derive `Tx`/`Rx` keys using BLAKE2b on the ECDH shared secret.

### 2.2 Framing
*   Packet: `[Length (2B)] [Ciphertext (Payload + 16B MAC)]`
*   Cipher: ChaCha20-Poly1305.

### 2.3 Protocol Messages
*   `MSG_HELLO (0x01)`: Handshake completion + Gossip (JSON payload of known sequences).
*   `MSG_REQUEST (0x02)`: Request a Blob by ID (ASCII).
*   `MSG_DATA (0x03)`: Binary Blob Data.
*   `MSG_FIND_PEERS (0x04)`: Request PEX for a Blob ID.
*   `MSG_PEERS (0x05)`: List of peers (JSON).
*   `MSG_ERROR (0xFF)`: Error message.

---

## 3. Traffic Analysis Resistance
*   **Fixed-Size Blobs:** All blobs are padded to exactly `1MB + 16 bytes`.
*   **Random Padding:** Unused space in a chunk is filled with random noise before encryption.
*   **Result:** An observer cannot distinguish between a text file and a video segment, nor infer file size from packet lengths.

---

## 4. Redundancy & Resilience
*   **Active Seeding:** Clients automatically re-announce downloaded blobs to the DHT every 15 minutes.
*   **Gossip:** Clients exchange subscription state (`latestSequence`) upon connection, allowing updates to propagate instantly (Push) without waiting for DHT polling.

---

## 5. Tor Integration
*   **SOCKS5:** The Reference Client supports SOCKS5 proxies (`--proxy`).
*   **PEX Fallback:** Since Tor cannot carry UDP (DHT), clients behind Tor use `MSG_FIND_PEERS` over the encrypted TCP connection to discover content via their peers.

---

## 6. Architecture
```
[ User ] -> [ CLI / WebUI ]
                 |
        [ Megatorrent Client ]
        /        |         \
   [DHT]    [Peer Swarm]  [Disk]
(UDP/PEX)   (Secure TCP)  (Blobs)
```
