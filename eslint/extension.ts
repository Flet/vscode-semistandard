/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as fs from 'fs';
import { workspace, window, commands, languages, Disposable, ExtensionContext, Command, Uri, StatusBarAlignment, TextEditor, TextDocumentSaveReason } from 'vscode';
import {
	LanguageClient, LanguageClientOptions, SettingMonitor, RequestType, TransportKind,
	TextDocumentIdentifier, TextEdit, NotificationType, ErrorHandler,
	ErrorAction, CloseAction, ResponseError, InitializeError, ErrorCodes, State as ClientState,
	Protocol2Code
} from 'vscode-languageclient';


interface NoESLintState {
	global?: boolean;
	workspaces?: { [key: string]: boolean };
}

interface AllFixesParams {
	textDocument: TextDocumentIdentifier;
}

interface AllFixesResult {
	documentVersion: number,
	edits: TextEdit[]
}

namespace AllFixesRequest {
	export const type: RequestType<AllFixesParams, AllFixesResult, void> = { get method() { return 'textDocument/eslint/allFixes'; } };
}

let noConfigShown: boolean = false;
interface NoConfigParams {
	message: string;
	document: TextDocumentIdentifier;
}

interface NoConfigResult {
}

namespace NoConfigRequest {
	export const type: RequestType<NoConfigParams, NoConfigResult, void> = { get method() { return 'eslint/noConfig'; } };
}

enum Status {
	ok = 1,
	warn = 2,
	error = 3
}

interface StatusParams {
	state: Status
}

namespace StatusNotification {
	export const type: NotificationType<StatusParams> = { get method() { return 'eslint/noConfig'; } };
}

const exitCalled: NotificationType<[number, string]> = { method: 'eslint/exitCalled' };

let willSaveTextDocument: Disposable;

