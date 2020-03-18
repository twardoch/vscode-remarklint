// Requires
const vscode = require("vscode");
const remark = require("remark");
const unifiedEngine = require("unified-engine");
const extensions = require('markdown-extensions')
const vfile = require("vfile");
const prettyHrtime = require("pretty-hrtime");
const npm_module_path = require("npm-module-path");

const fs = require("fs");
const path = require("path");

// Optional requires are inlined to avoid startup cost


// Constants
const extensionDisplayName = "remarklint";
const configFileGlob = ".remarkrc{.json,.yaml,.yml}";
const configFileNames = [
    ".remarkrc.json",
    ".remarkrc.yaml",
    ".remarkrc.yml",
    ".remarkrc"
];
const markdownLanguageId = "markdown";
const markdownSchemeFile = "file";
const markdownSchemeUntitled = "untitled";
const documentSelectors = [{
        language: markdownLanguageId,
        scheme: markdownSchemeFile
    },
    {
        language: markdownLanguageId,
        scheme: markdownSchemeUntitled
    }
];


const configParsers = [
    content => JSON.parse(require("jsonc-parser").stripComments(content)),
    content => require("js-yaml").safeLoad(content)
];

const clickForInfo = "Click for more information about ";
const clickToFix = "Click to fix this violation of ";
const fixAllCommandTitle = `${extensionDisplayName}: Fix all`;
const fixAllCommandName = "remarklint.fixAll";
const clickForConfigureInfo = `Click for details about configuring ${extensionDisplayName} rules`;
const clickForConfigureUrl =
    "https://github.com/twardoch/vscode-remarklint#configure";
const clickForConfigSource = `Click to open this document's ${extensionDisplayName} configuration`;
const openGlobalSettingsCommand = "workbench.action.openGlobalSettings";
const openWorkspaceSettingsCommand = "workbench.action.openWorkspaceSettings";
const openFolderSettingsCommand = "workbench.action.openFolderSettings";
const openCommand = "vscode.open";
const throttleDuration = 500;
const customRuleExtensionPrefixRe = /^\{([^}]+)\}\/(.*)$/iu;

// Variables
const ruleNameToInformation = {};
let outputChannel = null;
let diagnosticCollection = null;
let configMap = {};
let runMap = {};
let customRules = null;
let ignores = null;
const throttle = {
    document: null,
    timeout: null
};

// Writes date and message to the output channel
function outputLine(message, show) {
    const datePrefix = "[" + new Date().toLocaleTimeString() + "] ";
    outputChannel.appendLine(datePrefix + message);
    if (show) {
        outputChannel.show();
    }
}

// Returns rule configuration from nearest config file or workspace
function parseConfiguration(name, content, parsers) {
    let config = null;
    let message = "";
    const errors = [];
    // Try each parser
    (parsers || [JSON.parse]).every((parser) => {
        try {
            config = parser(content);
        } catch (ex) {
            errors.push(ex.message);
        }
        return !config;
    });
    // Message if unable to parse
    if (!config) {
        errors.unshift(`Unable to parse '${name}'`);
        message = errors.join("; ");
    }
    return {
        config,
        message
    };
}

// Read specified configuration file.
function readConfig(file, parsers, callback) {
    if (!callback) {
        // @ts-ignore
        callback = parsers;
        parsers = null;
    }
    // Read file
    fs.readFile(file, 'utf8', (err, content) => {
        if (err) {
            return callback(err);
        }
        // Try to parse file
        // @ts-ignore
        const { config, message } = parseConfiguration(file, content, parsers);
        if (!config) {
            return callback(new Error(message));
        }
        // Extend configuration
        const configExtends = config.extends;
        if (configExtends) {
            delete config.extends;
            const extendsFile = path.resolve(path.dirname(file), configExtends);
            return readConfig(extendsFile, parsers, (errr, extendsConfig) => {
                if (errr) {
                    return callback(errr);
                }
                return callback(null, {
                    ...extendsConfig,
                    ...config
                });
            });
        }
        return callback(null, config);
    });
}

// Read specified configuration file synchronously.

function readConfigSync(file, parsers) {
    // Read file
    const content = fs.readFileSync(file, 'utf8');
    // Try to parse file
    const { config, message } = parseConfiguration(file, content, parsers);
    if (!config) {
        throw new Error(message);
    }
    // Extend configuration
    const configExtends = config.extends;
    if (configExtends) {
        delete config.extends;
        return {
            ...readConfigSync(
                path.resolve(path.dirname(file), configExtends),
                parsers
            ),
            ...config
        };
    }
    return config;
}

