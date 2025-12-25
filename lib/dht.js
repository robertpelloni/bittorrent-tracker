import { WebSocket } from 'ws'

export function findBlob (trackerUrl, blobId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(trackerUrl)

    ws.on('open', () => {
      ws.send(JSON.stringify({
        action: 'find_blob',
        blob_id: blobId
      }))
    })

    ws.on('message', data => {
      try {
        const msg = JSON.parse(data)
        if (msg.action === 'find_blob_result' && msg.blob_id === blobId) {
          ws.close()
          resolve(msg.peers || [])
        }
      } catch (e) {}
    })

    ws.on('error', reject)

    setTimeout(() => {
      ws.close()
      resolve([]) // Resolve empty on timeout
    }, 2000)
  })
}
