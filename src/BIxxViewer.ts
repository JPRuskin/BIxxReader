import * as vscode from 'vscode';
import { Disposable, disposeAll } from './dispose';
import * as zipHandler from './zipHandler';

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

interface BiExportDocumentDelegate {
	getFileData(): Promise<string>;
}

class BiExportDocument extends Disposable implements vscode.CustomDocument {
	// Constructor
	static async create(
		uri: vscode.Uri,
		backupId: string | undefined,
		delegate: BiExportDocumentDelegate,
	): Promise<BiExportDocument | PromiseLike<BiExportDocument>> {
		const dataFile = typeof backupId === 'string' ? vscode.Uri.parse(backupId) : uri;
		const fileData = await BiExportDocument.readFile(dataFile);
		return new BiExportDocument(uri, fileData, delegate);
	}

	private static async readFile(uri: vscode.Uri) : Promise<string> {
		return zipHandler.contentFromFile(uri);
	}

	private readonly _uri: vscode.Uri;
	private _documentData: string;
	private readonly _delegate: BiExportDocumentDelegate;

	private constructor(
		uri: vscode.Uri,
		initialContent: string,
		delegate: BiExportDocumentDelegate,
	) {
		super();
		this._uri = uri;
		this._documentData = initialContent;
		this._delegate = delegate;
	}

	public get uri() { return this._uri; }

	public get documentData(): string { return this._documentData; }

	// Fired when the document is disposed of
	private readonly _onDidDispose = this._register(new vscode.EventEmitter<void>());
	public readonly onDidDispose = this._onDidDispose.event;

	// Fired to notify webviews that the document has been changed
	private readonly _onDidChangeDocument = this._register(new vscode.EventEmitter<{
		readonly content?: string;
	}>());
	public readonly onDidChangeContent = this._onDidChangeDocument.event;

	// Fired to tell VSCode that an edit has occurred in the document - also updates dirty indicator
	private readonly _onDidChange = this._register(new vscode.EventEmitter<{
		readonly label: string,
		undo(): void,
		redo(): void,
	}>());
	public readonly onDidChange = this._onDidChange.event;

	// Called when no more references to the document exist
	dispose(): void {
		this._onDidDispose.fire();
		super.dispose();
	}

	async save(cancellation: vscode.CancellationToken): Promise<void> {
		await this.saveAs(this.uri, cancellation);
	}

	async saveAs(targetResource: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
		const fileData = await this._delegate.getFileData();
		if (cancellation.isCancellationRequested) {
			return;
		}
		await zipHandler.updateFileContent(targetResource, fileData);
	}

	async revert(_cancellation: vscode.CancellationToken): Promise<void> {
		const diskContent = await BiExportDocument.readFile(this.uri);
		this._documentData = diskContent;
		this._onDidChangeDocument.fire({
			content: diskContent
		});
	}

	async backup(destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
		await this.saveAs(destination, cancellation);

		return {
			id: destination.toString(),
			delete: async () => {
				try {
					await vscode.workspace.fs.delete(destination);
				} catch {
					// Nothing to do
				}
			}
		};
	}
}