function getConfig(document) {
    const name = document.fileName;
    let dir = path.dirname(name);
    let workspaceDetail = "not in a workspace folder";

    // While inside the workspace
    while (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dir))) {
        workspaceDetail = "no configuration file in workspace folder";
        // Use cached configuration if present for directory
        if (configMap[dir]) {
            return configMap[dir];
        }
        if (configMap[dir] === undefined) {
            // Look for config file in current directory
            for (const configFileName of configFileNames) {
                const configFilePath = path.join(dir, configFileName);
                if (fs.existsSync(configFilePath)) {
                    outputLine(
                        'INFO: Loading custom configuration from "' +
                        configFilePath +
                        '", overrides user/workspace/custom configuration for directory and its children.'
                    );
                    try {
                        return (configMap[dir] = {
                            config: readConfigSync(configFilePath, configParsers),
                            source: configFilePath
                        });
                    } catch (ex) {
                        outputLine(
                            'ERROR: Unable to read configuration file "' +
                            configFilePath +
                            '" (' +
                            (ex.message || ex.toString()) +
                            ").",
                            true
                        );
                    }
                }
            }
            // Remember missing or invalid file
            configMap[dir] = null;
        }
        const parent = path.dirname(dir);
        // Move to parent directory, stop if no parent
        if (dir === parent) {
            break;
        }
        dir = parent;
    }

    // Use cached configuration if present for file
    if (configMap[name]) {
        return configMap[name];
    }

    // Use user/workspace configuration
    outputLine(
        'INFO: Loading user/workspace configuration for "' +
        name +
        '" (' +
        workspaceDetail +
        ")."
    );
    const configuration = vscode.workspace.getConfiguration(
        extensionDisplayName,
        document.uri
    );
    const sectionConfig = "config";
    let userWorkspaceConfig = configuration.get(sectionConfig);
    const userWorkspaceConfigMetadata = configuration.inspect(sectionConfig);
    let source = null;
    if (
        userWorkspaceConfigMetadata.workspaceFolderValue &&
        vscode.workspace.workspaceFolders.length > 1
    ) {
        // Length check to work around https://github.com/Microsoft/vscode/issues/34386
        source = openFolderSettingsCommand;
    } else if (userWorkspaceConfigMetadata.workspaceValue) {
        source = openWorkspaceSettingsCommand;
    } else if (userWorkspaceConfigMetadata.globalValue) {
        source = openGlobalSettingsCommand;
    }

    // Bootstrap extend behavior into readConfigSync
    if (userWorkspaceConfig && userWorkspaceConfig.extends) {
        const extendPath = path.resolve(
            require("os").homedir(),
            userWorkspaceConfig.extends
        );
        try {
            const extendConfig = readConfigSync(extendPath, configParsers);
            userWorkspaceConfig = {
                ...extendConfig,
                ...userWorkspaceConfig
            };
        } catch (ex) {
            outputLine(
                'ERROR: Unable to extend configuration file "' +
                extendPath +
                '" (' +
                (ex.message || ex.toString()) +
                ").",
                true
            );
        }
    }
    return (configMap[name] = {
        config: userWorkspaceConfig,
        source
    });
}

// Returns ignore configuration for user/workspace
function getIgnores() {
    if (!Array.isArray(ignores)) {
        ignores = [];
        const configuration = vscode.workspace.getConfiguration(
            extensionDisplayName
        );
        const ignorePaths = configuration.get("ignore");
        ignorePaths.forEach(ignorePath => {
            const ignore = require("minimatch").makeRe(ignorePath, {
                dot: true,
                nocomment: true
            });
            if (ignore) {
                ignores.push(ignore);
            }
        });
    }
    return ignores;
}

// Clears the ignore list
function clearIgnores() {
    ignores = null;
}


// Returns if the document is Markdown
function isMarkdownDocument(document) {
    return (
        document.languageId === markdownLanguageId &&
        (document.uri.scheme === markdownSchemeFile ||
            document.uri.scheme === markdownSchemeUntitled)
    );
}

function debug(o) {
    console.log(JSON.stringify(o));
}

