#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import minimist from 'minimist'
import http from 'http'
import { MegatorrentClient } from './lib/client.js'
import { generateKeypair } from './lib/crypto.js'
import { ingestStream } from './lib/storage.js'

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
    P: 'port', // RPC Port
    T: 'p2p-port' // Transport Port (for fixed binding)
  },
  default: {
    keyfile: './identity.json',
    dir: './storage',
    port: 3000
  }
})

const command = argv._[0]

if (!command) {
  console.error(`Usage:
  gen-key [-k identity.json]
  ingest -i <file> [-d ./storage]
  publish [-k identity.json] -i <file_entry.json>
  serve [-d ./storage] [--port 3000] [--p2p-port 4000] [--bootstrap host:port]
  subscribe <uri> [-d ./storage] (Legacy CLI mode)
  `)
  process.exit(1)
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
  process.exit(0)
}

// 2. Ingest
if (command === 'ingest') {
  if (!argv.input) { console.error('Missing input'); process.exit(1) }
  ingestStream(argv.input, argv.dir, path.basename(argv.input)).then(res => {
    console.log(JSON.stringify(res.fileEntry, null, 2))
  })
}

// 3. Serve (Daemon Mode)
if (command === 'serve') {
  const client = new MegatorrentClient({
    dir: argv.dir,
    proxy: argv.proxy,
    bootstrap: argv.bootstrap,
    announceAddress: argv['announce-address'],
    p2pPort: argv['p2p-port']
  })

  client.start().then(() => {
    console.log('Megatorrent Client Started')

    const server = http.createServer((req, res) => {
      // Enable CORS for WebUI
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
      console.log(`JSON-RPC Server listening on http://localhost:${argv.port}`)
    })
  })
}

// 4. Subscribe (Legacy CLI wrapper)
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
