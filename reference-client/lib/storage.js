import sodium from 'sodium-native'
import crypto from 'crypto'

const CHUNK_SIZE = 1024 * 1024 // 1MB content
const ABYTES = sodium.crypto_aead_chacha20poly1305_ietf_ABYTES
// Target Blob Size: 1MB + Overhead (Auth Tag)
// To prevent analysis, we pad ALL blobs to exactly CHUNK_SIZE + ABYTES.
const FIXED_BLOB_SIZE = CHUNK_SIZE + ABYTES

function sha256 (buffer) {
  const hash = crypto.createHash('sha256')
  hash.update(buffer)
  return hash.digest('hex')
}

export function ingest (fileBuffer, fileName) {
  const totalSize = fileBuffer.length
  const chunks = []
  const blobs = []

  let offset = 0
  while (offset < totalSize) {
    const end = Math.min(offset + CHUNK_SIZE, totalSize)
    const chunkData = fileBuffer.slice(offset, end)

    // PADDING LOGIC:
    const targetPlaintextSize = FIXED_BLOB_SIZE - ABYTES

    // Create buffer of target size
    const paddedPlaintext = Buffer.alloc(targetPlaintextSize)
    // Write actual data
    chunkData.copy(paddedPlaintext)

    // Fill remainder with random junk
    if (chunkData.length < targetPlaintextSize) {
      sodium.randombytes_buf(paddedPlaintext.slice(chunkData.length))
    }

    // 1. Generate Encryption Params
    const key = Buffer.alloc(sodium.crypto_aead_chacha20poly1305_ietf_KEYBYTES)
    const nonce = Buffer.alloc(sodium.crypto_aead_chacha20poly1305_ietf_NPUBBYTES)
    sodium.randombytes_buf(key)
    sodium.randombytes_buf(nonce)

    // 2. Encrypt
    const ciphertext = Buffer.alloc(paddedPlaintext.length + ABYTES)
    sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
      ciphertext,
      paddedPlaintext,
      null,
      null,
      nonce,
      key
    )

    // Verify size
    if (ciphertext.length !== FIXED_BLOB_SIZE) {
      throw new Error(`Padding Error: Blob size ${ciphertext.length} != ${FIXED_BLOB_SIZE}`)
    }

    const blobId = sha256(ciphertext)

    blobs.push({
      id: blobId,
      buffer: ciphertext
    })

    chunks.push({
      blobId,
      offset: 0,
      length: ciphertext.length,
      key: key.toString('hex'),
      nonce: nonce.toString('hex'),
      realSize: chunkData.length // Store real size to truncate padding on read
    })

    offset = end
  }

  return {
    fileEntry: {
      name: fileName,
      size: totalSize,
      chunks
    },
    blobs
  }
}

export async function reassemble (fileEntry, getBlobFn) {
  const parts = []

  for (const chunkMeta of fileEntry.chunks) {
    const blobBuffer = await getBlobFn(chunkMeta.blobId)
    if (!blobBuffer) throw new Error(`Blob ${chunkMeta.blobId} not found`)

    const key = Buffer.from(chunkMeta.key, 'hex')
    const nonce = Buffer.from(chunkMeta.nonce, 'hex')
    const plaintext = Buffer.alloc(blobBuffer.length - ABYTES)

    try {
      sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
        plaintext,
        null,
        blobBuffer,
        null,
        nonce,
        key
      )
    } catch (err) {
      throw new Error(`Decryption failed for blob ${chunkMeta.blobId}`)
    }

    // Truncate padding
    const realData = plaintext.slice(0, chunkMeta.realSize)
    parts.push(realData)
  }

  return Buffer.concat(parts)
}
