import { spawn, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'

const ROOT = process.cwd()
const NODE = process.argv[0]
const INDEX = path.join(ROOT, 'index.js')

const DATA_A = path.join(ROOT, 'data/node-a')
const DATA_B = path.join(ROOT, 'data/node-b')
const DATA_C = path.join(ROOT, 'data/node-c')

// Cleanup
const dirs = [DATA_A, DATA_B, DATA_C]
dirs.forEach(dir => {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
})

function spawnNode (name, dir, port, p2pPort, bootstrap = null) {
  const args = ['serve', '--dir', dir, '--port', port, '--p2p-port', p2pPort]
  if (bootstrap) args.push('--bootstrap', bootstrap)

  console.log(`[${name}] Starting on RPC ${port}, P2P ${p2pPort}...`)
  const proc = spawn(NODE, [INDEX, ...args], {
    env: { ...process.env, DEBUG: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  proc.stdout.on('data', d => console.log(`[${name}] ${d.toString().trim()}`))
  proc.stderr.on('data', d => console.error(`[${name}] ERR: ${d.toString().trim()}`))

  return proc
}

async function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

async function run () {
  console.log('>>> STARTING NETWORK SIMULATION <<<')

  // 1. Start Bootstrap Node (A)
  const nodeA = spawnNode('Node A', DATA_A, '3001', '4001')
  await sleep(2000)

  // 2. Start Subscriber Node (C) - Bootstraps from A
  const nodeC = spawnNode('Node C', DATA_C, '3003', '4003', '127.0.0.1:4001')
  await sleep(2000)

  // 3. Node B (Publisher) Setup
  console.log('\n>>> NODE B: Generating Content <<<')
  const keyFile = path.join(DATA_B, 'identity.json')
  execSync(`${NODE} ${INDEX} gen-key -k ${keyFile}`)
  const keyData = JSON.parse(fs.readFileSync(keyFile))
  const pubKey = keyData.publicKey
  console.log(`Publisher Key: ${pubKey}`)

  const dummyFile = path.join(DATA_B, 'video.mp4')
  fs.writeFileSync(dummyFile, Buffer.alloc(1024 * 1024 * 1, 'x')) // 1MB

  // 4. Ingest on B (Using CLI as Seeder)
  console.log('Node B Ingesting & Seeding...')
  const ingestProc = spawn(NODE, [INDEX, 'ingest', '-i', dummyFile, '-d', DATA_B, '--bootstrap', '127.0.0.1:4001'], {
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let fileEntryJson = ''
  ingestProc.stdout.on('data', d => {
    const str = d.toString()
    if (str.trim().startsWith('{') || fileEntryJson.length > 0) {
      fileEntryJson += str
    }
  })

  await sleep(5000)

  let fileEntryPath
  try {
    const jsonMatch = fileEntryJson.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      fs.writeFileSync(path.join(DATA_B, 'video.mp4.json'), jsonMatch[0])
      fileEntryPath = path.join(DATA_B, 'video.mp4.json')
      console.log('FileEntry captured.')
    } else {
      throw new Error('No JSON found')
    }
  } catch (e) {
    console.error('Failed to capture ingest output:', fileEntryJson)
    process.exit(1)
  }

  // 5. Publish Manifest
  console.log('Publishing Manifest...')
  execSync(`${NODE} ${INDEX} publish -k ${keyFile} -i ${fileEntryPath} -d ${DATA_B} --bootstrap 127.0.0.1:4001`)

  // 6. Node C Subscribes
  console.log('\n>>> NODE C: Subscribing <<<')
  try {
    const res = await fetch('http://localhost:3003/api/rpc', {
      method: 'POST',
      body: JSON.stringify({
        method: 'addSubscription',
        params: { uri: `megatorrent://${pubKey}` }
      })
    })
    console.log('RPC Result:', await res.json())
  } catch (e) {
    console.error('RPC Failed:', e.message)
  }

  console.log('Waiting for transfer (30s)...')
  await sleep(30000)

  // 7. Verify
  const downloadedFile = path.join(DATA_C, 'video.mp4')
  if (fs.existsSync(downloadedFile)) {
    const stat = fs.statSync(downloadedFile)
    console.log(`SUCCESS: File downloaded on Node C! Size: ${stat.size}`)
  } else {
    console.error('FAILURE: File not found on Node C.')
  }

  nodeA.kill()
  nodeC.kill()
  ingestProc.kill()
  process.exit(0)
}

run()
