waws-interceptor
====

This is a custom interceptor.js file for [iisnode](https://github.com/tjanczuk/iisnode) which enables capturing stdout and stderr of the node.exe process to files on disk or Azure Table Storage. 

**Getting started**

Create a Windows Azure Web site and deploy the content of this repository as a node.js application. 

Then go to the portal, open the configuration page of your web site, and specify the following:

- in the app settings section, add a setting with `DIAGNOSTICS_LOGGINGSETTINGSFILE` name and `settings.json` value,  
- in the connection strings section, a connection string with `CLOUD_STORAGE_ACCOUNT` name and value in the following format: `DefaultEndpointsProtocol=https;AccountName=<yourAzureTableStorageAccountName>;AccountKey=<yourAzureTableStorageAccountKey>`. Substitute appropriate credentials for `<yourAzureTableStorageAccountName>` and `<yourAzureTableStorageAccountKey>`. 

Navigate to your web site. The request handler in the [server.js](https://github.com/tjanczuk/waws-interceptor/blob/master/server.js) does custom logging which should now be recorded in the file system as well as in the Azure Table Storage. You can inspect the file system using the FTP URL to the logs provided on the portal page of your web site. You can inspect the Azure Table Storage content using [Azure Storage Explorer](http://azurestorageexplorer.codeplex.com/). 

**Configuration**

The custom interceptor must be registered using the iisnode.yml file:

```
interceptor: src\interceptor.js
```

(This step will not be required once the new interceptor is part of WAWS image).

There are several aspects of the interceptor which are controlled using environment variables, which can be set using the app settings section of the Windows Azure Web Sites portal or the Azure CLI. Here is the list of setting:

- `DIAGNOSTICS_AZUREDRIVEENABLED` (false) - is logging to the file system enabled  
- `DIAGNOSTICS_AZUREDRIVEMAXLOGFILESIZEBYTES` (128KB) - maximum size of a single log file before a new one is created
- `DIAGNOSTICS_AZUREDRIVEMAXLOGFOLDERSIZEBYTES` (1MB) - maximum size of all log files combined before old ones are removed
- `IISNODE_MAXLOGFILES` (20) - maximum number of log files before old ones are removed
- `DIAGNOSTICS_AZURETABLEENABLED` (false) - is logging to Azure Table Storage enabled
- `DIAGNOSTICS_MAXAZURETABLEERRORS` (10) - maximum number of consecutive errors when calling Azure Table Storage REST APIs before Azure Table Storage logging is disabled for the lifetime of the node.exe process
- `DIAGNOSTICS_LOGGINGTABLENAME` ('WAWSAppLogTable') - Azure Table Storage table name to log to
- `DIAGNOSTICS_LOGGINGSETTINGSFILE` ('..\diagnostics\settings.json') - location of the settings.json file relative to wwwroot
- `DIAGNOSTICS_SETTINGS_POLL_INTERVA` (5000) - interval in milliseconds at which the settings.json file is checked for changes
- `DIAGNOSTICS_AZUREDRIVELOGDIRECTORY` ('..\..\LogFiles\Application') - location of lof file directory relative to wwwroot
- `IISNODE_LOGDIRECTORY` ('iisnode') - legacy location of log files (relative to wwwroot).
- `IISNODE_LASTRESORTLOGFILE` ('iisnode-error.txt') - name of the 'last resort' log file relative to `IISNODE_LOGDIRECTORY`; this is where iisnode will save informaiton about errors in the logging infrastructure itself, on a best effort basis
- `IISNODE_LOGDIAGNOSTICSETTINGS` (not set by default) - if set, iisnode interceptor.js will log the effective diagnostics settings to the `IISNODE_LASTRESORTLOGFILE` on startup of the node.exe process; note the effective settings may change in the lifetime of the node.exe process as a result of modifications to the `DIAGNOSTICS_LOGGINGSETTINGSFILE` file

In addition, when Azure Table Storage logging is enabled, the following connection string must be specified:

- `CLOUD_STORAGE_ACCOUNT`  - the Azure table storage connection string; if misconfigured or missing, Azure table logging is disabled regardless of other settings; the format of the string is provided in the Getting Started section above 
