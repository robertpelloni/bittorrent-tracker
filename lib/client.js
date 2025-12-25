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

    if (opts.bootstrap) this.connectedPeers.add(opts.bootstrap)
    if (opts.proxy) setGlobalProxy(opts.proxy)

    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true })
  }

  async start () {
    this.dht = new DHTClient({ stateFile: path.join(this.dir, 'dht_state.json') })

    // Start Secure Server (Gateway/Seeder)
    const p2pPort = this.opts.p2pPort || 0
    this.server = startSecureServer(this.dir, p2pPort, this.handleGossip.bind(this), this.dht)

    // Wait for listen
    await new Promise(resolve => setTimeout(resolve, 500))
    this.serverPort = this.server.port
    console.log(`[Daemon] Server listening on ${this.serverPort}`)

    if (this.opts.announceAddress) {
      console.log(`[Daemon] Announcing as ${this.opts.announceAddress}`)
    }

    // UPnP (Lazy load)
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

    // Start Loops
    setInterval(() => this.checkSubscriptions(), 60000)
    setInterval(() => this.announceHeldBlobs(), 15 * 60 * 1000)
  }

  async subscribe (uri) {
    if (this.subscriptions.has(uri)) return
    this.subscriptions.add(uri)
    console.log(`[Daemon] Subscribed to ${uri}`)
    this.checkSubscriptions() // Trigger immediate check
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
    if (input.startsWith('megatorrent://')) {
      const withoutScheme = input.replace('megatorrent://', '')
      const parts = withoutScheme.split('/')
      const authParts = parts[0].split(':')
      return {
        publicKey: authParts[0],
        readKey: authParts[1] || null
      }
    }
    return { publicKey: input } // Bare key
  }

  async processSubscription (uri) {
    const { publicKey, readKey } = this.parseUri(uri)

    try {
      const res = await this.dht.getManifest(publicKey)
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

        // Download Logic
        for (const chunk of item.chunks) {
          const blobPath = path.join(this.dir, chunk.blobId)
          if (fs.existsSync(blobPath)) {
            this.heldBlobs.add(chunk.blobId)
            continue
          }

          // Fetch
          const peers = await this.findPeers(chunk.blobId)
          for (const peer of peers) {
            try {
              const buf = await downloadSecureBlob(peer, chunk.blobId, this.knownSequences, this.handleGossip.bind(this), this.opts.announceAddress)
              fs.writeFileSync(blobPath, buf)
              this.heldBlobs.add(chunk.blobId)
              this.connectedPeers.add(peer)
              if (this.serverPort) this.dht.announceBlob(chunk.blobId, this.serverPort)
              break
            } catch (e) {
              if (peer !== this.opts.bootstrap) this.connectedPeers.delete(peer)
            }
          }
        }

        // Reassemble
        if (item.chunks.every(c => fs.existsSync(path.join(this.dir, c.blobId)))) {
          console.log(`Reassembling ${item.name}...`)
          await reassembleStream(item, (bid) => path.join(this.dir, bid), outPath)
        }
      }
    }
    this.announceHeldBlobs()
  }

  async findPeers (blobId) {
    let peers = await this.dht.findBlobPeers(blobId)
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