// Lints a Markdown document
function lint(document) {
    if (!isMarkdownDocument(document)) {
        return;
    }
    // Check ignore list
    const diagnostics = [];
    const relativePath = vscode.workspace.asRelativePath(document.uri, false);
    const normalizedPath = relativePath.split(path.sep).join("/");
    if (getIgnores().every(ignore => !ignore.test(normalizedPath))) {
        // Lint
        const name = document.uri.toString();
        const text = document.getText();
        const { config, source } = getConfig(document);
        debug('lint');
        //debug(source);
        //debug(config);
        remarklintWrapper(name, text, config).forEach(result => {
            // Create Diagnostics
            const ruleName = result.ruleNames[0];
            const ruleDescription = result.ruleDescription;
            ruleNameToInformation[ruleName] = result.ruleInformation;
            let message = result.ruleNames.join("/") + ": " + ruleDescription;
            if (result.errorDetail) {
                message += " [" + result.errorDetail + "]";
            }
            let range = document.lineAt(result.lineNumber - 1).range;
            if (result.errorRange) {
                const start = result.errorRange[0] - 1;
                const end = start + result.errorRange[1];
                range = range.with(
                    range.start.with(undefined, start),
                    range.end.with(undefined, end)
                );
            }
            const diagnostic = new vscode.Diagnostic(
                range,
                message,
                vscode.DiagnosticSeverity.Warning
            );
            diagnostic.code = ruleName;
            diagnostic.source = extensionDisplayName;
            // @ts-ignore
            diagnostic.configSource = source;
            // @ts-ignore
            diagnostic.fixInfo = result.fixInfo;
            diagnostics.push(diagnostic);
        });
    }
    // Publish
    diagnosticCollection.set(document.uri, diagnostics);
}

// Wraps getting options and calling into remarklint
function remarklintWrapper(name, text, config) {
    return runRemark(name, text, config);
    /*    const options = {
            strings: {
                [name]: text
            },
            config,
            customRules: null,
            handleRuleFailures: true,
            resultVersion: 3
        };
        let results = [];
        try {
            results = null; //remarklint.sync(options)[name];
        } catch (ex) {
            outputLine("ERROR: Exception while linting:\n" + ex.stack, true);
        }
        return results; */
}

function getPlugins(list) {
    const root = vscode.workspace.rootPath || '';
    const pluginList = list.map((name) => {
        if (typeof name === 'string') {
            return 'remark-' + name;
        }
        return 'remark-' + name[0];
    });
    result = npm_module_path.resolveMany(pluginList, root).then((filepaths) => {
        return filepaths.map((filepath, index) => ({
            name: list[index],
            package: filepath !== undefined ? require(filepath) : undefined,
            settings: typeof list[index] !== 'string' ? list[index][1] : undefined
        }));
    });
    debug("PL4");
    debug(result);
    return result;
}

function runRemark(name, text, config) {
    //debug(config.plugins);

    return new Promise((resolve, reject) => {
        let api = remark();
        const errors = [];
        const remarkSettings = config;
        let plugins = (Array.isArray(remarkSettings.plugins)) ? remarkSettings.plugins : Object.keys(remarkSettings.plugins);
        //debug(plugins);
        if (plugins.length !== 0) {
            plugins = getPlugins(plugins);
            debug("PL3");
            debug(plugins);
        }
        api = api.use({ settings: remarkSettings.settings });
        if (plugins.length !== 0) {
            plugins.forEach((plugin) => {
                if (plugin.package === undefined) {
                    errors.push({
                        name: plugin.name,
                        err: 'Package not found'
                    });
                    return;
                }
                try {
                    var settings = plugin.settings !== undefined ?
                        plugin.settings : remarkSettings[plugin.name];
                    if (settings == undefined) {
                        settings = remarkSettings.plugins[plugin.name];
                    }
                    if (settings !== undefined) {
                        api = api.use(plugin.package, settings);
                    } else {
                        api = api.use(plugin.package);
                    }
                } catch (err) {
                    errors.push({
                        name: plugin.name,
                        err
                    });
                }
            });
        }
        if (errors.length !== 0) {
            let message = '';
            errors.forEach((error) => {
                if (error.err === 'Package not found') {
                    message += `[${error.name}]: ${error.err.toString()}. Use **npm i remark-${error.name}** or **npm i -g remark-${error.name}**.\n`;
                    return;
                }
                message += `[${error.name}]: ${error.err.toString()}\n`;
            });
            return Promise.reject(message);
        }
        return api.process(text).then((result) => {
            if (result.messages.length !== 0) {
                let message = '';
                result.messages.forEach((msg) => {
                    message += msg.toString() + '\n';
                });
                return Promise.reject(message);
            }
            return Promise.resolve({
                content: result.contents
            });
        });
    });
}





