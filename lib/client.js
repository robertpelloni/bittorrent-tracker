import fs from 'fs'
import path from 'path'
import { validateManifest, decryptManifest } from './manifest.js'
import { reassembleStream } from './storage.js'
import { startSecureServer, downloadSecureBlob, setGlobalProxy, findPeersViaPEX } from './secure-transport.js'
import { DHTClient } from './dht-real.js'

export class MegatorrentClient {
  constructor (opts) {
    this.opts = opts
    this.dir = opts.dir
    this.keyfile = opts.keyfile
    this.heldBlobs = new Set()
    this.knownSequences = {}
    this.subscriptions = new Set() // URIs
    this.dht = null
    this.server = null
    this.serverPort = 0
    this.connectedPeers = new Set()
    this.bannedPeers = new Set()
    this.i2pSession = opts.i2pSession || null

    if (opts.bootstrap) this.connectedPeers.add(opts.bootstrap)
    if (opts.proxy) setGlobalProxy(opts.proxy)

    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true })
  }

  async start () {
    // Scan storage
    const files = fs.readdirSync(this.dir)
    files.forEach(f => {
      if (/^[a-f0-9]{64}$/i.test(f)) {
        this.heldBlobs.add(f)
      }
    })
    console.log(`[Daemon] Loaded ${this.heldBlobs.size} blobs from disk`)

    if (!this.opts.proxy && !this.i2pSession) {
      this.dht = new DHTClient({ stateFile: path.join(this.dir, 'dht_state.json') })
    } else {
      console.log('[Daemon] Proxy/I2P enabled. DHT Disabled (Safe Mode).')
    }

    const p2pPort = this.opts.p2pPort || 0
    this.server = startSecureServer(this.dir, p2pPort, this.handleGossip.bind(this), this.dht, this.i2pSession)

    await new Promise(resolve => setTimeout(resolve, 500))
    this.serverPort = this.server.port
    console.log(`[Daemon] Server listening on ${this.serverPort}`)

    if (this.opts.announceAddress) {
      console.log(`[Daemon] Announcing as ${this.opts.announceAddress}`)
    }

    if (!this.opts.proxy) {
      import('nat-upnp').then(natUpnp => {
        const client = natUpnp.default.createClient()
        client.portMapping({
          public: this.serverPort,
          private: this.serverPort,
          ttl: 3600
        }, (err) => {
          if (!err) console.log('[Daemon] UPnP Port Mapped')
        })
      }).catch(() => {})
    }

    setInterval(() => this.checkSubscriptions(), 60000)
    setInterval(() => this.announceHeldBlobs(), 15 * 60 * 1000)
    this.announceHeldBlobs()
  }

  async subscribe (uri) {
    if (this.subscriptions.has(uri)) return
    this.subscriptions.add(uri)
    console.log(`[Daemon] Subscribed to ${uri}`)
    this.checkSubscriptions()
  }

  handleGossip (gossip) {
    if (gossip && gossip.sequences) {
      for (const [key, seq] of Object.entries(gossip.sequences)) {
        if (!this.knownSequences[key] || seq > this.knownSequences[key]) {
          console.log(`[Gossip] New sequence for ${key}: ${seq}`)
        }
      }
    }
  }

  async checkSubscriptions () {
    for (const uri of this.subscriptions) {
      await this.processSubscription(uri)
    }
  }

  parseUri (input) {
    let uri = input
    let queryParams = {}

    // Parse Query Params
    if (uri.includes('?')) {
        const parts = uri.split('?')
        uri = parts[0]
        const params = new URLSearchParams(parts[1])
        for (const [k, v] of params) queryParams[k] = v
    }

    if (uri.startsWith('megatorrent://')) {
      const withoutScheme = uri.replace('megatorrent://', '')
      const parts = withoutScheme.split('/')
      const authParts = parts[0].split(':')
      return {
        publicKey: authParts[0],
        readKey: authParts[1] || null,
        queryParams
      }
    }
    return { publicKey: uri, queryParams }
  }

  async processSubscription (uri) {
    const { publicKey, readKey, queryParams } = this.parseUri(uri)

    // Handle Bootstrap Params
    if (queryParams && queryParams.bootstrap) {
        console.log(`[Daemon] Adding bootstrap peer from URI: ${queryParams.bootstrap}`)
        this.connectedPeers.add(queryParams.bootstrap)
    }

    try {
      let res
      if (this.dht) {
        res = await this.dht.getManifest(publicKey)
      } else {
        // Safe Mode / Dark Swarm logic:
        // If we have bootstrap peer, we rely on PEX/Gossip.
        // But we can't 'getManifest' via PEX yet.
        // Limitation: First fetch of Manifest needs DHT or Gateway.
        // Unless... we implement 'MSG_REQUEST_MANIFEST' in v6?
        // For now, assume user provides manifest manually OR accepts that Manifest updates propagate via Gossip.
        // But initial fetch?
        console.log(`[Daemon] Waiting for Gossip update for ${publicKey}`)
        return
      }

      if (!res) return

      if (!this.knownSequences[publicKey] || res.seq > this.knownSequences[publicKey]) {
        console.log(`[Daemon] Found update for ${publicKey}: ${res.seq}`)
        this.knownSequences[publicKey] = res.seq
        await this.downloadContent(res.manifest, publicKey, readKey)
      }
    } catch (e) {
      console.error(`[Daemon] Error checking ${publicKey}: ${e.message}`)
    }
  }

  async downloadContent (manifest, expectedKey, readKey) {
    if (!validateManifest(manifest) || manifest.publicKey !== expectedKey) {
      console.error('Invalid signature')
      return
    }

    let collections = manifest.collections
    if (manifest.encrypted) {
      if (!readKey) return console.error('Missing Read Key')
      try {
        const decrypted = decryptManifest(manifest, readKey)
        collections = decrypted.collections
      } catch (e) {
        return console.error('Decryption failed')
      }
    }

    const items = collections[0].items
    for (const item of items) {
      if (item.chunks) {
        const outPath = path.join(this.dir, item.name)
        if (fs.existsSync(outPath)) {
          item.chunks.forEach(c => this.heldBlobs.add(c.blobId))
          continue
        }

        for (const chunk of item.chunks) {
          const blobPath = path.join(this.dir, chunk.blobId)
          if (fs.existsSync(blobPath)) {
            this.heldBlobs.add(chunk.blobId)
            continue
          }

          const peers = await this.findPeers(chunk.blobId)

          if (peers.length === 0 && this.opts.proxy) {
            console.log(`[Daemon] No peers found for ${chunk.blobId}.`)
          }

          for (const peer of peers) {
            try {
              const buf = await downloadSecureBlob(peer, chunk.blobId, this.knownSequences, this.handleGossip.bind(this), this.opts.announceAddress, this.i2pSession)
              fs.writeFileSync(blobPath, buf)
              this.heldBlobs.add(chunk.blobId)
              this.connectedPeers.add(peer)
              if (this.serverPort && this.dht) this.dht.announceBlob(chunk.blobId, this.serverPort)
              break
            } catch (e) {
              if (peer !== this.opts.bootstrap) this.connectedPeers.delete(peer)
            }
          }
        }

        if (item.chunks.every(c => fs.existsSync(path.join(this.dir, c.blobId)))) {
          console.log(`Reassembling ${item.name}...`)
          await reassembleStream(item, (bid) => path.join(this.dir, bid), outPath)
        }
      }
    }
    this.announceHeldBlobs()
  }

  async findPeers (blobId) {
    let peers = []

    if (this.dht) {
      peers = await this.dht.findBlobPeers(blobId)
    }

    if (peers.length === 0 && this.connectedPeers.size > 0) {
      for (const p of this.connectedPeers) {
        const pex = await findPeersViaPEX(p, blobId)
        peers = peers.concat(pex)
      }
      this.connectedPeers.forEach(p => peers.push(p))
    }
    return [...new Set(peers)].filter(p => !this.bannedPeers.has(p))
  }

  announceHeldBlobs () {
    if (this.heldBlobs.size > 0 && this.dht && this.serverPort) {
      Array.from(this.heldBlobs).forEach(bid => this.dht.announceBlob(bid, this.serverPort))
    }
  }
}