export function activate(context: ExtensionContext) {

	let statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 0);
	let eslintStatus: Status = Status.ok;
	let serverRunning: boolean = false;

	statusBarItem.text = 'JavaScript Standard Style';
	statusBarItem.command = 'standard.showOutputChannel';

	function showStatusBarItem(show: boolean): void {
		if (show) {
			statusBarItem.show();
		} else {
			statusBarItem.hide();
		}
	}

	function updateStatus(status: Status) {
		switch (status) {
			case Status.ok:
				statusBarItem.color = undefined;
				break;
			case Status.warn:
				statusBarItem.color = 'yellow';
				break;
			case Status.error:
				statusBarItem.color = 'darkred';
				break;
		}
		eslintStatus = status;
		udpateStatusBarVisibility(window.activeTextEditor);
	}

	function udpateStatusBarVisibility(editor: TextEditor): void {
		statusBarItem.text = eslintStatus === Status.ok ? 'JavaScript Standard Style' : 'JavaScript Standard Style!';
		showStatusBarItem(
			serverRunning &&
			(
				eslintStatus !== Status.ok ||
				(editor && (editor.document.languageId === 'javascript' || editor.document.languageId === 'javascriptreact'))
			)
		);
	}

	window.onDidChangeActiveTextEditor(udpateStatusBarVisibility);
	udpateStatusBarVisibility(window.activeTextEditor);

	// We need to go one level up since an extension compile the js code into
	// the output folder.
	// serverModule
	let serverModule = path.join(__dirname, '..', 'server', 'server.js');
	let debugOptions = { execArgv: ["--nolazy", "--debug=6004"] };
	let serverOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions}
	};

	let defaultErrorHandler: ErrorHandler;
	let serverCalledProcessExit: boolean = false;
	let languages = ['javascript', 'javascriptreact']
	let languageIds = new Set<string>(languages);
	let clientOptions: LanguageClientOptions = {
		documentSelector: languages,
		diagnosticCollectionName: 'eslint',
		synchronize: {
			configurationSection: 'standard',
			fileEvents: [
				workspace.createFileSystemWatcher('**/package.json')
			],
			textDocumentFilter: (textDocument) => {
				let fsPath = textDocument.fileName;
				if (fsPath) {
					let basename = path.basename(fsPath);
					return /^package.json$/.test(basename);
				}
			}
		},
		initializationOptions: () => {
			let configuration = workspace.getConfiguration('standard');
			return {
				legacyModuleResolve: configuration ? configuration.get('_legacyModuleResolve', false) : false,
				nodePath: configuration ? configuration.get('nodePath', undefined) : undefined
			};
		},
		initializationFailedHandler: (error) => {
			if (error instanceof ResponseError) {
				let responseError = (error as ResponseError<InitializeError>);
				if (responseError.code === 100) {
					const key = 'noStandardMessageShown';
					let state = context.globalState.get<NoESLintState>(key, {});
					if (workspace.rootPath) {
						client.info([
							'Failed to load the standard library.',
							'To use standard in this workspace please install standard using \'npm install standard\' or globally using \'npm install -g standard\'.',
							'You need to reopen the workspace after installing standard.',
						].join('\n'));
						if (!state.workspaces) {
							state.workspaces = Object.create(null);
						}
						if (!state.workspaces[workspace.rootPath]) {
							state.workspaces[workspace.rootPath] = true;
							client.outputChannel.show(true);
							context.globalState.update(key, state);
						}
					} else {
						client.info([
							'Failed to load the standard library.',
							'To use standard for single JavaScript files install standard globally using \'npm install -g standard\'.',
							'You need to reopen VS Code after installing standard.',
						].join('\n'));
						if (!state.global) {
							state.global = true;
							client.outputChannel.show(true);
							context.globalState.update(key, state);
						}
					}
				} else {
					client.error('Server initialization failed.', error);
					client.outputChannel.show(true);
				}
			} else {
				client.error('Server initialization failed.', error);
				client.outputChannel.show(true);
			}
			return false;
		},
		errorHandler: {
			error: (error, message, count): ErrorAction => {
				return defaultErrorHandler.error(error, message, count);
			},
			closed: (): CloseAction => {
				if (serverCalledProcessExit) {
					return CloseAction.DoNotRestart;
				}
				return defaultErrorHandler.closed();
			}
		}
	};

	let client = new LanguageClient('standard', serverOptions, clientOptions);
	const running = 'JavaScript Standard Style server is running.';
	const stopped = 'JavaScript Standard Style server stopped.'
	client.onDidChangeState((event) => {
		if (event.newState === ClientState.Running) {
			client.info(running);
			statusBarItem.tooltip = running;
			serverRunning = true;
		} else {
			client.info(stopped);
			statusBarItem.tooltip = stopped;
			serverRunning = false;
		}
		udpateStatusBarVisibility(window.activeTextEditor);
	});

	client.onNotification(StatusNotification.type, (params) => {
		updateStatus(params.state);
	});

	defaultErrorHandler = client.createDefaultErrorHandler();
	client.onNotification(exitCalled, (params) => {
		serverCalledProcessExit = true;
		client.error(`Server process exited with code ${params[0]}. This usually indicates a misconfigured standard setup.`, params[1]);
		window.showErrorMessage(`JavaScript Standard Style server shut down itself. See 'JavaScript Standard Style' output channel for details.`);
	});

	function applyTextEdits(uri: string, documentVersion: number, edits: TextEdit[]) {
		let textEditor = window.activeTextEditor;
		if (textEditor && textEditor.document.uri.toString() === uri) {
			if (textEditor.document.version !== documentVersion) {
				window.showInformationMessage(`JavaScript Standard Style fixes are outdated and can't be applied to the document.`);
			}
			textEditor.edit(mutator => {
				for(let edit of edits) {
					mutator.replace(Protocol2Code.asRange(edit.range), edit.newText);
				}
			}).then((success) => {
				if (!success) {
					window.showErrorMessage('Failed to apply JavaScript Standard Style fixes to the document. Please consider opening an issue with steps to reproduce.');
				}
			});
		}
	}

	function runAutoFix() {
		let textEditor = window.activeTextEditor;
		if (!textEditor) {
			return;
		}
		let uri: string = textEditor.document.uri.toString();
		client.sendRequest(AllFixesRequest.type, { textDocument: { uri }}).then((result) => {
			if (result) {
				applyTextEdits(uri, result.documentVersion, result.edits);
			}
		}, (error) => {
			window.showErrorMessage('Failed to apply JavaScript Standard Style fixes to the document. Please consider opening an issue with steps to reproduce.');
		});
	}


	function configurationChanged() {
		let config = workspace.getConfiguration('standard');
		let autoFix = config.get('autoFixOnSave', false);
		if (autoFix && !willSaveTextDocument) {
			willSaveTextDocument = workspace.onWillSaveTextDocument((event) => {
				let document = event.document;
				if (!languageIds.has(document.languageId) || event.reason === TextDocumentSaveReason.AfterDelay) {
					return;
				}
				const version = document.version;
				event.waitUntil(
					client.sendRequest(AllFixesRequest.type, { textDocument: { uri: document.uri.toString() }}).then((result) => {
						if (result && version === result.documentVersion) {
							return Protocol2Code.asTextEdits(result.edits);
						} else {
							return [];
						}
					})
				);
			});
		} else if (!autoFix && willSaveTextDocument) {
			willSaveTextDocument.dispose();
			willSaveTextDocument = undefined;
		}
	}

	workspace.onDidChangeConfiguration(configurationChanged);
	configurationChanged();

	context.subscriptions.push(
		new SettingMonitor(client, 'standard.enable').start(),
		commands.registerCommand('standard.applySingleFix', applyTextEdits),
		commands.registerCommand('standard.applySameFixes', applyTextEdits),
		commands.registerCommand('standard.applyAllFixes', applyTextEdits),
		commands.registerCommand('standard.executeAutofix', runAutoFix),
		commands.registerCommand('standard.showOutputChannel', () => { client.outputChannel.show(); }),
		statusBarItem
	);
}

export function deactivate() {
	if (willSaveTextDocument) {
		willSaveTextDocument.dispose();
		willSaveTextDocument = undefined;
	}
}