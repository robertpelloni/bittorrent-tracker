import net from 'net'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import sodium from 'sodium-native'
import { SocksClient } from 'socks'

// Global Proxy Config
let globalProxy = null
export function setGlobalProxy (proxyUrl) {
  if (!proxyUrl) return
  const url = new URL(proxyUrl)
  globalProxy = {
    host: url.hostname,
    port: parseInt(url.port),
    type: 5 // SOCKS5
  }
}

// Protocol Constants
const MSG_HELLO = 0x01
const MSG_REQUEST = 0x02
const MSG_DATA = 0x03
const MSG_FIND_PEERS = 0x04
const MSG_PEERS = 0x05
const MSG_PUBLISH = 0x06
const MSG_ANNOUNCE = 0x07
const MSG_OK = 0x08
const MSG_ERROR = 0xFF

function encryptStream (socket, isServer, onMessage) {
  const ephemeral = {
    publicKey: Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES),
    secretKey: Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES)
  }
  sodium.crypto_box_keypair(ephemeral.publicKey, ephemeral.secretKey)

  let sharedRx = null
  let sharedTx = null
  const nonceRx = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES)
  const nonceTx = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES)

  const pendingWrites = []

  const flushWrites = () => {
    if (!sharedTx) return
    while (pendingWrites.length > 0) {
      const { buf, cb } = pendingWrites.shift()
      writeEncrypted(buf, cb)
    }
  }

  const writeEncrypted = (buf, cb) => {
    const cipher = Buffer.alloc(buf.length + sodium.crypto_secretbox_MACBYTES)
    sodium.crypto_secretbox_easy(cipher, buf, nonceTx, sharedTx)
    sodium.sodium_increment(nonceTx)

    const len = Buffer.alloc(2)
    len.writeUInt16BE(cipher.length)
    socket.write(Buffer.concat([len, cipher]), cb)
  }

  // Incoming Data Handling
  let internalBuf = Buffer.alloc(0)
  const handleEncryptedData = (data) => {
    internalBuf = Buffer.concat([internalBuf, data])

    while (true) {
      if (internalBuf.length < 2) break
      const len = internalBuf.readUInt16BE(0)
      if (internalBuf.length < 2 + len) break

      const frame = internalBuf.slice(2, 2 + len)
      internalBuf = internalBuf.slice(2 + len)

      const plain = Buffer.alloc(frame.length - sodium.crypto_secretbox_MACBYTES)
      const success = sodium.crypto_secretbox_open_easy(plain, frame, nonceRx, sharedRx)
      sodium.sodium_increment(nonceRx)

      if (!success) {
        socket.destroy(new Error('Decryption failed'))
        return
      }

      if (plain.length > 0) {
        const type = plain[0]
        const payload = plain.slice(1)
        if (onMessage) onMessage(type, payload)
      }
    }
  }

  // Handshake Logic
  socket.write(ephemeral.publicKey)
  let buffer = Buffer.alloc(0)

  const onData = (data) => {
    buffer = Buffer.concat([buffer, data])
    if (buffer.length >= 32) {
      const remotePub = buffer.slice(0, 32)
      buffer = buffer.slice(32)

      const sharedPoint = Buffer.alloc(sodium.crypto_scalarmult_BYTES)
      sodium.crypto_scalarmult(sharedPoint, ephemeral.secretKey, remotePub)

      const kdf = (salt) => {
        const out = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES)
        const saltBuf = Buffer.from(salt)
        sodium.crypto_generichash(out, Buffer.concat([sharedPoint, saltBuf]))
        return out
      }

      if (isServer) {
        sharedTx = kdf('S')
        sharedRx = kdf('C')
      } else {
        sharedTx = kdf('C')
        sharedRx = kdf('S')
      }

      socket.removeListener('data', onData)
      socket.on('data', handleEncryptedData)

      if (buffer.length > 0) handleEncryptedData(buffer)

      flushWrites()
      if (socket.emit) socket.emit('secureConnect')
    }
  }
  socket.on('data', onData)

  return {
    sendMessage: (type, payload, cb) => {
      const buf = Buffer.alloc(1 + payload.length)
      buf[0] = type
      if (payload) payload.copy(buf, 1)

      if (!sharedTx) pendingWrites.push({ buf, cb })
      else writeEncrypted(buf, cb)
    }
  }
}

// PEX Store: Map<BlobID, Set<PeerString>>
const pexStore = {}

