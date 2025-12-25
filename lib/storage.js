import sodium from 'sodium-native'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Transform, Writable } from 'stream'

const CHUNK_SIZE = 1024 * 1024 // 1MB content
const ABYTES = sodium.crypto_aead_chacha20poly1305_ietf_ABYTES
// Target Blob Size: 1MB + Overhead (Auth Tag)
const FIXED_BLOB_SIZE = CHUNK_SIZE + ABYTES

function sha256 (buffer) {
  const hash = crypto.createHash('sha256')
  hash.update(buffer)
  return hash.digest('hex')
}

/**
 * Streaming Ingest
 * Reads inputPath, chunks, pads, encrypts, writes blobs to outputDir.
 * Returns FileEntry object.
 */
export async function ingestStream (inputPath, outputDir, fileName) {
  const chunksMeta = []
  const stats = fs.statSync(inputPath)
  const totalSize = stats.size

  // Ensure output dir exists
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })

  let offset = 0

  const readStream = fs.createReadStream(inputPath, { highWaterMark: CHUNK_SIZE })

  // We need to aggregate chunks manually because ReadStream might give smaller chunks
  let buffer = Buffer.alloc(0)

  // Processor function
  const processChunk = async (chunkData, isFinal = false) => {
      // PADDING LOGIC
      const targetPlaintextSize = FIXED_BLOB_SIZE - ABYTES
      const paddedPlaintext = Buffer.alloc(targetPlaintextSize)
      chunkData.copy(paddedPlaintext)

      if (chunkData.length < targetPlaintextSize) {
          sodium.randombytes_buf(paddedPlaintext.slice(chunkData.length))
      }

      // ENCRYPTION
      const key = Buffer.alloc(sodium.crypto_aead_chacha20poly1305_ietf_KEYBYTES)
      const nonce = Buffer.alloc(sodium.crypto_aead_chacha20poly1305_ietf_NPUBBYTES)
      sodium.randombytes_buf(key)
      sodium.randombytes_buf(nonce)

      const ciphertext = Buffer.alloc(paddedPlaintext.length + ABYTES)
      sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
        ciphertext,
        paddedPlaintext,
        null, null, nonce, key
      )

      if (ciphertext.length !== FIXED_BLOB_SIZE) {
          throw new Error('Padding Error')
      }

      const blobId = sha256(ciphertext)

      // Write Blob to Disk
      await fs.promises.writeFile(path.join(outputDir, blobId), ciphertext)

      chunksMeta.push({
        blobId,
        offset: 0,
        length: ciphertext.length,
        key: key.toString('hex'),
        nonce: nonce.toString('hex'),
        realSize: chunkData.length
      })
  }

  for await (const chunk of readStream) {
      buffer = Buffer.concat([buffer, chunk])

      while (buffer.length >= CHUNK_SIZE) {
          const slice = buffer.slice(0, CHUNK_SIZE)
          buffer = buffer.slice(CHUNK_SIZE)
          await processChunk(slice)
      }
  }

  // Process remainder
  if (buffer.length > 0) {
      await processChunk(buffer, true)
  }

  return {
    fileEntry: {
      name: fileName || path.basename(inputPath),
      size: totalSize,
      chunks: chunksMeta
    }
  }
}

/**
 * Streaming Reassembly
 * Reads blobs via getBlobStreamFn (returns readable stream or buffer), decrypts, unpads, writes to outputPath.
 */
export async function reassembleStream (fileEntry, getBlobPathFn, outputPath) {
  const writeStream = fs.createWriteStream(outputPath)

  for (const chunkMeta of fileEntry.chunks) {
      const blobPath = getBlobPathFn(chunkMeta.blobId)
      if (!fs.existsSync(blobPath)) throw new Error(`Blob ${chunkMeta.blobId} missing`)

      const ciphertext = await fs.promises.readFile(blobPath) // Read 1MB blob into RAM (acceptable)

      const key = Buffer.from(chunkMeta.key, 'hex')
      const nonce = Buffer.from(chunkMeta.nonce, 'hex')
      const plaintext = Buffer.alloc(ciphertext.length - ABYTES)

      try {
        sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
          plaintext,
          null,
          ciphertext,
          null,
          nonce,
          key
        )
      } catch (err) {
        throw new Error(`Decryption failed for blob ${chunkMeta.blobId}`)
      }

      const realData = plaintext.slice(0, chunkMeta.realSize)

      if (!writeStream.write(realData)) {
          await new Promise(resolve => writeStream.once('drain', resolve))
      }
  }

  writeStream.end()
  await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve)
      writeStream.on('error', reject)
  })
}
