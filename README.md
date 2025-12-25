# Megatorrent Reference Implementation

**Status:** v1.0.0 (Release Candidate)

Megatorrent is a **decentralized, anonymous, and resilient** successor to the BitTorrent protocol. This repository contains the official **Node.js Reference Client** and **C++ Integration Stubs** for qBittorrent.

---

## 🚀 Features

*   **Decentralized Control:** No trackers. Uses Mainline DHT (BEP 44) for finding content and peers.
*   **Total Anonymity:**
    *   End-to-End Encrypted Transport (Noise-like handshake + ChaCha20-Poly1305).
    *   Tor/SOCKS5 Support (`--proxy`).
    *   **PEX Fallback:** Allows Tor users to discover peers via encrypted TCP without leaking UDP DHT traffic.
    *   **Hidden Services:** Support for announcing `.onion` addresses.
*   **Resilience:**
    *   **Active Seeding:** Automatically re-announces held content to the swarm.
    *   **Gossip Protocol:** Pushes updates instantly to connected peers.
    *   **Data Integrity:** SHA256 verification of all blocks.
*   **Ownership & Privacy:**
    *   **Ed25519 Identity:** Channels are owned and signed by cryptographic keys.
    *   **Private Channels:** Encrypted manifests allow restricted access to content metadata.
*   **Scalability:**
    *   **Streaming:** Ingest and reassemble multi-gigabyte files with constant memory usage.
    *   **Padding:** Fixed-size 1MB blobs prevent traffic analysis.

---

## 📦 Installation

### Using Docker (Recommended)
Spin up a local private network with a Bootstrap node and two peers:

```bash
docker-compose up
```

### Manual Installation
```bash
npm install
npm link # Optional: install 'megatorrent' command globally
```

---

## 🛠 Usage

The CLI supports `gen-key`, `ingest`, `publish`, `subscribe`, and `serve` (Daemon).

### 1. Create Identity
```bash
node index.js gen-key
# Output: identity.json, Public Key, and Private URI
```

### 2. Ingest & Publish
Turn a file into encrypted blobs and publish the manifest to the DHT:

```bash
# Ingest (Creates Blobs)
node index.js ingest -i my_movie.mp4

# Publish (Signs & Puts to DHT)
node index.js publish -i my_movie.mp4.json
```

To publish a **Private Channel** (Encrypted Metadata):
```bash
node index.js publish -i file.json -s <32-byte-hex-secret>
```

### 3. Subscribe & Download
```bash
# Public Channel
node index.js subscribe megatorrent://<PublicKey>

# Private Channel
node index.js subscribe megatorrent://<PublicKey>:<ReadKey>

# Via Tor (SOCKS5)
node index.js subscribe megatorrent://... --proxy socks5://127.0.0.1:9050
```

### 4. Daemon Mode (JSON-RPC)
Run as a background service controllable via API or WebUI:
```bash
node index.js serve --port 3000
```

**JSON-RPC Methods:**
*   `POST /api/rpc`
*   `{ "method": "addSubscription", "params": { "uri": "..." } }`
*   `{ "method": "getSubscriptions" }`
*   `{ "method": "getStatus" }`

---

## 🏗 Architecture

### Protocol Stack
1.  **Overlay:** Kademlia DHT (Mainline) for Manifest discovery.
2.  **Transport:** Custom Encrypted TCP (Protocol v5).
3.  **Discovery:** DHT + PEX + Gossip.
4.  **Storage:** Content Addressable Storage (SHA256 Blobs), padded to 1MB.

### Directory Structure
*   `index.js`: CLI Entry Point.
*   `lib/client.js`: Core Logic (MegatorrentClient class).
*   `lib/secure-transport.js`: Encrypted TCP, Handshake, PEX.
*   `lib/dht-real.js`: BEP 44 DHT Wrapper.
*   `lib/storage.js`: Streaming Encryption/Decryption.
*   `qbittorrent/`: Submodule with C++ Stubs (`src/base/megatorrent/`) and WebUI integration.

---

## 📄 Documentation
*   [Protocol Specification (v1.1.0)](docs/PROTOCOL_FINAL.md)
*   [C++ Integration Handoff](docs/HANDOFF.md)

---

## 🔒 Security
*   **Traffic Analysis:** All blobs are padded to exactly `1MB + 16 bytes`.
*   **Integrity:** Corrupt peers are automatically blacklisted for 1 hour.
*   **Versioning:** Handshake includes protocol version check.

---

## License
MIT
