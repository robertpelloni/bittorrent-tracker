import sodium from 'sodium-native'

// Create Signed Manifest (Optional Encryption)
export function createManifest (keypair, sequence, collections, readKeyHex = null) {
  let content = {
    collections,
    timestamp: Date.now()
  }

  // Encrypt content if readKey provided
  if (readKeyHex) {
    const readKey = Buffer.from(readKeyHex, 'hex')
    const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES)
    sodium.randombytes_buf(nonce)

    const plaintext = Buffer.from(JSON.stringify(content))
    const cipher = Buffer.alloc(plaintext.length + sodium.crypto_secretbox_MACBYTES)
    sodium.crypto_secretbox_easy(cipher, plaintext, nonce, readKey)

    content = {
      encrypted: true,
      nonce: nonce.toString('hex'),
      ciphertext: cipher.toString('hex')
    }
  }

  const manifest = {
    publicKey: keypair.publicKey.toString('hex'),
    sequence,
    ...content
  }

  // Sign canonical JSON (keys sorted)
  const canonical = Buffer.from(JSON.stringify(manifest))

  const signature = Buffer.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(signature, canonical, keypair.secretKey)

  manifest.signature = signature.toString('hex')
  return manifest
}

export function validateManifest (manifest) {
  if (!manifest.publicKey || !manifest.signature || !manifest.sequence) return false

  const signature = Buffer.from(manifest.signature, 'hex')
  const publicKey = Buffer.from(manifest.publicKey, 'hex')

  const clean = { ...manifest }
  delete clean.signature
  const message = Buffer.from(JSON.stringify(clean))

  return sodium.crypto_sign_verify_detached(signature, message, publicKey)
}

export function decryptManifest (manifest, readKeyHex) {
  if (!manifest.encrypted) return manifest
  if (!readKeyHex) throw new Error('Manifest is encrypted but no key provided')

  const readKey = Buffer.from(readKeyHex, 'hex')
  const nonce = Buffer.from(manifest.nonce, 'hex')
  const cipher = Buffer.from(manifest.ciphertext, 'hex')
  const plain = Buffer.alloc(cipher.length - sodium.crypto_secretbox_MACBYTES)

  if (!sodium.crypto_secretbox_open_easy(plain, cipher, nonce, readKey)) {
    throw new Error('Failed to decrypt manifest')
  }

  const content = JSON.parse(plain.toString())
  return {
    publicKey: manifest.publicKey,
    sequence: manifest.sequence,
    ...content
  }
}
