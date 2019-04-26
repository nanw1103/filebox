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
httpServer.listen(port, () => { console.log('FileBox is listening on port ' + port) })

const REPO = path.join(__dirname, 'download')
if (!fs.existsSync(REPO))
	fs.mkdir(REPO, err => { if (err) console.error(err) })

function requestHandler(req, res) {
	let handler
	if (req.url === CONTEXT_ROOT && req.method === 'GET') {
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

	handler(req, res)
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
		return RESP404
	let content = await readFile(file)
	return createResponse(content, 200, 'application/octet-stream', Buffer.byteLength(content))
}

function uploadFile(req) {
	console.log(req.headers)
	let target = path.basename(req.url)
	let file = path.join(REPO, target)

	let contentType = req.headers['content-type']
	if (contentType.startsWith('multipart/form-data;')) {
		return handleMultiPartUpload()
	} else if (contentType.startsWith('application/x-www-form-urlencoded')) {
		return handleBinaryUpload()
	} else {
		return handleBinaryUpload()
	}

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
const INDEX_HTML = `
<!DOCTYPE html>
<html>
<head>
	<title>FileBox</title>
	<link rel="icon" type="image/x-icon" href="data:image/x-icon;data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAA7EAAAOxAGVKw4bAAAABGdBTUEAALGOfPtRkwAAACBjSFJNAAB6JQAAgIMAAPn/AACA6QAAdTAAAOpgAAA6mAAAF2+SX8VGAAABG0lEQVR42mL8//8/w0ACgABioUQz4+KX92Hs/7HiiuSYARBATFTwhAIlmgECiIlhgAFAALFQO0hJjS6AAGLCFaTIGqhoOUZ0AQQQNgc8oKYj0Cx/gC4PEEAoDkAKGqo4Apvl6FELEEAYIYDNEVTIJQ9wpSuAAMKaC9AcQQg8IEYeV6IGCCDGgS4JAQJowMsBgAAacAcABNCAOwAggFiIKbmoAXAlQoAAYiEiC1ED4MwpAAE04FEAEEAsRAYfI5klIcE8DhBAAx4CAAE04A4ACKABdwBAAA24AwACaMAdABBAA+4AgAAacAcABNCAOwAggIgqiIgpUMgFAAE04CEAEECEQuABrR0AEEAD3iQDCKABjwKAABpwBwAEGAAhqEKviILPUgAAAABJRU5ErkJggg==" />
	<style>
		body {
			display: flex;
			flex-direction: column;
			justify-content: flex-start;
			align-content: center;
			align-items: center;
		}

		#toast {
			visibility: hidden;
			background-color: black;
			min-width: 250px;
			margin-left: -125px;
			color: #fff;
			text-align: center;
			border-radius: 2px;
			padding: 16px;
			position: fixed;
			z-index: 1;
			left: 50%;
			bottom: 30px;
		}

		.toast-visible-error {
			visibility: visible !important;
			animation: fadein 0.5s, fadeout 0.5s 2.5s;
			background-color: red !important;
		}

		.toast-visible-success {
			visibility: visible !important;
			animation: fadein 0.5s, fadeout 0.5s 2.5s;
			background-color: green !important;
		}

		.hint {
			color: #888;
			text
		}
		
		@keyframes fadein {
			from {
				bottom: 0;
				opacity: 0;
			}
			to {
				bottom: 30px;
				opacity: 1;
			}
		}

		@keyframes fadeout {
			from {
				bottom: 30px;
				opacity: 1;
			}
			to {
				bottom: 0;
				opacity: 0;
			}
		}

		.btn {
			display: inline-block;
			min-width: 88px;
			height: 36px;
			line-height: 36px;
			border: none;
			border-radius: 5px;
			background-color: orange;
			text-align: center;
			text-decoration: none;
			text-transform: uppercase;
			padding: 0 10px;
			color: white;
			cursor: pointer;
			transition: opacity 0.25s ease-in-out;
		}

		.btn-raised {
			box-shadow: var(--bs1);
		}

		.btn-clear {
			background-color: grey;
		}

		.hidden {
			display: none;
		}
	</style>
</head>

<body>
	<h3>FileBox</h3>
	<table>
		<tr>
			<td>
				<!-- Upload -->
				<label for="upload" class="btn btn-raised">Upload</label>
				<input class="hidden" id="upload" type="file" onchange="uploadFile(event)" /><br/>
			</td>
			<td width='50'></td>
			<td>
				<!-- Clear -->
				<a href='#' onClick="clearFiles()">Delete All</a>
			</td>
		</tr>
	</table>
	<ol id="download"></ol>
	<br/>
	<table class='hint'>
		<tr>
			<td nowrap>CLI example - upload:</td>
			<td nowrap>curl -X PUT <span name="href_field"></span>myfile -T myfile</td>
		</tr>
		<tr>
			<td nowrap valign="top">CLI example - download:</td>
			<td nowrap>
				curl <span name="href_field"></span>myfile<br/>
				wget <span name="href_field"></span>myfile
			</td>
		</tr>
	</table>
	<br/><br/>
	<a href='https://github.com/nanw1103/filebox' class='hint'>https://github.com/nanw1103/filebox</a>

	<div id="toast"></div>
	<script>
		var downloadDOM = document.getElementById('download')
		var toastDOM = document.getElementById('toast')
		listFiles()
		let baseUrl = window.location.href.substring(0, window.location.href.indexOf('#'))
		let hostFields = document.getElementsByName('href_field')
		for (let f of hostFields)
			f.innerText = baseUrl

		function uploadFile(event) {
			let target = event.target || event.srcElement || event.currentTarget
			let file = target.files[0]
			sendRequest('PUT', '${CONTEXT_ROOT}' + file.name, file, result => {
				showToastMessage('Uploaded', 'success')
				listFiles()
			})
			event.target.value = ''
		}

		function deleteFile(name) {
			sendRequest('DELETE', '${CONTEXT_ROOT}' + name, null, result => {
				showToastMessage('Deleted', 'success')
				listFiles()
			})
		}

		function clearFiles(event) {
			sendRequest('POST', '${CONTEXT_ROOT}clear', null, result => {
				showToastMessage('Cleared', 'success')
				listFiles()
			})
		}

		function listFiles() {
			sendRequest('POST', '${CONTEXT_ROOT}list', null, result => {
				let files = JSON.parse(result)
				let listOfFileHTML = "<table><tr><th>Name</th><th width='50'></th><th>Size</th><th width='50'></th><th>Delete</th></tr>"
				for (let file of files)
					listOfFileHTML += "<tr><td><a href='${CONTEXT_ROOT}" + file.name + "'>" + file.name + "</a></td><td></td><td>" + file.size + "</td><td></td><td><a href='#' onclick='deleteFile(\\"" + file.name + "\\")'>X</a></td></tr>"
				listOfFileHTML += "</table>"
				downloadDOM.innerHTML = listOfFileHTML
			})
		}

		function sendRequest(method, url, data, callback) {
			let xhr = new XMLHttpRequest()
			xhr.open(method, url, true)
			if (method === 'PUT')
				xhr.setRequestHeader('Content-Type', 'application/octate-stream')
			xhr.onreadystatechange = function () {
				if (xhr.readyState === 4) {
					if (xhr.status === 200) {
						callback(xhr.responseText)
					} else {
						showToastMessage(xhr.responseText, 'error')
					}
				}
			}
			xhr.send(data)
		}

		function showToastMessage(msg, type) {
			toastDOM.innerText = msg
			if (type === 'error') {
				toastDOM.classList.add('toast-visible-error')
				setTimeout(function () { toastDOM.classList.remove('toast-visible-error') }, 3000)
			} else {
				console.log('toastdom', toastDOM)
				toastDOM.classList.add('toast-visible-success')
				setTimeout(function () { toastDOM.classList.remove('toast-visible-success') }, 3000)
			}
		}
	</script>
</body>
</html>
`

const RESP_200 = createResponse('', 200)
const RESP_400 = createResponse('Invalid request', 400)
const RESP_400_INCOMPLETE = createResponse('Incomplete upload', 400)
const RESP_404 = createResponse('Not found', 404)
const RESP_INDEX = createResponse(INDEX_HTML, 200, 'text/html')