export class BiEditorProvider implements vscode.CustomEditorProvider<BiExportDocument> {
	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			BiEditorProvider.viewType,
			new BiEditorProvider(context),
			{
				webviewOptions: {
					// Though this is advised against, losing where you are in a 20k line JSON document is rough
					retainContextWhenHidden: true,
					// We enable the find widget to allow you to navigate said gigantic document
					enableFindWidget: true,
				},
				supportsMultipleEditorsPerDocument: false,  
			}
		);
	}

	private static readonly viewType = "bixxreader";

	private readonly webviews = new WebviewCollection();

	constructor(
		private readonly _context: vscode.ExtensionContext
	) { }

	async openCustomDocument(
		uri: vscode.Uri,
		openContext: { backupId?: string },
		_token: vscode.CancellationToken
	): Promise<BiExportDocument> {
		const document: BiExportDocument = await BiExportDocument.create(uri, openContext.backupId, {
			getFileData: async () => {
				const webviewsForDocument = Array.from(this.webviews.get(document.uri));
				if (!webviewsForDocument.length) {
					throw new Error('Could not find webview to save for');
				}
				const panel = webviewsForDocument[0];
				const response = await this.postMessageWithResponse<number[]>(panel, 'getFileData', {});
				return response.toString();
			}
		});

		const listeners: vscode.Disposable[] = [];

		listeners.push(document.onDidChange(e => {
			this._onDidChangeCustomDocument.fire({
				document,
				...e,
			});
		}));

		listeners.push(document.onDidChangeContent(e => {
			for (const webviewPanel of this.webviews.get(document.uri)) {
				this.postMessage(webviewPanel, 'update', {
					content: e.content,
				});
			}
		}));

		document.onDidDispose(() => disposeAll(listeners));

		return document;
	}

	async resolveCustomEditor(
		document: BiExportDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		this.webviews.add(document.uri, webviewPanel);

		webviewPanel.webview.options = {
			enableScripts: true,
		};
		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document.documentData);

		webviewPanel.webview.onDidReceiveMessage(e => this.onMessage(document, e));

		webviewPanel.webview.onDidReceiveMessage(e => {
			if (e.type === 'ready') {
				if (document.uri.scheme === 'untitled') {
					this.postMessage(webviewPanel, 'init', {
						untitled: true,
						editable: true,
					});
				} else {
					const editable = vscode.workspace.fs.isWritableFileSystem(document.uri.scheme);

					this.postMessage(webviewPanel, 'init', {
						value: document.documentData,
						editable,
					});
				}
			}
		});
	}

	private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<BiExportDocument>>();
	public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

	public saveCustomDocument(document: BiExportDocument, cancellation: vscode.CancellationToken): Thenable<void> {
		return document.save(cancellation);
	}

	public saveCustomDocumentAs(document: BiExportDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Thenable<void> {
		return document.saveAs(destination, cancellation);
	}

	public revertCustomDocument(document: BiExportDocument, cancellation: vscode.CancellationToken): Thenable<void> {
		return document.revert(cancellation);
	}

	public backupCustomDocument(document: BiExportDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Thenable<vscode.CustomDocumentBackup> {
		return document.backup(context.destination, cancellation);
	}

	private getHtmlForWebview(webview: vscode.Webview, content: string): string {
		const jsonObject = JSON.parse(content);
		const title = this.coalesce(jsonObject.ReportDefinition?.Name, jsonObject.DashboardDefinition?.Name, jsonObject.name);
		const table = this.getHtmlTableForExport(jsonObject);
		const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'BIxxViewer.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'BIxxViewer.js'));
		// Use a nonce to whitelist which scripts can be run
		const nonce = getNonce();
		const pretty = JSON.stringify(
			jsonObject, null, 2
		);
		return /* html */`
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<title>Viewing BI Export ${title}</title>
				<meta charset="UTF-8">
				<!--
				Use a content security policy to only allow loading images from https or from our extension directory,
				and only allow scripts that have a specific nonce.
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${styleMainUri}" rel="stylesheet" />
			</head>
			<body>
				<h1>${title}</h1>
				<p>
					<table border="0" cellspacing="0" cellpadding="0" width="100%">
						<tr>
							<th scope="row"></th>
							<th scope="row"></th>
							<th scope="row"></th>
							<th scope="row"></th>
						</tr>
						${table}
						<tr>
							<th scope="row"></th>
							<th scope="row"></th>
							<th scope="row"></th>
							<th scope="row"></th>
						</tr>
					</table>
				</p>
				<br>
				<button type="button" class="collapsible">Full JSON Content</button>
				<div class="content">
					<pre id="json">${pretty}</pre>
				</div>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>
		`;
	}

	private coalesce = (...args : any) => args.find((_: null | undefined | any) => ![undefined, null].includes(_));

	private getHtmlTableForExport(exportedObject : any) : string {
		let typeOfFile = "Unknown";

		// There has _got_ to be a better way than this.
		typeOfFile = exportedObject.DashboardDefinition?.Name === undefined ? typeOfFile : "Dashboard";
		typeOfFile = exportedObject.ReportDefinition?.Name === undefined ? typeOfFile : "Report";
		typeOfFile = exportedObject.name === undefined ? typeOfFile : "Data Model";

		switch (typeOfFile) {
			case "Dashboard": {
				return /* html */`
					<tr>
						<th scope="row">Created:</th>
						<td>${exportedObject.DashboardDefinition.Created}</td>
						<th scope="row">ID:</th>
						<td>${exportedObject.DashboardDefinition.Id}</td>
					</tr>
					<tr>
						<th scope="row">Access:</th>
						<th scope="row">Right</td>
						<th scope="row"></td>
						<th scope="row">Role(s)</td>
					</tr>
					${exportedObject.DashboardDefinition.Accesses !== undefined && exportedObject.DashboardDefinition.Accesses.length >= 1 ? exportedObject.DashboardDefinition.Accesses.map((accessRole: { AccessRight: any; AccessorNames: any; }) => `
						<tr>
							<th scope="row"></th>
							<td>${accessRole.AccessRight}</td>
							<td>=></th>
							<td>${accessRole.AccessorNames.join(", ")}</td>
						</tr>
					`) : '<tr><th scope="row"></th><td>None Found</td><td></td><td></td>'}
					<tr>
						<th scope="row">Reports:</th>
						<th scope="row">Category</th>
						<th scope="row"></th>
						<th scope="row">Name</th>
					</tr>
					${exportedObject.ReportDefinitions !== undefined && exportedObject.ReportDefinitions.length >= 1 ? exportedObject.ReportDefinitions.map(report => `
							<tr>
								<th scope="row"></th>
								<td>${report.Category.Name}</th>
								<td>/</th>
								<td>${report.Name}</th>
							</tr>
						`).join("\n") : '<tr><th scope="row"></th><td>None Found</td><td></td><td></td>'
					}
					<tr>
						<th scope="row">Mappings:</th>
						<th scope="row">Name</td>
						<th scope="row"></td>
						<th scope="row">Source Name(s)</td>
					</tr>
					<!-- exportedObject.DashboardDefinition.Connections.map Row -->
					${exportedObject.DashboardDefinition.Connections !== undefined && exportedObject.DashboardDefinition.Connections.length >= 1 ? exportedObject.DashboardDefinition.Connections.map(connection => `
						<tr>
							<th scope="row">${connection.Name}</th>
							<td></td>
							<td>To:</td>
							<td>${connection.QuerySourceCategories.QuerySources.map(source => source.Name).join(", ")}</td>
						</tr>
					`) : '<tr><th scope="row"></th><td>None Found</td><td></td><td></td>'}
					<caption>Last exported at ${exportedObject.DashboardDefinition.Modified} from API v${exportedObject.Version}</caption>
				`;
			}
			case "Data Model": {
				return /* html */`
					<tr>
						<th scope="col">Connections:</th><th></th><th></th><th></th>
					</tr>
					<!-- exportedObject.sourceConnections.map -->
					${exportedObject.sourceConnections.map(connection => `
							<tr>
								<th scope="col">Name:</th>
								<td>${connection.name}</td>
								<th scope="col">Modified:</th>
								<td>${new Date(Math.max(...connection.dbSource.querySources.map(source => source.querySources.map(inner => new Date(inner.modified)))[0])).toLocaleString()}</td>
							</tr>
							<tr>
								<th scope="col">Schema:</th>
								<td>${connection.dbSource.querySources.map(source => source.name).join(", ")}</td>
								<th scope="col">Sources:</th>
								<td>${connection.dbSource.querySources.map(source => source.querySources).filter(item => item !== undefined).map(array => `${array.length} ${array[0].type}s`).join('<br>')}</td>
							</tr>
							<tr>
								<th scope="row"></th>
								<th scope="row"></th>
								<th scope="row"></th>
								<th scope="row"></th>
							</tr>
						`)
					}
					<caption>Last exported from API v${exportedObject.version}</caption>
				`;
			}
			case "Report": {
				return /* html */`
					<tr>
						<th scope="row">Created:</th>
						<td>${exportedObject.ReportDefinition.Created}</td>
						<th scope="row">ID:</th>
						<td>${exportedObject.ReportDefinition.Id}</td>
					</tr>
					<tr>
						<th scope="row">Access:</th>
						<th scope="row">Right</td>
						<th scope="row"></td>
						<th scope="row">Role(s)</td>
					</tr>
					${exportedObject.ReportDefinition.Accesses !== undefined && exportedObject.ReportDefinition.Accesses.length >= 1 ? exportedObject.ReportDefinition.Accesses.map((accessRole: { AccessRight: any; AccessorNames: any; }) => `
						<tr>
							<th scope="row"></th>
							<td>${accessRole.AccessRight}</td>
							<td>=></th>
							<td>${accessRole.AccessorNames.join(", ")}</td>
						</tr>
					`) : '<tr><th scope="row"></th><td>None Found</td><td></td><td></td>'}
					<tr>
						<th scope="row">Connections:</th>
						<th scope="row">Connection</td>
						<th scope="row"></td>
						<th scope="row">Source</td>
					</tr>
					${exportedObject.ReportDefinition.Connections !== undefined && exportedObject.ReportDefinition.Connections.length >= 1 ? exportedObject.ReportDefinition.Connections.map(connection => `
						<tr>
							<th scope="row">DB:</th>
							<td>${connection.Name}</td>
							
							<td>${connection.QuerySourceCategories.map(category => category.QuerySources.map(source => `[${category.Name}]</td><td>${source.Name}`).join(", "))}</td>
						</tr>
					`) : '<tr><th scope="row"></th><td>None Found</td><td></td><td></td>'}
					<caption>Last exported at ${exportedObject.ReportDefinition.Modified} from API v${exportedObject.Version}</caption>
				`;
			}
			default: {
				return "Unknown Type of Exported File";
			}
		}
	}

	private _requestId = 1;
	private readonly _callbacks = new Map<number, (response: any) => void>();

	private postMessageWithResponse<R = unknown>(panel: vscode.WebviewPanel, type: string, body: any): Promise<R> {
		const requestId = this._requestId++;
		const p = new Promise<R>(resolve => this._callbacks.set(requestId, resolve));
		panel.webview.postMessage({ type, requestId, body });
		return p;
	}

	private postMessage(panel: vscode.WebviewPanel, type: string, body: any): void {
		panel.webview.postMessage({ type, body });
	}

	private onMessage(document: BiExportDocument, message: any) {
		switch (message.type) {

			case 'response':
				{
					const callback = this._callbacks.get(message.requestId);
					callback?.(message.body);
					return;
				}
		}
	}
}

class WebviewCollection {
	private readonly _webviews = new Set<{
		readonly resource: string;
		readonly webviewPanel: vscode.WebviewPanel;
	}>();

	/**
	 * Get all known webviews for a given uri.
	 */
	public *get(uri: vscode.Uri): Iterable<vscode.WebviewPanel> {
		const key = uri.toString();
		for (const entry of this._webviews) {
			if (entry.resource === key) {
				yield entry.webviewPanel;
			}
		}
	}

	/**
	 * Add a new webview to the collection.
	 */
	public add(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel) {
		const entry = { resource: uri.toString(), webviewPanel };
		this._webviews.add(entry);

		webviewPanel.onDidDispose(() => {
			this._webviews.delete(entry);
		});
	}
}