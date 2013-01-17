var fs = require('fs')
	, path = require('path');
	existsSync = fs.existsSync || path.existsSync;

if (!existsSync(process.argv[2])) {
	throw new Error('The first argument must be the full filename of the iisnode_schema.xml file.');
}

var schema = fs.readFileSync(process.argv[2], 'utf8');

schema = schema

	// adjust the default logDirectory to point to the default WAWS application log location
	.replace('defaultValue="iisnode"', 
		'defaultValue="..\\..\\LogFiles\\Application"')

	// adjust the default watchedFiles to enable watching for express views
	.replace('defaultValue="*.js;iisnode.yml"', 
		'defaultValue="*.js;iisnode.yml;node_modules\\*;views\\*.jade;views\\*.ejb;routes\\*.js"')

	// disable logging
	.replace('name="loggingEnabled" type="bool" defaultValue="true"',
		'name="loggingEnabled" type="bool" defaultValue="false"')

	// disable debugging
	.replace('name="debuggingEnabled" type="bool" defaultValue="true"',
		'name="debuggingEnabled" type="bool" defaultValue="false"');

fs.writeFileSync(process.argv[2], schema);