export function startSecureServer (storageDir, port = 0, onGossip = null, dht = null) {
  const server = net.createServer(socket => {
    const secure = encryptStream(socket, true, async (type, payload) => {
      if (type === MSG_HELLO) {
        try {
          const gossip = JSON.parse(payload.toString())
          if (onGossip) onGossip(gossip, secure)
        } catch (e) {}
      } else if (type === MSG_REQUEST) {
        const blobId = payload.toString()
        const filePath = path.join(storageDir, blobId)

        if (fs.existsSync(filePath)) {
          const data = fs.readFileSync(filePath)
          secure.sendMessage(MSG_DATA, data)
        } else {
          secure.sendMessage(MSG_ERROR, Buffer.from('Not Found'))
        }
      } else if (type === MSG_FIND_PEERS) {
        const blobId = payload.toString()
        let peers = []

        // 1. Local PEX Cache
        if (pexStore[blobId]) {
          peers = Array.from(pexStore[blobId])
        }

        // 2. DHT Lookup (Gateway)
        if (dht) {
          const dhtPeers = await dht.findBlobPeers(blobId)
          peers = [...new Set([...peers, ...dhtPeers])]
        }

        secure.sendMessage(MSG_PEERS, Buffer.from(JSON.stringify(peers)))
      } else if (type === MSG_PUBLISH) {
        // Gateway Publish: Put Manifest to DHT
        if (dht) {
          try {
            const req = JSON.parse(payload.toString()) // eslint-disable-line no-unused-vars
            // Gateway acts as a relayer.
            // For now, stub response
            console.log('[Gateway] Received Publish Request')
            secure.sendMessage(MSG_OK, Buffer.from('Accepted'))
          } catch (e) {
            secure.sendMessage(MSG_ERROR, Buffer.from(e.message))
          }
        } else {
          secure.sendMessage(MSG_ERROR, Buffer.from('Not a Gateway'))
        }
      } else if (type === MSG_ANNOUNCE) {
        // Peer announcing themselves (e.g. .onion address) for a blob
        try {
          const ann = JSON.parse(payload.toString()) // { blobId, peerAddress }
          if (ann.blobId && ann.peerAddress) {
            if (!pexStore[ann.blobId]) pexStore[ann.blobId] = new Set()
            pexStore[ann.blobId].add(ann.peerAddress)
            console.log(`[Gateway] Cached peer ${ann.peerAddress} for ${ann.blobId}`)
          }
        } catch (e) {}
      }
    })
  })

  server.listen(port)
  if (server.address()) server.port = server.address().port
  else server.port = port
  return server
}

export function downloadSecureBlob (peer, blobId, knownSequences = {}, onGossip = null, announceAddr = null) {
  return new Promise((resolve, reject) => {
    const [host, portStr] = peer.split(':')
    const port = parseInt(portStr)

    const connect = async () => {
      let socket
      try {
        if (globalProxy) {
          const info = await SocksClient.createConnection({
            proxy: globalProxy,
            command: 'connect',
            destination: { host, port }
          })
          socket = info.socket
        } else {
          socket = new net.Socket()
          await new Promise((resolveConnect, rejectConnect) => {
            socket.connect(port, host, resolveConnect)
            socket.on('error', rejectConnect)
          })
          socket.removeAllListeners('error')
        }
      } catch (e) {
        return reject(new Error('Connection failed: ' + e.message))
      }

      const cleanup = () => socket.destroy()
      socket.on('error', reject)
      socket.on('close', () => reject(new Error('Closed before data')))

      const chunks = []

      const secure = encryptStream(socket, false, (type, payload) => {
        if (type === MSG_DATA) {
          chunks.push(payload)
          const fullBuffer = Buffer.concat(chunks)
          const hash = crypto.createHash('sha256').update(fullBuffer).digest('hex')
          if (hash === blobId) {
            socket.removeAllListeners('close')
            socket.end()
            resolve(fullBuffer)
          }
        } else if (type === MSG_ERROR) {
          cleanup()
          reject(new Error(payload.toString()))
        } else if (type === MSG_HELLO) {
          try {
            const gossip = JSON.parse(payload.toString())
            if (onGossip) onGossip(gossip)
          } catch (e) {}
        }
      })

      socket.once('secureConnect', () => {
        const hello = Buffer.from(JSON.stringify(knownSequences))
        secure.sendMessage(MSG_HELLO, hello)
        secure.sendMessage(MSG_REQUEST, Buffer.from(blobId))

        if (announceAddr) {
          secure.sendMessage(MSG_ANNOUNCE, Buffer.from(JSON.stringify({
            blobId,
            peerAddress: announceAddr
          })))
        }
      })

      setTimeout(cleanup, 10000)
    }

    connect().catch(reject)
  })
}

// Publish via Gateway
export function publishViaGateway (gateway, manifest) {
  return new Promise((resolve, reject) => {
    const [host, portStr] = gateway.split(':')
    const port = parseInt(portStr)

    const socket = new net.Socket()

    socket.connect(port, host, () => {
      const secure = encryptStream(socket, false, (type, payload) => {
        if (type === MSG_OK) {
          socket.end()
          resolve()
        } else if (type === MSG_ERROR) {
          reject(new Error(payload.toString()))
        }
      })
      socket.once('secureConnect', () => {
        secure.sendMessage(MSG_PUBLISH, Buffer.from(JSON.stringify(manifest)))
      })
    })
    socket.on('error', reject)
  })
}

export function findPeersViaPEX (peer, blobId) {
  return new Promise((resolve, reject) => {
    const [host, portStr] = peer.split(':')
    const port = parseInt(portStr)

    const socket = new net.Socket()

    socket.connect(port, host, () => {
      const secure = encryptStream(socket, false, (type, payload) => {
        if (type === MSG_PEERS) {
          try {
            const peers = JSON.parse(payload.toString())
            socket.end()
            resolve(peers)
          } catch (e) { resolve([]) }
        }
      })
      socket.once('secureConnect', () => {
        secure.sendMessage(MSG_HELLO, Buffer.from('{}'))
        secure.sendMessage(MSG_FIND_PEERS, Buffer.from(blobId))
      })
    })
    socket.on('error', () => resolve([]))
    setTimeout(() => socket.destroy(), 5000)
  })
}
