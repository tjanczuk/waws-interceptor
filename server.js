require('http').createServer(function (req, res) {
	res.writeHead(200, { 'Content-Type': 'text/plain' });
	console.log('Sample stdout message');
	console.error('Sample stderr message');
	console.log('Request headers:' + JSON.stringify(req.headers, null, 2));
	res.write(JSON.stringify(process.env, null, 2));
	res.end('CWD: ' + process.cwd());
}).listen(process.env.PORT || 3000);