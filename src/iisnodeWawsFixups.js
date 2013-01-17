var fs = require('fs');

// If this is x64 node on x64 system, use %windir%\system32 directory.
// Otherwise assume x86 node on x64 system and use %windir%\sysinternal directory to 
// avoid WOW file system redirection.
var schemaFile = process.env.windir 
	+ (process.arch === 'x64' ? '\\system32' : '\\sysnative')
	+ '\\inetsrv\\config\\schema\\iisnode_schema.xml';

var schema = fs.readFileSync(schemaFile, 'utf8');

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

fs.writeFileSync(schemaFile, schema);
