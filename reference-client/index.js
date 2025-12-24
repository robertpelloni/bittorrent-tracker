#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import minimist from 'minimist'
import sodium from 'sodium-native'
import { generateKeypair } from './lib/crypto.js'
import { createManifest, validateManifest, decryptManifest } from './lib/manifest.js'
import { ingest, reassemble } from './lib/storage.js'
import { startSecureServer, downloadSecureBlob, setGlobalProxy, findPeersViaPEX, publishViaGateway } from './lib/secure-transport.js'
import { DHTClient } from './lib/dht-real.js'

const argv = minimist(process.argv.slice(2), {
  alias: {
    k: 'keyfile',
    i: 'input',
    o: 'output',
    d: 'dir',
    p: 'proxy',
    s: 'secret',
    b: 'bootstrap',
    g: 'gateway', // New: Publish via Gateway
    a: 'announce-address' // New: Announce specific address (e.g. .onion)
  },
  default: {
    keyfile: './identity.json',
    dir: './storage'
  }
})

if (argv.proxy) {
  console.log(`Using SOCKS5 Proxy: ${argv.proxy}`)
  setGlobalProxy(argv.proxy)
}

const command = argv._[0]
const heldBlobs = new Set()
const knownSequences = {}
let serverPort = 0
const connectedPeers = new Set()

if (argv.bootstrap) {
  console.log(`Adding Bootstrap Peer: ${argv.bootstrap}`)
  connectedPeers.add(argv.bootstrap)
}

function parseUri (input) {
  if (input.startsWith('megatorrent://')) {
    const withoutScheme = input.replace('megatorrent://', '')
    const parts = withoutScheme.split('/')
    const authParts = parts[0].split(':')

    return {
      publicKey: authParts[0],
      readKey: authParts[1] || null,
      blobId: parts[1] || null
    }
  }
  const parts = input.split(':')
  return { publicKey: parts[0], readKey: parts[1] || null, blobId: null }
}

if (!command) {
  console.error(`Usage:
  gen-key [-k identity.json]
  ingest -i <file> [-d ./storage]
  publish [-k identity.json] -i <file_entry.json> [-s <secret>] [--gateway <host:port>]
  subscribe <uri> [-d ./storage] [--proxy ...] [--bootstrap host:port] [--announce-address <my.onion:80>]
  `)
  process.exit(1)
}

if (!fs.existsSync(argv.dir)) {
  fs.mkdirSync(argv.dir, { recursive: true })
}

let dht = null
if (['ingest', 'publish', 'subscribe'].includes(command)) {
  // Only start DHT if NOT using proxy or if specifically wanted?
  // For now, start it unless explicit flag?
  // We'll keep it for PEX gateway logic.
  dht = new DHTClient({ stateFile: path.join(argv.dir, 'dht_state.json') })
}

if (command === 'gen-key') {
  const keypair = generateKeypair()
  const data = {
    publicKey: keypair.publicKey.toString('hex'),
    secretKey: keypair.secretKey.toString('hex')
  }
  fs.writeFileSync(argv.keyfile, JSON.stringify(data, null, 2))

  const readKey = Buffer.alloc(32)
  sodium.randombytes_buf(readKey)
  const readKeyHex = readKey.toString('hex')

  console.log(`Identity generated at ${argv.keyfile}`)
  console.log(`Public Key: ${data.publicKey}`)
  console.log(`Public URI: megatorrent://${data.publicKey}`)
  console.log(`Private URI: megatorrent://${data.publicKey}:${readKeyHex}`)
  if (dht) dht.destroy()
  process.exit(0)
}

if (command === 'ingest') {
  const server = startSecureServer(argv.dir, 0, null, dht)
  setTimeout(() => {
    serverPort = server.port
    console.log(`Secure Blob Server running on port ${serverPort}`)

    if (!argv.input) {
      console.log('Running in server-only mode. Press Ctrl+C to exit.')
    } else {
      const fileBuf = fs.readFileSync(argv.input)
      const result = ingest(fileBuf, path.basename(argv.input))

      result.blobs.forEach(blob => {
        fs.writeFileSync(path.join(argv.dir, blob.id), blob.buffer)
        heldBlobs.add(blob.id)
      })

      console.log(`Ingested ${result.blobs.length} blobs to ${argv.dir}`)
      console.log('FileEntry JSON (save this to a file to publish it):')
      console.log(JSON.stringify(result.fileEntry, null, 2))

      announceHeldBlobs()
    }
  }, 500)
}

if (command === 'publish') {
  if (!fs.existsSync(argv.keyfile)) {
    console.error('Keyfile not found. Run gen-key first.')
    process.exit(1)
  }
  const keyData = JSON.parse(fs.readFileSync(argv.keyfile))
  const keypair = {
    publicKey: Buffer.from(keyData.publicKey, 'hex'),
    secretKey: Buffer.from(keyData.secretKey, 'hex')
  }

  if (!argv.input) {
    console.error('Please specify input file with -i')
    process.exit(1)
  }

  const content = fs.readFileSync(argv.input, 'utf-8')
  let items
  try {
    const json = JSON.parse(content)
    items = [json]
  } catch (e) {
    items = content.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  }

  const collections = [{
    title: 'Default Collection',
    items
  }]

  const sequence = Date.now()
  const manifest = createManifest(keypair, sequence, collections, argv.secret)

  if (argv.secret) console.log('Encrypted Channel Enabled.')

  if (argv.gateway) {
    console.log(`Publishing via Gateway: ${argv.gateway}`)
    publishViaGateway(argv.gateway, manifest).then(() => {
      console.log('Published to Gateway!')
      process.exit(0)
    }).catch(err => {
      console.error('Gateway Publish failed:', err)
      process.exit(1)
    })
  } else {
    console.log('Publishing manifest to DHT...')
    dht.putManifest(keypair, sequence, manifest).then(hash => {
      console.log('Published!')
      console.log('Mutable Item Hash:', hash.toString('hex'))
      setTimeout(() => {
        dht.destroy()
        process.exit(0)
      }, 2000)
    }).catch(err => {
      console.error('Publish failed:', err)
      dht.destroy()
      process.exit(1)
    })
  }
}

