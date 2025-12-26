#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import minimist from 'minimist'
import http from 'http'
import { MegatorrentClient } from './lib/client.js'
import { generateKeypair } from './lib/crypto.js'
import { ingestStream } from './lib/storage.js'
import { createManifest } from './lib/manifest.js'
import { publishViaGateway } from './lib/secure-transport.js'
import { DHTClient } from './lib/dht-real.js'
import { SamSession } from './lib/i2p-sam.js'

const argv = minimist(process.argv.slice(2), {
  alias: {
    k: 'keyfile',
    i: 'input',
    d: 'dir',
    p: 'proxy',
    s: 'secret',
    b: 'bootstrap',
    g: 'gateway',
    a: 'announce-address',
    P: 'port',
    T: 'p2p-port',
    j: 'json',
    I: 'i2p'
  },
  default: {
    keyfile: './identity.json',
    dir: './storage',
    port: 3000,
    i2p: false
  }
})

// Output Hygiene
const log = {
  info: (...args) => {
    if (argv.json) console.error(...args)
    else console.log(...args)
  },
  error: (...args) => console.error(...args),
  json: (obj) => console.log(JSON.stringify(obj, null, 2))
}

const command = argv._[0]

if (!command) {
  console.error(`Usage:
  gen-key [-k identity.json]
  ingest -i <file> [-d ./storage] [--json]
  publish [-k identity.json] -i <file_entry.json>
  serve [-d ./storage]
  subscribe <uri> [-d ./storage]
  `)
  process.exit(1)
}

if (command === 'gen-key') {
  const keypair = generateKeypair()
  const data = {
    publicKey: keypair.publicKey.toString('hex'),
    secretKey: keypair.secretKey.toString('hex')
  }
  fs.writeFileSync(argv.keyfile, JSON.stringify(data, null, 2))
  log.info(`Identity generated at ${argv.keyfile}`)
  if (argv.json) log.json({ publicKey: data.publicKey })
  else process.exit(0)
}

if (command === 'ingest') {
  if (!argv.input) { log.error('Missing input'); process.exit(1) }

  if (argv.json) {
    const originalLog = console.log
    console.log = console.error
    ingestStream(argv.input, argv.dir, path.basename(argv.input)).then(res => {
      console.log = originalLog
      console.log(JSON.stringify(res.fileEntry, null, 2))
      process.exit(0)
    })
  } else {
    // Interactive Mode
    const dht = new DHTClient({ stateFile: path.join(argv.dir, 'dht_state.json') })
    import('./lib/secure-transport.js').then(({ startSecureServer }) => {
      const server = startSecureServer(argv.dir, 0, null, dht)
      setTimeout(async () => {
        log.info(`Secure Blob Server running on port ${server.port}`)
        try {
          log.info(`Ingesting ${argv.input}...`)
          const result = await ingestStream(argv.input, argv.dir, path.basename(argv.input))
          log.info(`Ingested ${result.fileEntry.chunks.length} blobs`)
          log.json(result.fileEntry)

          const heldBlobs = result.fileEntry.chunks.map(c => c.blobId)
          const announce = () => {
            heldBlobs.forEach(bid => dht.announceBlob(bid, server.port))
          }
          announce()
          setInterval(announce, 15 * 60 * 1000)
        } catch (e) {
          log.error(e)
          process.exit(1)
        }
      }, 500)
    })
  }
}

if (command === 'publish') {
  if (!argv.keyfile || !fs.existsSync(argv.keyfile)) { log.error('Missing keyfile'); process.exit(1) }

  const keyData = JSON.parse(fs.readFileSync(argv.keyfile))
  const keypair = {
    publicKey: Buffer.from(keyData.publicKey, 'hex'),
    secretKey: Buffer.from(keyData.secretKey, 'hex')
  }

  let fileEntry
  try {
    fileEntry = JSON.parse(fs.readFileSync(argv.input))
  } catch (e) { log.error('Invalid JSON'); process.exit(1) }

  const collections = [{ title: 'Default', items: [fileEntry] }]
  const sequence = Date.now()
  const manifest = createManifest(keypair, sequence, collections, argv.secret)

  if (argv.gateway) {
    log.info(`Publishing via Gateway: ${argv.gateway}`)
    publishViaGateway(argv.gateway, manifest, keypair).then(() => {
      log.info('Published to Gateway!')
      process.exit(0)
    }).catch(err => {
      log.error('Gateway Publish failed:', err)
      process.exit(1)
    })
  } else {
    log.info('Publishing manifest to DHT...')
    const dht = new DHTClient({ stateFile: path.join(argv.dir, 'dht_state.json') })
    dht.putManifest(keypair, sequence, manifest).then(hash => {
      log.info('Published!')
      log.info('Hash:', hash.toString('hex'))
      setTimeout(() => {
        dht.destroy()
        process.exit(0)
      }, 2000)
    }).catch(err => {
      log.error('Publish failed:', err)
      dht.destroy()
      process.exit(1)
    })
  }
}

if (command === 'serve') {
  let samSession = null
  if (argv.i2p) {
    samSession = new SamSession()
    await samSession.connect()
    log.info('[I2P] Connected to SAM bridge')
  }

  const client = new MegatorrentClient({
    dir: argv.dir,
    proxy: argv.proxy,
    bootstrap: argv.bootstrap,
    announceAddress: argv['announce-address'],
    p2pPort: argv['p2p-port'],
    i2pSession: samSession
  })

  client.start().then(() => {
    log.info('Megatorrent Client Started')

    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') { res.end(); return }

      if (req.url === '/api/rpc' && req.method === 'POST') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
          try {
            const { method, params } = JSON.parse(body)
            let result = {}

            if (method === 'addSubscription') {
              await client.subscribe(params.uri)
              result = { status: 'ok' }
            } else if (method === 'getSubscriptions') {
              result = {
                subscriptions: Array.from(client.subscriptions).map(uri => ({
                  uri,
                  status: 'Active',
                  lastSequence: client.knownSequences[client.parseUri(uri).publicKey] || 0
                }))
              }
            } else if (method === 'getStatus') {
              result = {
                heldBlobs: client.heldBlobs.size,
                peers: client.connectedPeers.size,
                serverPort: client.serverPort
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ result }))
          } catch (e) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: e.message }))
          }
        })
      } else {
        res.writeHead(404); res.end()
      }
    })

    server.listen(argv.port, () => {
      log.info(`JSON-RPC Server listening on http://localhost:${argv.port}`)
    })
  })
}

if (command === 'subscribe') {
  const client = new MegatorrentClient({
    dir: argv.dir,
    proxy: argv.proxy,
    bootstrap: argv.bootstrap,
    announceAddress: argv['announce-address'],
    p2pPort: argv['p2p-port']
  })
  client.start().then(() => {
    client.subscribe(argv._[1])
  })
}