// Implements CodeActionsProvider.provideCodeActions to provide information and fix rule violations
function provideCodeActions(document, range, codeActionContext) {
    const codeActions = [];
    const diagnostics = codeActionContext.diagnostics || [];
    const fixInfoDiagnostics = [];
    let showConfigureInfo = false;
    let configSource = null;
    diagnostics
        .filter((diagnostic) => diagnostic.source === extensionDisplayName)
        .forEach((diagnostic) => {
            const ruleName = diagnostic.code;
            const ruleNameAlias = diagnostic.message.split(":")[0];
            // Provide code action to fix the violation
            if (diagnostic.fixInfo) {
                fixInfoDiagnostics.push(diagnostic);
            }
            // Provide code action for information about the violation
            const ruleInformation = ruleNameToInformation[ruleName];
            if (ruleInformation) {
                const infoTitle = clickForInfo + ruleNameAlias;
                const infoAction = new vscode.CodeAction(infoTitle, vscode.CodeActionKind.QuickFix);
                infoAction.command = {
                    "title": infoTitle,
                    "command": openCommand,
                    "arguments": [vscode.Uri.parse(ruleInformation)]
                };
                infoAction.diagnostics = [diagnostic];
                codeActions.push(infoAction);
            }
            showConfigureInfo = true;
            configSource = configSource || diagnostic.configSource;
        });
    if (fixInfoDiagnostics.length) {
        // Register a "fix all" code action
        const sourceFixAllAction = new vscode.CodeAction(
            fixAllCommandTitle,
            vscode.CodeActionKind.SourceFixAll.append(extensionDisplayName)
        );
        sourceFixAllAction.command = {
            "title": fixAllCommandTitle,
            "command": fixAllCommandName
        };
        sourceFixAllAction.diagnostics = fixInfoDiagnostics;
        codeActions.push(sourceFixAllAction);
    }
    // Open the source for the document's rule configuration
    if (configSource) {
        const configSourceIsSettings =
            configSource === openGlobalSettingsCommand ||
            configSource === openWorkspaceSettingsCommand ||
            configSource === openFolderSettingsCommand;
        const infoAction = new vscode.CodeAction(
            clickForConfigSource,
            vscode.CodeActionKind.QuickFix
        );
        infoAction.command = {
            title: clickForConfigSource,
            command: configSourceIsSettings ? configSource : openCommand,
            arguments: configSourceIsSettings ? null : [vscode.Uri.file(configSource)]
        };
        codeActions.push(infoAction);
    }
    // Add information about configuring rules
    if (showConfigureInfo) {
        const configureInfoAction = new vscode.CodeAction(
            clickForConfigureInfo,
            vscode.CodeActionKind.QuickFix
        );
        configureInfoAction.command = {
            title: clickForConfigureInfo,
            command: openCommand,
            arguments: [vscode.Uri.parse(clickForConfigureUrl)]
        };
        codeActions.push(configureInfoAction);
    }
    return codeActions;
}

// Fixes all violations in the active document
function fixAll() {
    return new Promise((resolve, reject) => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const document = editor.document;
            if (isMarkdownDocument(document)) {
                const name = document.uri.toString();
                const text = document.getText();
                const { config } = getConfig(document);
                const errors = remarklintWrapper(name, text, config);
                //debug(errors);
                const fixedText = remarklintRuleHelpers.applyFixes(text, errors);
                if (text !== fixedText) {
                    return editor
                        .edit(editBuilder => {
                            const start = document.lineAt(0).range.start;
                            const end = document.lineAt(document.lineCount - 1).range.end;
                            editBuilder.replace(new vscode.Range(start, end), fixedText);
                        })
                        .then(resolve, reject);
                }
            }
        }
        return resolve();
    });
}

// Cleanly (i.e., from scratch) lint all visible files
function cleanLintVisibleFiles() {
    diagnosticCollection.clear();
    didChangeVisibleTextEditors(vscode.window.visibleTextEditors);
}

