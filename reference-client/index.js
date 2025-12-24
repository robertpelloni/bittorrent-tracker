#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import minimist from 'minimist'
import Client from 'bittorrent-tracker'
import { WebSocket } from 'ws'
import { generateKeypair } from './lib/crypto.js'
import { createManifest, validateManifest } from './lib/manifest.js'
import { ingest, reassemble } from './lib/storage.js'
import { startServer } from './lib/server.js'
import { downloadBlob } from './lib/downloader.js'
import { findBlob } from './lib/dht.js'

const argv = minimist(process.argv.slice(2), {
  alias: {
    k: 'keyfile',
    t: 'tracker',
    i: 'input',
    o: 'output',
    d: 'dir'
  },
  default: {
    keyfile: './identity.json',
    tracker: 'ws://localhost:8000', // Default to local WS tracker
    dir: './storage'
  }
})

const command = argv._[0]

function parseUri (input) {
  if (input.startsWith('megatorrent://')) {
    const withoutScheme = input.replace('megatorrent://', '')
    // Simple case: just pubkey
    // Complex case: pubkey/blobid
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
  ingest -i <file> [-d ./storage] -> Returns FileEntry JSON
  publish [-k identity.json] [-t ws://tracker] -i <file_entry.json>
  subscribe [-t ws://tracker] <public_key_hex|megatorrent://...> [-d ./storage]
  `)
  process.exit(1)
}

// Ensure storage dir exists
if (!fs.existsSync(argv.dir)) {
  fs.mkdirSync(argv.dir, { recursive: true })
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
  process.exit(0)
}

// 2. Ingest
if (command === 'ingest') {
  // Start the Blob Server to serve content we ingest
  const server = startServer(argv.dir, 0) // Port 0 = random
  console.log(`Blob Server running on port ${server.port}`)

  if (!argv.input) {
    // If no input, just run as a server node
    console.log('Running in server-only mode. Press Ctrl+C to exit.')

    // Announce existing blobs?
    // In a real app, we'd scan argv.dir and announce all.
  } else {
    const fileBuf = fs.readFileSync(argv.input)
    const result = ingest(fileBuf, path.basename(argv.input))

    // Save Blobs
    result.blobs.forEach(blob => {
      fs.writeFileSync(path.join(argv.dir, blob.id), blob.buffer)
    })

    console.log(`Ingested ${result.blobs.length} blobs to ${argv.dir}`)
    console.log('FileEntry JSON (save this to a file to publish it):')
    console.log(JSON.stringify(result.fileEntry, null, 2))

    // Announce to Tracker (Discovery)
    const blobIds = result.blobs.map(b => b.id)
    const ws = new WebSocket(argv.tracker)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        action: 'announce_blob',
        blob_ids: blobIds
      }))
      console.log('Announced blobs to tracker.')
      // Keep running to serve
    })
  }
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

  // Read Input
  if (!argv.input) {
    console.error('Please specify input file with -i (json file entry or text list)')
    process.exit(1)
  }

  const content = fs.readFileSync(argv.input, 'utf-8')
  let items
  try {
    // Try parsing as JSON (FileEntry)
    const json = JSON.parse(content)
    // Wrap in our "Items" list.
    items = [json]
  } catch (e) {
    // Fallback: Line-separated magnet links
    items = content.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  }

  // Create Collections structure
  const collections = [{
    title: 'Default Collection',
    items
  }]

  // Create Manifest
  const sequence = Date.now()
  const manifest = createManifest(keypair, sequence, collections)

  console.log('Publishing manifest:', JSON.stringify(manifest, null, 2))

  // Connect to Tracker using raw WebSocket for Control Plane
  const ws = new WebSocket(argv.tracker)

  ws.on('open', () => {
    console.log('Connected to tracker.')
    ws.send(JSON.stringify({
      action: 'publish',
      manifest
    }))
  })

  ws.on('message', (data) => {
    const msg = JSON.parse(data)
    if (msg.action === 'publish' && msg.status === 'ok') {
      console.log('Publish confirmed by tracker.')
      process.exit(0)
    } else {
      console.error('Unexpected response:', msg)
    }
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
  console.log(`Subscribing to ${publicKey}...`)

  // Start Server (to be a good peer)
  startServer(argv.dir, 0)

  // Connect to Tracker
  const ws = new WebSocket(argv.tracker)

  ws.on('open', () => {
    console.log('Connected to tracker.')
    ws.send(JSON.stringify({
      action: 'subscribe',
      key: publicKey
    }))
  })

  ws.on('message', async (data) => {
    let msg
    try { msg = JSON.parse(data) } catch (e) { return }

    if (msg.action === 'publish') {
      console.log('\n>>> RECEIVED UPDATE <<<')
      try {
        if (validateManifest(msg.manifest) && msg.manifest.publicKey === publicKey) {
          console.log(`New Manifest Sequence: ${msg.manifest.sequence}`)
          await processManifest(msg.manifest)
        } else {
          console.error('Invalid signature on update.')
        }
      } catch (err) {
        console.error('Validation error:', err.message)
      }
    }
  })

  async function processManifest (manifest) {
    const items = manifest.collections[0].items
    for (const item of items) {
      if (item.chunks) {
        console.log(`Processing Item: ${item.name}`)
        // Check if we have it
        const outPath = path.join(argv.dir, item.name) // Simplified path
        if (fs.existsSync(outPath)) {
          console.log('Already downloaded.')
          continue
        }

        // Download Chunks
        const chunks = []
        for (const chunk of item.chunks) {
          const blobId = chunk.id
          const blobPath = path.join(argv.dir, blobId)

          if (fs.existsSync(blobPath)) {
            chunks.push(fs.readFileSync(blobPath))
          } else {
            console.log(`Downloading blob ${blobId}...`)
            // 1. Find Peers
            const peers = await findBlob(argv.tracker, blobId)
            // 2. Download
            try {
              // Simple retry logic
              let downloaded = false
              for (const peer of peers) {
                try {
                  const buffer = await downloadBlob(peer, blobId)
                  fs.writeFileSync(blobPath, buffer)
                  chunks.push(buffer)
                  downloaded = true
                  break
                } catch (e) {
                  console.error(`Failed peer ${peer}: ${e.message}`)
                }
              }
              if (!downloaded) console.error(`Failed to download blob ${blobId}`)
            } catch (e) {
              console.error('Download error:', e)
            }
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
  }
}
