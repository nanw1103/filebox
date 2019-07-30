#!/bin/env node

/*
	Tiny file upload & download server, in NodeJs. All in one self-contained file, without any NPM dependency.
	https://github.com/nanw1103/filebox
*/

const CONTEXT_ROOT = '/'
//const CONTEXT_ROOT = '/filebox/'	//switch to another context root on demand
const port = process.argv[2] || 3000

//------------------------------------------------------

const http = require('http')
const fs = require('fs')
const path = require('path')
const promisify = require('util').promisify
const unlink = promisify(fs.unlink.bind(fs))
const readFile = promisify(fs.readFile.bind(fs))
const readdir = promisify(fs.readdir.bind(fs))

const httpServer = http.createServer(requestHandler)
httpServer.listen(port, () => { 
	console.log(`FileBox is on http://localhost:${port}${CONTEXT_ROOT}`)
})

const REPO = path.join(__dirname, 'download')
if (!fs.existsSync(REPO))
	fs.mkdir(REPO, err => { if (err) console.error(err) })

const ctxRootNoSlash = CONTEXT_ROOT.substring(0, CONTEXT_ROOT.length - 1)
function requestHandler(req, res) {
	let handler
	if (req.url === CONTEXT_ROOT || req.url === ctxRootNoSlash && req.method === 'GET') {
			return sendResp(RESP_INDEX)
	} else if (req.url === `${CONTEXT_ROOT}list` && req.method === 'POST') {
		handler = listFiles
	} else if (req.url === `${CONTEXT_ROOT}clear` && req.method === 'POST') {
		handler = clearFiles
	} else if (req.url.startsWith(CONTEXT_ROOT)) {
		if (req.method === 'PUT')
			handler = uploadFile
		else if (req.method === 'GET')
			handler = downloadFile
		else if (req.method === 'DELETE')
			handler = deleteFile
		else
			return sendResp(RESP_400)
	} else {
		return sendResp(RESP_404)
	}

	let safeTask = async () => handler(req, res)
	safeTask()
		.catch(err => createResponse(err.toString(), err.statusCode || 500))
		.then(sendResp)

	function sendResp(response) {
		console.log(req.method.padEnd(6), req.url, '->', response.statusCode, getClientIp(req))
		res.writeHead(response.statusCode, response.headers)
		res.write(response.content)
		res.end()
	}
}

function createResponse(content, statusCode = 200, contentType, contentLength) {
	let headers = {}
	if (typeof content === 'object' && !(content instanceof Buffer)) {
		content = JSON.stringify(content)
		contentType = contentType || 'application/json'
	} else {
		contentType = contentType || 'text/plain'
	}
	headers['Content-Type'] = contentType
	if (contentLength)
		headers['Content-Length'] = contentLength
	return {
		statusCode,
		content,
		headers
	}
}

async function listFiles() {
	let names = await readdir(REPO)		
	let files = []
	for (let name of names) {
		let stat = fs.statSync(path.join(REPO, name))
		let size = stat.size
		let type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'
		files.push({
			name,
			size,
			type
		})
	}
	return createResponse(files)
}

async function downloadFile(req) {
	let target = path.basename(req.url)
	let file = path.join(REPO, target)
	if (!fs.existsSync(file))
		return RESP_404
	let content = await readFile(file)
	return createResponse(content, 200, 'application/octet-stream', Buffer.byteLength(content))
}

