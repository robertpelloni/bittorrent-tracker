#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import minimist from 'minimist'
import { generateKeypair } from './lib/crypto.js'
import { createManifest, validateManifest } from './lib/manifest.js'
import { ingest, reassemble } from './lib/storage.js'
import { startSecureServer, downloadSecureBlob, setGlobalProxy } from './lib/secure-transport.js'
import { DHTClient } from './lib/dht-real.js'

const argv = minimist(process.argv.slice(2), {
  alias: {
    k: 'keyfile',
    i: 'input',
    o: 'output',
    d: 'dir',
    p: 'proxy'
  },
  default: {
    keyfile: './identity.json',
    dir: './storage'
  }
})

// Configure Proxy
if (argv.proxy) {
  console.log(`Using SOCKS5 Proxy: ${argv.proxy}`)
  setGlobalProxy(argv.proxy)
}

const command = argv._[0]

// Global State for Seeding/Gossip
const heldBlobs = new Set() // BlobIDs we have on disk
const knownSequences = {} // PubKey -> Seq
let serverPort = 0

function parseUri (input) {
  if (input.startsWith('megatorrent://')) {
    const withoutScheme = input.replace('megatorrent://', '')
    const parts = withoutScheme.split('/')
    return {
      publicKey: parts[0],
      blobId: parts[1] || null
    }
  }
  return { publicKey: input, blobId: null }
}

if (!command) {
  console.error(`Usage:
  gen-key [-k identity.json]
  ingest -i <file> [-d ./storage]
  publish [-k identity.json] -i <file_entry.json>
  subscribe <uri> [-d ./storage] [--proxy socks5://127.0.0.1:9050]
  `)
  process.exit(1)
}

if (!fs.existsSync(argv.dir)) {
  fs.mkdirSync(argv.dir, { recursive: true })
}

let dht = null
if (['ingest', 'publish', 'subscribe'].includes(command)) {
  dht = new DHTClient({ stateFile: path.join(argv.dir, 'dht_state.json') })
}

// 1. Generate Key
if (command === 'gen-key') {
  const keypair = generateKeypair()
  const data = {
    publicKey: keypair.publicKey.toString('hex'),
    secretKey: keypair.secretKey.toString('hex')
  }
  fs.writeFileSync(argv.keyfile, JSON.stringify(data, null, 2))
  console.log(`Identity generated at ${argv.keyfile}`)
  console.log(`Public Key: ${data.publicKey}`)
  console.log(`URI: megatorrent://${data.publicKey}`)
  if (dht) dht.destroy()
  process.exit(0)
}

// 2. Ingest
if (command === 'ingest') {
  const server = startSecureServer(argv.dir, 0)
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

// 3. Publish
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
  const manifest = createManifest(keypair, sequence, collections)

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

// 4. Subscribe
if (command === 'subscribe') {
  const uri = argv._[1]
  if (!uri) {
    console.error('Please provide public key hex or megatorrent:// URI')
    process.exit(1)
  }

  const { publicKey } = parseUri(uri)
  console.log(`Looking up Manifest for ${publicKey} in DHT...`)

  const handleGossip = (gossip) => {
    if (gossip && gossip[publicKey]) {
      if (!knownSequences[publicKey] || gossip[publicKey] > knownSequences[publicKey]) {
        console.log(`Gossip: Peer has newer sequence ${gossip[publicKey]}`)
        checkUpdate()
      }
    }
  }

  const server = startSecureServer(argv.dir, 0, handleGossip)
  setTimeout(() => {
    serverPort = server.port
    console.log(`Seeding on port ${serverPort}`)
  }, 500)

  const checkUpdate = async () => {
    try {
      const res = await dht.getManifest(publicKey)
      if (res) {
        if (!knownSequences[publicKey] || res.seq > knownSequences[publicKey]) {
          console.log(`Found New Manifest (Seq: ${res.seq})`)
          knownSequences[publicKey] = res.seq
          await processManifest(res.manifest)
        }
      } else {
        console.log('No manifest found yet...')
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

    const items = manifest.collections[0].items
    for (const item of items) {
      if (item.chunks) {
        console.log(`Processing: ${item.name}`)
        const outPath = path.join(argv.dir, item.name)
        if (fs.existsSync(outPath)) {
          console.log('Already downloaded.')
          // Ensure we seed it
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
            const peers = await dht.findBlobPeers(blobId)
            console.log(`Found ${peers.length} peers:`, peers)

            let downloaded = false
            for (const peer of peers) {
              try {
                console.log(`Connecting to ${peer}...`)
                const buffer = await downloadSecureBlob(peer, blobId, knownSequences, handleGossip)
                fs.writeFileSync(blobPath, buffer)
                chunks.push(buffer)
                heldBlobs.add(blobId)

                // Announce immediately to become a seeder
                if (serverPort) dht.announceBlob(blobId, serverPort)

                downloaded = true
                break
              } catch (e) {
                console.error(`Peer ${peer} failed: ${e.message}`)
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
    // After processing, announce all held blobs
    announceHeldBlobs()
  }
}

// Periodic Re-announce (Seeding)
function announceHeldBlobs () {
  if (heldBlobs.size > 0 && dht && serverPort) {
    console.log(`Re-announcing ${heldBlobs.size} blobs to DHT...`)
    const promises = Array.from(heldBlobs).map(bid => dht.announceBlob(bid, serverPort))
    Promise.allSettled(promises).then(() => console.log('Announce complete.'))
  }
}

setInterval(announceHeldBlobs, 15 * 60 * 1000) // Every 15 mins
