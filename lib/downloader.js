import net from 'net'

export function downloadBlob (peer, blobId) {
  return new Promise((resolve, reject) => {
    // Peer format: "IP:Port"
    const [host, portStr] = peer.split(':')
    const port = parseInt(portStr)

    const socket = new net.Socket()
    const chunks = []

    socket.connect(port, host, () => {
      socket.write(`GET ${blobId}\n`)
    })

    socket.on('data', data => chunks.push(data))
    socket.on('end', () => {
      const buffer = Buffer.concat(chunks)
      if (buffer.toString().startsWith('ERROR')) {
        reject(new Error('Peer returned error'))
      } else {
        resolve(buffer)
      }
    })
    socket.on('error', reject)

    setTimeout(() => {
      socket.destroy()
      reject(new Error('Timeout'))
    }, 5000)
  })
}
