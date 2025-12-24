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

      // Parse Message
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
      payload.copy(buf, 1)

      if (!sharedTx) pendingWrites.push({ buf, cb })
      else writeEncrypted(buf, cb)
    }
  }
}

export function startSecureServer (storageDir, port = 0, onGossip = null) {
  const server = net.createServer(socket => {
    const secure = encryptStream(socket, true, (type, payload) => {
      if (type === MSG_HELLO) {
        // Gossip: Peer sends { key, seq }
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
      }
    })
  })

  server.listen(port)
  if (server.address()) server.port = server.address().port
  else server.port = port
  return server
}

export function downloadSecureBlob (peer, blobId, knownSequences = {}, onGossip = null) {
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
          // Verify Integrity
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

      // Wait for handshake then send HELLO + REQUEST
      socket.once('secureConnect', () => {
        // Send Gossip Hello
        const hello = Buffer.from(JSON.stringify(knownSequences))
        secure.sendMessage(MSG_HELLO, hello)

        // Send Request
        secure.sendMessage(MSG_REQUEST, Buffer.from(blobId))
      })

      setTimeout(cleanup, 10000)
    }

    connect().catch(reject)
  })
}
