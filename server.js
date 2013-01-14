require('http').createServer(function (req, res) {
	res.writeHead(200, { 'Content-Type': 'text/plain' });
	res.write(JSON.stringify(process.env, null, 2));
	res.end('CWD: ' + process.cwd());
}).listen(process.env.PORT || 3000);