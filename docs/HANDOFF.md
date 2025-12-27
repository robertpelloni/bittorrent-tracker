# Megatorrent C++ Integration Status

This repository contains the C++ stubs and WebUI logic required to integrate the Megatorrent Protocol v2 (Decentralized + Encrypted) into qBittorrent.

## 📁 Preserved Assets
Since the `qbittorrent` submodule points to an external repository, changes made inside it are not persisted in this repo's git history unless moved out.
We have preserved the integration files here:

*   **C++ Core:** `cpp-reference/megatorrent/`
*   **WebUI Scripts:** `webui-reference/`

## 🛠 Integration Steps for C++ Developer

### 1. Copy C++ Source
Copy the contents of `cpp-reference/megatorrent/` to `qbittorrent/src/base/`.
(Note: You may need to flatten the directory structure or update paths in CMakeLists.txt if you prefer `src/base/megatorrent/`).

### 2. Update CMakeLists
Modify `qbittorrent/src/base/CMakeLists.txt` to include the new files:
```cmake
    # megatorrent headers
    dht_client.h
    secure_socket.h
    manifest.h
    global.h

    # megatorrent sources
    dht_client.cpp
    secure_socket.cpp
    manifest.cpp
```

### 3. Copy WebUI Assets
*   Copy `webui-reference/megatorrent.js` to `qbittorrent/src/webui/www/private/scripts/`.
*   Apply the changes in `webui-reference/index.html.patched` to `qbittorrent/src/webui/www/private/index.html` (Add script tag + Tab link).

### 4. Link Dependencies
Ensure `libtorrent` and `OpenSSL` are correctly linked. The provided stubs use `Crypto::` namespace placeholders that must be backed by real OpenSSL EVP calls.

### 5. WebAPI Registration (Controller)
To enable the WebUI frontend to talk to the backend:
1.  Copy `megatorrentcontroller.h/cpp` to `qbittorrent/src/webui/api/`.
2.  Modify `qbittorrent/src/webui/webapplication.cpp` (or similar router):
    *   Include `megatorrentcontroller.h`
    *   In `registerControllers()` (or constructor), add:
        ```cpp
        registerController<MegatorrentController>(u"megatorrent"_s);
        ```
    *   This maps:
        *   `/api/v2/megatorrent/addSubscription` -> `addSubscriptionAction`
        *   `/api/v2/megatorrent/removeSubscription` -> `removeSubscriptionAction`
        *   `/api/v2/megatorrent/getSubscriptions` -> `getSubscriptionsAction`

---

## 🧩 Component Details

### `dht_client.h/cpp` (Decentralized Control)
*   **Purpose:** Replaces the deprecated WebSocket Tracker.
*   **Functionality:** Handles `putManifest` (BEP 44), `getManifest`, `announceBlob`, and `findBlobPeers`.
*   **Gateway Extension:** Implements `relaySignedPut` to support anonymous publishing via Gateway (Protocol v5).

### `secure_socket.h/cpp` (Encrypted Transport)
*   **Purpose:** Implements the custom Encrypted Transport Protocol (v5).
*   **Functionality:** Ephemeral ECDH Handshake, ChaCha20-Poly1305 Encryption, Binary Packet Parsing (`MSG_HELLO`, `MSG_DATA`, `MSG_PUBLISH`, etc.).

### `manifest.h/cpp` (Data Structure)
*   **Purpose:** Parses and validates the JSON Manifest format and Ed25519 signatures.

### `blob_downloader.h/cpp` (Transfer)
*   **Purpose:** Orchestrates the download of a single blob.
*   **Logic:** Connects via `SecureSocket`, performs handshake (Protocol v5), requests blob by ID, validates SHA256 hash.

## 6. GUI Integration Guide

The `BitTorrent::Session` interface has been extended to support Megatorrent operations. You can now access these methods from the GUI code (e.g., `MainWindow` or a new `SubscriptionsDialog`).

### Available Methods
```cpp
// Add a new subscription (channel)
// publicKey: 64-char Hex String (Ed25519 Public Key)
// label: Human readable name
bool Session::instance()->addMegatorrentSubscription(const QString &publicKey, const QString &label);

// Remove a subscription
bool Session::instance()->removeMegatorrentSubscription(const QString &publicKey);
```

### Implementation Steps for UI Developer
1.  Create a new `SubscriptionsWidget` or `Dialog` in `src/gui`.
2.  Add a list view to show subscriptions (currently requires reading the JSON config file manually or extending the Session API further to `getSubscriptions`).
3.  Add "Add Subscription" button that calls `Session::instance()->addMegatorrentSubscription(...)`.
4.  Downloads will automatically appear in the configured Download path under a `Megatorrent` folder.