if (command === 'subscribe') {
  const uri = argv._[1]
  if (!uri) {
    console.error('Please provide public key hex or megatorrent:// URI')
    process.exit(1)
  }

  const { publicKey, readKey } = parseUri(uri)
  console.log(`Looking up Manifest for ${publicKey} in DHT...`)
  if (readKey) console.log('Using Read Key for decryption.')

  const handleGossip = (gossip) => {
    if (gossip && gossip[publicKey]) {
      if (!knownSequences[publicKey] || gossip[publicKey] > knownSequences[publicKey]) {
        console.log(`Gossip: Peer has newer sequence ${gossip[publicKey]}`)
        checkUpdate()
      }
    }
  }

  const server = startSecureServer(argv.dir, 0, handleGossip, dht)
  setTimeout(() => {
    serverPort = server.port
    console.log(`Seeding on port ${serverPort}`)
  }, 500)

  const checkUpdate = async () => {
    try {
      const res = await dht.getManifest(publicKey)

      // TODO: PEX for Manifest lookup via Gateway?
      // Not implemented in this ref, but structure supports it.

      if (res) {
        if (!knownSequences[publicKey] || res.seq > knownSequences[publicKey]) {
          console.log(`Found New Manifest (Seq: ${res.seq})`)
          knownSequences[publicKey] = res.seq
          await processManifest(res.manifest)
        }
      } else {
        console.log('No manifest found in DHT yet...')
      }
    } catch (err) {
      console.error('Lookup error:', err.message)
    }
  }

  checkUpdate()
  setInterval(checkUpdate, 60000)

  async function processManifest (manifest) {
    if (!validateManifest(manifest) || manifest.publicKey !== publicKey) {
      console.error('Invalid manifest signature!')
      return
    }

    let collections = manifest.collections
    if (manifest.encrypted) {
      if (!readKey) {
        console.error('Manifest is encrypted but no key provided in URI.')
        return
      }
      try {
        const decrypted = decryptManifest(manifest, readKey)
        collections = decrypted.collections
        console.log('Manifest decrypted successfully.')
      } catch (e) {
        console.error('Failed to decrypt manifest:', e.message)
        return
      }
    } else if (!collections) {
      console.error('Manifest format error')
      return
    }

    const items = collections[0].items
    for (const item of items) {
      if (item.chunks) {
        console.log(`Processing: ${item.name}`)
        const outPath = path.join(argv.dir, item.name)
        if (fs.existsSync(outPath)) {
          console.log('Already downloaded.')
          item.chunks.forEach(c => heldBlobs.add(c.id))
          continue
        }

        const chunks = []
        for (const chunk of item.chunks) {
          const blobId = chunk.id
          const blobPath = path.join(argv.dir, blobId)

          if (fs.existsSync(blobPath)) {
            chunks.push(fs.readFileSync(blobPath))
            heldBlobs.add(blobId)
          } else {
            console.log(`Finding peers for blob ${blobId}...`)

            let peers = await dht.findBlobPeers(blobId)

            if (peers.length === 0 && connectedPeers.size > 0) {
              console.log('DHT yielded no peers. Trying PEX...')
              for (const p of connectedPeers) {
                const pexPeers = await findPeersViaPEX(p, blobId)
                if (pexPeers.length > 0) {
                  peers = peers.concat(pexPeers)
                }
              }
              connectedPeers.forEach(p => peers.push(p))
            }

            peers = [...new Set(peers)]
            console.log(`Found ${peers.length} peers:`, peers)

            let downloaded = false
            for (const peer of peers) {
              try {
                console.log(`Connecting to ${peer}...`)
                const buffer = await downloadSecureBlob(peer, blobId, knownSequences, handleGossip, argv['announce-address'])
                fs.writeFileSync(blobPath, buffer)
                chunks.push(buffer)
                heldBlobs.add(blobId)
                connectedPeers.add(peer)

                if (serverPort) dht.announceBlob(blobId, serverPort)

                downloaded = true
                break
              } catch (e) {
                console.error(`Peer ${peer} failed: ${e.message}`)
                if (peer !== argv.bootstrap) connectedPeers.delete(peer)
              }
            }
            if (!downloaded) console.error(`Failed to download blob ${blobId}`)
          }
        }

        if (chunks.length === item.chunks.length) {
          const fileBuf = await reassemble(item, async (bid) => {
            return fs.readFileSync(path.join(argv.dir, bid))
          })
          if (fileBuf) {
            fs.writeFileSync(outPath, fileBuf)
            console.log(`Successfully assembled ${item.name}`)
          }
        }
      }
    }
    announceHeldBlobs()
  }
}

function announceHeldBlobs () {
  if (heldBlobs.size > 0 && dht && serverPort) {
    console.log(`Re-announcing ${heldBlobs.size} blobs to DHT...`)
    const promises = Array.from(heldBlobs).map(bid => dht.announceBlob(bid, serverPort))
    Promise.allSettled(promises).then(() => console.log('Announce complete.'))
  }
}

setInterval(announceHeldBlobs, 15 * 60 * 1000)