// Clears the map of custom configuration files and re-lints files
function clearConfigMap(eventUri) {
    outputLine(
        'INFO: Resetting configuration cache due to "' +
        configFileGlob +
        '" or setting change.'
    );
    configMap = {};
    if (eventUri) {
        cleanLintVisibleFiles();
    }
}

// Returns the run setting for the document
function getRun(document) {
    const name = document.fileName;
    // Use cached configuration if present for file
    if (runMap[name]) {
        return runMap[name];
    }
    // Read workspace configuration
    const configuration = vscode.workspace.getConfiguration(
        extensionDisplayName,
        document.uri
    );
    runMap[name] = configuration.get("run");
    outputLine(
        'INFO: Linting for "' +
        document.fileName +
        '" will be run "' +
        runMap[name] +
        '".'
    );
    return runMap[name];
}

// Clears the map of run settings
function clearRunMap() {
    runMap = {};
}

// Suppresses a pending lint for the specified document
function suppressLint(document) {
    if (throttle.timeout && document === throttle.document) {
        clearTimeout(throttle.timeout);
        throttle.document = null;
        throttle.timeout = null;
    }
}

// Requests a lint of the specified document
function requestLint(document) {
    suppressLint(document);
    throttle.document = document;
    throttle.timeout = setTimeout(() => {
        // Do not use throttle.document in this function; it may have changed
        lint(document);
        suppressLint(document);
    }, throttleDuration);
}

// Handles the onDidChangeVisibleTextEditors event
function didChangeVisibleTextEditors(textEditors) {
    textEditors.forEach(textEditor => lint(textEditor.document));
}

// Handles the onDidChangeTextDocument event
function didChangeTextDocument(change) {
    const document = change.document;
    if (
        document.languageId === markdownLanguageId &&
        getRun(document) === "onType"
    ) {
        requestLint(document);
    }
}

// Handles the onDidSaveTextDocument event
function didSaveTextDocument(document) {
    if (
        document.languageId === markdownLanguageId &&
        getRun(document) === "onSave"
    ) {
        lint(document);
        suppressLint(document);
    }
}

// Handles the onDidCloseTextDocument event
function didCloseTextDocument(document) {
    suppressLint(document);
    diagnosticCollection.delete(document.uri);
}

// Handles the onDidChangeConfiguration event
function didChangeConfiguration() {
    clearConfigMap();
    clearRunMap();
    clearIgnores();
    cleanLintVisibleFiles();
}

function activate(context) {
    // Create OutputChannel
    outputChannel = vscode.window.createOutputChannel(extensionDisplayName);
    context.subscriptions.push(outputChannel);

    // Hook up to workspace events
    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors(didChangeVisibleTextEditors),
        vscode.workspace.onDidChangeTextDocument(didChangeTextDocument),
        vscode.workspace.onDidSaveTextDocument(didSaveTextDocument),
        vscode.workspace.onDidCloseTextDocument(didCloseTextDocument),
        vscode.workspace.onDidChangeConfiguration(didChangeConfiguration)
    );

    // Register CodeActionsProvider
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(documentSelectors, {
            provideCodeActions
        })
    );

    // Register Commands
    context.subscriptions.push(
        vscode.commands.registerCommand(fixAllCommandName, fixAll)
    );

    // Create DiagnosticCollection
    diagnosticCollection = vscode.languages.createDiagnosticCollection(
        extensionDisplayName
    );
    context.subscriptions.push(diagnosticCollection);

    // Hook up to file system changes for custom config file(s) ("/" vs. "\" due to bug in VS Code glob)
    const fileSystemWatcher = vscode.workspace.createFileSystemWatcher(
        "**/" + configFileGlob
    );
    context.subscriptions.push(
        fileSystemWatcher,
        fileSystemWatcher.onDidCreate(clearConfigMap),
        fileSystemWatcher.onDidChange(clearConfigMap),
        fileSystemWatcher.onDidDelete(clearConfigMap)
    );

    // Cancel any pending operations during deactivation
    context.subscriptions.push({
        dispose: () => suppressLint(throttle.document)
    });

    // Request (deferred) lint of active document
    if (vscode.window.activeTextEditor) {
        requestLint(vscode.window.activeTextEditor.document);
    }
}

exports.activate = activate;