/*

In Windows Azure Web Sites environment, this interceptor file replaces the default one that iisnode.msi installs. 
It is meant to support console output logging to files on disk or Azure table storage, as well as integrate with
Azure portal settings for diagnostics which are stored in the <wwwroot>\..\diagnostics\settings.json file.

This is a mapping from settings 
    (loggingEnabled in iisnode.yml, file logging switch on the portal, azure table storage switch on the portal) 
to what actual logging happens 
    (file logging, table storage logging): 

(N/A, off, off) -> (off, off)
(N/A, on, off) -> (on, off)
(N/A, off, on) -> (off, on)
(N/A, on, on) -> (on, on)
(true, *, off) -> (on, off)
(true, *, on) -> (on, on)
(false, *, off) ->(off, off)
(false, *, on) ->(off, on)

In plain English:
1. Portal is the only way to turn logging to Azure table storage on or off. iisnode.yml has no control over that. 
2. If iisnode.yml is not explicit about logging, portal controls whether logging to files is on or off. 
   (NOTE: this assumes by default portal has file logging disabled). 
3. If iisnode.yml is explicit about logging, it overrides whatever file logging setting there is on the portal. 

*/

(function () {

    var path = require('path')
        , fs = require('fs')
        , crypto = require('crypto')
        , http = require('http')
        , https = require('https');

    // polyfill node v0.7 fs.existsSync with node v0.6 path.existsSync

    var existsSync = fs.existsSync || path.existsSync;

    // install uncaughtException handler such that we can trace the unhandled exception to stderr
    process.on('uncaughtException', function (e) {
        
        // only act on the uncaught exception if the app has not registered another handler
        if (1 === process.listeners('uncaughtException').length) {
            //fs.writeFileSync('c:\\program files\\iisnode\\www\\helloworld\\error.txt', e.toString() + e.stack);
            logLastResort(new Date().toString() + ': unaught exception: ' + (e.stack || (new Error(e).stack)));
            console.error('Application has thrown an uncaught exception and is terminated:\n' + (e.stack || (new Error(e).stack)));
            process.exit(1);
        }
    });    

   // refactor process.argv to determine the app entry point and remove the interceptor parameter

    var appFile;
    var newArgs = [];
    process.argv.forEach(function (item, index) {
        if (index === 2)
            appFile = item;
        if (index !== 1)
            newArgs.push(item);
    });

    process.argv = newArgs;    

    // establish logging parameters and settings

    var settingsDefaults = { // defaults for settings from the portal
      "AzureDriveEnabled": false,
      "AzureDriveTraceLevel": "Verbose",
      "AzureDriveBufferFlushIntervalMs": "1000",
      "AzureDriveMaxBufferSizeBytes": "1048576",
      "AzureDriveMaxLogFileSizeBytes": "2000",
      "AzureDriveMaxLogFolderSizeBytes": "20971520",
      "AzureTableEnabled": false,
      "AzureTableTraceLevel": "Verbose",
      "AzureTableBufferFlushIntervalMs": "1000",
      "AzureTableMaxBufferSizeBytes": "1048576"
    };

    var settings = {};

    applySettingOverrides(settings, settingsDefaults);

    var maxLogSize = (process.env.IISNODE_MAXLOGFILESIZEINKB || 128) * 1024; // iisnode.yml file logging only
    var maxTotalLogSize = (process.env.IISNODE_MAXTOTALLOGFILESIZEINKB || 1024) * 1024; // iisnode.yml file logging only
    var maxLogFiles = (+process.env.IISNODE_MAXLOGFILES) || 20; // iisnode.yml file logging only
    var relativeLogDirectory = process.env.IISNODE_LOGDIRECTORY || 'iisnode'; // iisnode.yml file logging only
    var lastResortLogFile = path.resolve(relativeLogDirectory, process.env.IISNODE_LASTRESORTLOGFILE || 'iisnode-error.txt');
    var wwwroot = path.dirname(appFile);
    var logDir = path.resolve(wwwroot, relativeLogDirectory); // iisnode.yml file logging only
    var htmlTemplate = fs.readFileSync(process.env.IISNODE_LOGGING_INDEX_TEMPLATE || path.resolve(__dirname, 'logs.template.html'), 'utf8');
    var indexFile = process.env.IISNODE_LOGGING_INDEX_FILE || 'index.html';
    var azureAccountName = process.env.IISNODE_LOGGING_STORAGE_ACCOUNT;
    var azureKey = process.env.IISNODE_LOGGING_STORAGE_KEY;
    var azureEndpointProtocol = process.env.IISNODE_LOGGING_ENDPOINT_PROTOCOL || 'https';
    var azureTableName = process.env.DIAGNOSTICS_LOGGINGTABLENAME || 'WAWSAppLogTable';
    var settingsFilePollInterval = process.env.IISNODE_LOGGING_SETTINGS_POLL_INTERVAL || 5000;
    var settingsFile = path.resolve(wwwroot, process.env.DIAGNOSTICS_LOGGINGSETTINGSFILE || '..\\diagnostics\\settings.json');
    var iisnodeYmlFile = path.resolve(wwwroot, process.env.IISNODE_LOGGING_IISNODE_YML_FILE || 'iisnode.yml');
    var azureDriveLogDirectory = path.resolve(wwwroot, process.env.DIAGNOSTICS_AZUREDRIVELOGDIRECTORY || '..\\..\\LogFiles\\Application');
    var azureErrors = 0;
    var maxAzureErrors = process.env.DIAGNOSTICS_MAXAZURETABLEERRORS || 10;
    var newLine = new Buffer('\r\n');

    // process Azure table storage credentials

    if (process.env.CUSTOMCONNSTR_CLOUD_STORAGE_ACCOUNT) {
        azureAccountName = getKeyOrDefault('AccountName', azureAccountName);
        azureKey = getKeyOrDefault('AccountKey', azureKey);
        azureEndpointProtocol = getKeyOrDefault('DefaultEndpointsProtocol', azureEndpointProtocol);

        function getKeyOrDefault(key, defaultValue) {
            var regex = new RegExp(key + '=([^;]+)');
            var match = regex.exec(process.env.CUSTOMCONNSTR_CLOUD_STORAGE_ACCOUNT);
            return match ? match[1] : defaultValue;
        }
    }

    if (typeof azureKey === 'string') {
        azureKey = new Buffer(azureKey, 'base64');
    }

    // computed and derived properties

    var iisnodeLoggingEnabled;

    function isFileLoggingEnabled() {
        return iisnodeLoggingEnabled === undefined ? settings.AzureDriveEnabled : iisnodeLoggingEnabled;
    }

    function isTableLoggingEnabled() {
        return settings.AzureTableEnabled && typeof azureAccountName === 'string' && Buffer.isBuffer(azureKey);
    }

    function getMaxLogSize() {
        return iisnodeLoggingEnabled === undefined ? +settings.AzureDriveMaxLogFileSizeBytes : maxLogSize;
    }

    function getMaxTotalLogSize() {
        return iisnodeLoggingEnabled === undefined ? +settings.AzureDriveMaxLogFolderSizeBytes : maxTotalLogSize;
    }

    function getLogDir() {
        return iisnodeLoggingEnabled === undefined ? azureDriveLogDirectory : logDir;
    }

    function getMaxLogFiles() {
        return maxLogFiles;
    }

    // establish a file watcher on the settings file; use polling instead of file watcher on XDrive
    if (existsSync(settingsFile)) {
        tryReadSettingsFile();
        setTimeout(checkSettingsFile, settingsFilePollInterval);

        var modifiedTime;
        function checkSettingsFile() {
            fs.stat(settingsFile, function (error, stat) {
                if (!error && stat.mtime.getTime() != modifiedTime && tryReadSettingsFile()) {
                    modifiedTime = stat.mtime.getTime();
                }

                setTimeout(checkSettingsFile, settingsFilePollInterval);
            });
        }

        function tryReadSettingsFile() {
            try {
                settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
                applySettingOverrides(settings, settingsDefaults);
            }
            catch (e) {
                // empty - might be a race condition with the portal code updating the file
                // the timer will re-attempt the read a moment later
                return false;
            }

            return true;            
        }
    }

    // determine if logging is enabled in iisnode.yml

    if (existsSync(iisnodeYmlFile)) {
        var yml;
        try {
            yml = fs.readFileSync(iisnodeYmlFile, 'utf8');
        }
        catch (e) {
            // unable to read iisnode.yml file; fallback to using portal setting
            yml = '';
        }

        var match = yml.match(/^ *loggingEnabled *: *(false|true) *(?:$|#)/m);
        if (match) {
            iisnodeLoggingEnabled = match[1] === 'true';
        }
    }

    // intercept stdout and stderr

    intercept(process.stdout, 'stdout');
    intercept(process.stderr, 'stderr');

    function logLastResort(entry) {
        try {
            var f = fs.openSync(lastResortLogFile, 'a');
            var b = ensureBuffer(entry);
            fs.writeSync(f, b, 0, b.length, null);
            fs.writeSync(f, newLine, 0, newLine.length, null);
            fs.closeSync(f);
        } 
        catch (e) {
            // empty
        }           
    }

    // override settings with environment variables
    function applySettingOverrides(settings, settingsDefaults) {

        // Settings precedence:
        // 1. Environment variable
        // 2. Setting value from settings.json file
        // 3. Hardcoded default
        for (var i in settingsDefaults) {
            var envName = 'DIAGNOSTICS_' + i.toUpperCase();
            if (process.env[envName]) {
                settings[i] = process.env[envName];
            }
            else if (settings[i] === undefined) {
                settings[i] = settingsDefaults[i];
            }
        }

        if (typeof settings.AzureDriveEnabled === 'string') {
            settings.AzureDriveEnabled = settings.AzureDriveEnabled === 'true' || settings.AzureDriveEnabled == 1;
        }

        if (typeof settings.AzureTableEnabled === 'string') {
            settings.AzureTableEnabled = settings.AzureTableEnabled === 'true' || settings.AzureTableEnabled == 1;
        }
    }    
   
    // ensure the log directory structure exists

    function ensureDir(dir) {
        if (!existsSync(dir)) {

            ensureDir(path.dirname(dir));

            try {
                fs.mkdirSync(dir);
            }
            catch (e) {

                // check if directory was created in the meantime (by another process)

                if (!existsSync(dir))
                    throw e;
            }
        }
    };

    // generate index.html file

    function updateIndexHtml() {
        var files = fs.readdirSync(getLogDir());
        var logFiles = [];

        files.forEach(function (file) {
            var match = file.match(/(.+)-(\d+)-(stderr|stdout)-(\d+)\.txt$/);
            if (match) {
                logFiles.push({
                    file: file,
                    computername: match[1],
                    pid: +match[2],
                    type: match[3],
                    created: +match[4]
                });
            }
        });

        var html = htmlTemplate.replace('[]; //##LOGFILES##', JSON.stringify(logFiles)).replace('0; //##LASTUPDATED##', new Date().getTime());

        try {
            fs.writeFileSync(path.resolve(getLogDir(), indexFile), html);
        }
        catch (e) {
            // empty - might be a collistion with concurrent update of index.html from another process
        }
    };

    // make best effort to purge old logs if total size or file count exceeds quota

    function purgeOldLogs() {
        var files = fs.readdirSync(getLogDir());
        var stats = [];
        var totalsize = 0;

        files.forEach(function (file) {
            if (file !== indexFile) {
                try {
                    var stat = fs.statSync(path.resolve(getLogDir(), file));
                    if (stat.isFile()) {
                        stats.push(stat);
                        stat.file = file;
                        totalsize += stat.size;
                    }
                }
                catch (e) {
                    // empty - file might have been deleted by other process
                }
            }
        });

        if (totalsize > getMaxTotalLogSize() || stats.length > getMaxLogFiles()) {

            // keep deleting files from the least recently modified to the most recently modified until
            // the total size and number of log files gets within the respective quotas

            stats.sort(function (a, b) {
                return a.mtime.getTime() - b.mtime.getTime();
            });

            var totalCount = stats.length;

            stats.some(function (stat) {
                try {
                    fs.unlinkSync(path.resolve(getLogDir(), stat.file));
                    totalsize -= stat.size;
                    totalCount--;
                }
                catch (e) {
                    // likely indicates the file is still in use; leave it alone
                }

                return totalsize <= getMaxTotalLogSize() && totalCount <= getMaxLogFiles();
            });
        }
    };

    // normalize newlines and convert to Buffer

    function ensureBuffer(data, encoding) {
        if (Buffer.isBuffer(data)) {
            return data;
        }
        else {
            data = data.toString()
                .replace(/\n+$/, '')
                .replace(/\n/g, '\r\n');
            return new Buffer(data, typeof encoding === 'string' ? encoding : 'utf8');
        }
    };        

    // intercept a stream

    function intercept(stream, type) {

        var currentLogDir;
        var currentLog;
        var currentSize;
        var currentLogCreated;

        rolloverLog(); // create a new log file

        stream.write = stream.end = function (data, encoding) {
            if (isFileLoggingEnabled(type) || isTableLoggingEnabled(type)) {
                var buffer = ensureBuffer(data, encoding);

                if (isFileLoggingEnabled(type)) {
                    logToFile(buffer);
                }

                if (isTableLoggingEnabled(type)) {
                    logToTable(buffer, true);
                }
            }
        };

        function rolloverLog() {
            var now = new Date().getTime();
            var filename = process.env.COMPUTERNAME + '-' + process.pid + '-' + type + '-' + now + '.txt';
            currentLogDir = getLogDir();
            ensureDir(currentLogDir);
            currentLog = path.resolve(currentLogDir, filename);
            currentSize = 0;
            currentLogCreated = false;
            purgeOldLogs();
        };

        function logToFile(buffer) {
            if (currentSize > getMaxLogSize() || currentLogDir !== getLogDir()) {
                // create a new log file when the old one exceeded the maximum size or
                // when the logging directory has changed
                rolloverLog();
            }

            if (!currentLogCreated) {
                fs.writeFileSync(currentLog, '', 'utf8');
                updateIndexHtml();
                currentLogCreated = true;
            }

            var f = fs.openSync(currentLog, 'a');
            currentSize += fs.writeSync(f, buffer, 0, buffer.length, currentSize);
            currentSize += fs.writeSync(f, newLine, 0, newLine.length, currentSize);
            fs.closeSync(f);            
        }

        var createTableEntryTemplate = (function () {/*
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<entry xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices" 
       xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" 
       xmlns="http://www.w3.org/2005/Atom">
  <title />
  <updated>##DATE##</updated>
  <author>
    <name />
  </author>
  <id />
  <content type="application/xml">
    <m:properties>
      <d:Message>##MESSAGE##</d:Message>
      <d:ApplicationName>##APPLICATION##</d:ApplicationName>
      <d:Level m:type="Edm.Int32">##LEVEL##</d:Level>
      <d:PartitionKey>##PARTITIONKEY##</d:PartitionKey>
      <d:RowKey>##ROWKEY##</d:RowKey>
      <d:ComputerName>##COMPUTERNAME##</d:ComputerName>
      <d:Pid m:type="Edm.Int64">##PID##</d:Pid>
      <d:Timestamp m:type="Edm.DateTime">##DATE##</d:Timestamp>
    </m:properties>
  </content>
</entry>
        ~*/}).toString().match(/[^\n]\n([^\~]*)/)[1];        

        function logToTable(buffer, allowCreate) {
            if (azureErrors >= maxAzureErrors) {
                return;
            }

            var now = new Date();
            var isoDate = getISO8061Date(now);
            var payload = createTableEntryTemplate
                .replace(/##DATE##/g, isoDate)
                .replace(/##APPLICATION##/, xmlEscape(process.argv[1]))
                .replace(/##LEVEL##/, type === 'stderr' ? 1 : 3) // stderr is Error, stdout is Information
                .replace(/##PID##/, process.pid)
                .replace(/##COMPUTERNAME##/, xmlEscape(process.env.COMPUTERNAME))
                .replace(/##PARTITIONKEY##/, getPartitionKey(now))
                .replace(/##ROWKEY##/, '' + now.getTime() + '-' + Math.floor(Math.random() * 999999999))
                .replace(/##MESSAGE##/, xmlEscape(buffer));

            var options = {
              hostname: azureAccountName + '.table.core.windows.net',
              port: azureEndpointProtocol === 'https' ? 443 : 80,
              path: '/' + azureTableName,
              method: 'POST',
              headers: {
                'x-ms-version': '2012-02-12',
                'x-ms-date': now.toUTCString(),
                'Content-Type': 'application/atom+xml',
                'Content-Length': Buffer.byteLength(payload, 'utf8'),
                'DataServiceVersion': '1.0;NetFx',
                'MaxDataServiceVersion': '2.0;NetFx'
              }
            };

            addSignature(options);

            var engine = azureEndpointProtocol === 'https' ? https : http;
            var req = engine.request(options, function(res) {
                if (res.statusCode == 404 && allowCreate) {
                    // lazily create the Azure Table if none exists, then retry logging
                    createTable(buffer, function (error) {
                        if (!error) {
                            logToTable(buffer, false);
                        }
                        else {
                            azureErrors++;
                        }
                    });
                }
                else if (res.statusCode == 201) {
                    azureErrors = 0;
                }
                else {
                    logLastResort(new Date().toString() + ': Error logging to the Azure Table Storage: HTTP status code: ' + res.statusCode);
                    azureErrors++;
                }
            });

            req.end(payload);
        }

        var createTableTemplate = (function () {/*
<?xml version="1.0" encoding="utf-8" standalone="yes"?>   
<entry xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices" 
       xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"
       xmlns="http://www.w3.org/2005/Atom"> 
    <title /> 
    <updated>##DATE##</updated> 
    <author>
      <name/> 
    </author> 
      <id/> 
      <content type="application/xml">
        <m:properties>
          <d:TableName>##NAME##</d:TableName>
        </m:properties>
      </content> 
</entry>
        ~*/}).toString().match(/[^\n]\n([^\~]*)/)[1];        

        function createTable(buffer, callback) {
            var now = new Date();
            var isoDate = getISO8061Date(now);
            var payload = createTableTemplate
                .replace(/##DATE##/, isoDate)
                .replace(/##NAME##/, azureTableName);

            var options = {
              hostname: azureAccountName + '.table.core.windows.net',
              port: azureEndpointProtocol === 'https' ? 443 : 80,
              path: '/Tables',
              method: 'POST',
              headers: {
                'x-ms-version': '2012-02-12',
                'x-ms-date': now.toUTCString(),
                'Content-Type': 'application/atom+xml',
                'Content-Length': Buffer.byteLength(payload, 'utf8'),
                'DataServiceVersion': '1.0;NetFx',
                'MaxDataServiceVersion': '2.0;NetFx'
              }
            };

            addSignature(options);

            var engine = azureEndpointProtocol === 'https' ? https : http;
            var req = engine.request(options, function(res) {
                if (res.statusCode !== 201) {
                    logLastResort(new Date().toString() + ': Error creating Azure Table to log to: HTTP status code: ' + res.statusCode);
                }

                // assume creation succeeded or table was concurrently created from another process
                callback(); 
            });

            req.on('error', callback);
            req.end(payload);
        }

        function addSignature(options) {
            // http://msdn.microsoft.com/en-us/library/windowsazure/dd179428.aspx

            var stringToSign = 
                options.method + '\n' +
                '\n' + // Content-MD5
                options.headers['Content-Type'] + '\n' +
                options.headers['x-ms-date'] + '\n' +
                '/' + azureAccountName + options.path;

            log(stringToSign);

            var hmac = crypto.createHmac('sha256', azureKey);
            hmac.update(stringToSign);
            var signature = hmac.digest('base64');
            options.headers['Authorization'] = 'SharedKey ' + azureAccountName + ':' + signature;
        }

        function xmlEscape(buffer) {
            var text;
            try {
                text = buffer.toString('utf8');
            }
            catch (e) {
                // unable to utf8 encode, use base64 encoding instead
                text = buffer.toString('base64');
            }

            return text
                .replace(/\"/g, '&quot;')
                .replace(/\'/g, '&apos;')
                .replace(/\</g, '&lt;')
                .replace(/\>/g, '&gt;')
                .replace(/\&/g, '&amp;');
        }

        function getPartitionKey(now) {
            var key = '' + now.getFullYear();
            if (now.getMonth() < 9) key += '0';
            key += (now.getMonth() + 1);
            if (now.getDate() < 10) key += '0';
            key += now.getDate();
            return key; 
        }

        function getISO8061Date(date) {
            var components = [
                date.getUTCFullYear(),
                '-',
                leftPadTwo(date.getUTCMonth() + 1),
                '-',
                leftPadTwo(date.getUTCDate()),
                'T',
                leftPadTwo(date.getUTCHours()),
                ':',
                leftPadTwo(date.getUTCMinutes()),
                ':',
                leftPadTwo(date.getUTCSeconds()),
                '.',
                leftPad(date.getUTCMilliseconds(), 3),
                'Z'
            ];

            return components.join('');
        }

        function leftPadTwo(n) {
            return (n < 10 ? '0' : '') + n;
        }

        function leftPad(n, millisecondsPading) {
            var currentN = '' + n;
            while (currentN.length < millisecondsPading) {
                currentN = '0' + currentN;
            }

            return currentN;
        }
    };

})();

// run the original application entry point

require(process.argv[1]);