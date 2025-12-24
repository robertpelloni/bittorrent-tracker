import net from 'net'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream'

export function startServer(storageDir, port = 0) {
    const server = net.createServer(socket => {
        socket.once('data', data => {
            const request = data.toString().trim()
            if (request.startsWith('GET ')) {
                const blobId = request.split(' ')[1]
                const filePath = path.join(storageDir, blobId)

                if (fs.existsSync(filePath)) {
                    const stream = fs.createReadStream(filePath)
                    pipeline(stream, socket, (err) => {
                        if (err) console.error('Pipe failed', err)
                    })
                } else {
                    socket.write('ERROR: Not Found')
                    socket.end()
                }
            } else {
                socket.end()
            }
        })
    })

    server.listen(port, () => {
        // console.log(`Blob Server listening on ${server.address().port}`)
    })

    server.port = server.address() ? server.address().port : port
    return server
}