function uploadFile(req) {
	let target = path.basename(req.url)
	let file = path.join(REPO, target)

	let contentType = req.headers['content-type']
	if (contentType) {
		if (contentType.startsWith('multipart/form-data;'))
			return handleMultiPartUpload()
		if (contentType.startsWith('application/x-www-form-urlencoded'))
			return handleBinaryUpload()
		if (contentType.startsWith('application/octate-stream'))
			return handleBinaryUpload()
		console.log('Unknown content type:', contentType)
	}
	return handleBinaryUpload()

	function handleBinaryUpload() {
		return new Promise((resolve, reject) => {
			req.on('error', finish)
				.on('end', finish)
				.pipe(fs.createWriteStream(file))
			function finish(err) {
				if (err)
					return reject(createResponse(err.toString(), 500))
				return resolve(RESP_200)
			}
		})
	}

	function handleMultiPartUpload() {
		let BOUNDARY_KEY = 'boundary='
		let i = contentType.indexOf(BOUNDARY_KEY)
		if (i < 0) {
			let e = new Error('boundary key not found')
			e.statusCode = 400
			return Promise.reject(e)
		}
		let boundary = contentType.substring(i + BOUNDARY_KEY.length)
		let sectionStartSep = '--' + boundary
		let sectionEndSep = '\r\n' + sectionStartSep + '--'
		let complete
		let length = 0
		return new Promise((resolve, reject) => {
			let sectionStartFound = false
			let out
			try {
				out = fs.createWriteStream(file)
				req
					.on('data', onData)
					.on('error', finish)
					.on('end', finish)
			} catch (e) {
				finish(e)
			}
			
			function onData(data) {
				if (!sectionStartFound) {
					let i = data.indexOf(sectionStartSep)
					if (i < 0)
						return
					sectionStartFound = true
					console.log('sectionStartFound')
					let headerEnd = data.indexOf('\r\n\r\n', i)
					if (headerEnd < 0) {
						let e = new Error('Multi-part header end not found')
						e.statusCode = 400
						return finish(e)
					}
					data = data.slice(headerEnd + 4)
				}
				
				let end = data.indexOf(sectionEndSep)
				if (end >= 0) {
					data = data.slice(0, end)
					complete = true
					console.log('footer found.')
				}
				
				writeToOut(data, () => {
					if (complete) {
						out.end()
						console.log('Uploaded', length)
						console.log('footer reached. End out stream')
					}
				})
				
				function writeToOut(data, cb) {
					length += data.length
					if (!out.write(data)) {
						out.once('drain', () => {
							req.resume()
							cb()							
						})
						req.pause()
					} else {
						process.nextTick(cb)
					}
				}
				/*
				{ host: 'localhost:3000',
				  'user-agent': 'curl/7.56.1',
				  'content-length': '211',
				  'content-type':
				   'multipart/form-data; boundary=------------------------270f77bdf3ae1285' }
				--------------------------270f77bdf3ae1285
				Content-Disposition: form-data; name="file"; filename="aws-rbm.sh"
				Content-Type: application/octet-stream

				ssh -i "nanw-8084-Wakaka.pem" ec2-user@robomod.org
				--------------------------270f77bdf3ae1285--
				*/
			}
			
			function finish(err) {
				if (err) {
					if (out) {
						try {
							out.end()
						} catch (e) {
							console.error(e)
						}
					}
					return reject(err)
				}
				if (!complete)
					return reject(RESP_400_INCOMPLETE)
				resolve(RESP_200)
			}
		})
	}
}

async function deleteFile(req) {
	let target = path.basename(req.url)
	let file = path.join(REPO, target)
	await unlink(file)
	return RESP_200
}

async function clearFiles() {
	let names = await readdir(REPO)
	let tasks = names.map(deleteFile)
	let ret = await Promise.all(tasks)
	return createResponse(ret)

	function deleteFile(name) {
		return unlink(path.join(REPO, name)).catch(e => e)
	}
}

function getClientIp(req) {
	let addrs = new Set
	if (req.headers['x-forwarded-for'])
		addrs.add(req.headers['x-forwarded-for'])
	if (req.connection && req.connection.remoteAddress)
		addrs.add(req.connection.remoteAddress)
	if (req.socket && req.socket.remoteAddress)
		addrs.add(req.socket.remoteAddress)
	if (req.connection && req.connection.socket && req.connection.socket.remoteAddress)
		addrs.add(req.connection.socket.remoteAddress)
	return Array.from(addrs).join(', ')
}

//--------------------------------
const INDEX_HTML = fs.readFileSync('./template.html', 'utf8')
	.replace('${CONTEXT_ROOT_PLACE_HOLDER}', CONTEXT_ROOT)

const RESP_200 = createResponse('', 200)
const RESP_400 = createResponse('Invalid request', 400)
const RESP_400_INCOMPLETE = createResponse('Incomplete upload', 400)
const RESP_404 = createResponse('Not found', 404)
const RESP_405 = createResponse('Method not allowed', 405)
const RESP_INDEX = createResponse(INDEX_HTML, 200, 'text/html')
