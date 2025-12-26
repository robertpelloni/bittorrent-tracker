import net from 'net'
import EventEmitter from 'events'

const DEFAULT_SAM_HOST = '127.0.0.1'
const DEFAULT_SAM_PORT = 7656

export class SamSession extends EventEmitter {
  constructor (options = {}) {
    super()
    this.host = options.host || DEFAULT_SAM_HOST
    this.port = options.port || DEFAULT_SAM_PORT
    this.sessionId = options.sessionId || 'MegatorrentSession'
    this.destination = null // My Public Key (Base64)
    this.controlSocket = null
  }

  async connect () {
    return new Promise((resolve, reject) => {
      this.controlSocket = new net.Socket()
      this.controlSocket.connect(this.port, this.host, () => {
        this.handshake().then(resolve).catch(reject)
      })
      this.controlSocket.on('error', reject)
    })
  }

  async handshake () {
    const reply = await this.send('HELLO VERSION MIN=3.0 MAX=3.1\n')
    if (!reply.includes('RESULT=OK')) throw new Error('SAM Handshake Failed: ' + reply)

    // Create Session
    const sessionReply = await this.send(`SESSION CREATE STYLE=STREAM ID=${this.sessionId} DESTINATION=TRANSIENT\n`)
    if (!sessionReply.includes('RESULT=OK')) throw new Error('SAM Session Create Failed: ' + sessionReply)

    // Parse Destination
    const match = sessionReply.match(/DESTINATION=(\S+)/)
    if (match) this.destination = match[1]

    console.log('[I2P] Session Created. Destination:', this.destination ? this.destination.substr(0, 20) + '...' : 'Unknown')
  }

  // Helper to send command and get one-line response
  send (cmd) {
    return new Promise((resolve, reject) => {
      const onData = (data) => {
        const str = data.toString()
        if (str.includes('\n')) {
          this.controlSocket.removeListener('data', onData)
          resolve(str.trim())
        }
      }
      this.controlSocket.on('data', onData)
      this.controlSocket.write(cmd)
    })
  }

  // Create a new socket connected to a destination
  async streamConnect (destination) {
    const socket = new net.Socket()
    await new Promise((resolve, reject) => {
      socket.connect(this.port, this.host, resolve)
      socket.on('error', reject)
    })

    // STREAM CONNECT ID=$id DESTINATION=$dest
    socket.write(`STREAM CONNECT ID=${this.sessionId} DESTINATION=${destination}\n`)

    // Wait for "STREAM STATUS RESULT=OK"
    await new Promise((resolve, reject) => {
        const onData = (data) => {
            const str = data.toString()
            if (str.includes('RESULT=OK')) {
                socket.removeListener('data', onData)
                resolve()
            } else if (str.includes('RESULT=')) {
                socket.removeListener('data', onData)
                reject(new Error('SAM Stream Connect Failed: ' + str))
            }
        }
        socket.on('data', onData)
    })

    return socket
  }

  // Accept incoming connections
  // SAM v3.1 STREAM ACCEPT is blocking on the control socket usually?
  // Or we use a separate socket for "STREAM ACCEPT" which then spawns others?
  // Standard way: Open a new socket, send STREAM ACCEPT, wait for data.
  // When a peer connects, that socket BECOMES the data socket.
  // Then we need to reconnect the acceptor loop.
  async startAcceptLoop (onSocket) {
    while (true) {
        try {
            const socket = new net.Socket()
            await new Promise(r => socket.connect(this.port, this.host, r))

            socket.write(`STREAM ACCEPT ID=${this.sessionId} SILENT=false\n`)

            // Wait for incoming connection header
            // The first line will be the peer destination, usually.
            // Or if SILENT=false, we get "DATAGRAM RECEIVED..." or similar?
            // For STREAM, we get the peer destination line then raw data.

            const peerHeader = await new Promise((resolve, reject) => {
                socket.once('data', (data) => {
                    // First packet is the peer dest (text) ending in \n
                    // Check if it's an error
                    const str = data.toString()
                    if (str.includes('RESULT=I2P_ERROR')) {
                        reject(new Error(str))
                    } else {
                        resolve(str)
                    }
                })
            })

            // Hand off valid socket
            onSocket(socket)

        } catch (e) {
            console.error('[I2P] Accept Loop Error:', e.message)
            await new Promise(r => setTimeout(r, 1000)) // Backoff
        }
    }
  }
}
