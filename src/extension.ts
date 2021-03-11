import { promises } from 'node:dns';
import * as vscode from 'vscode';
import * as BixxViewer from './BIxxViewer';
import * as zipHandler from './zipHandler';

export function activate(context: vscode.ExtensionContext) {
	// Register our custom editor provider
	context.subscriptions.push(BixxViewer.BiEditorProvider.register(context));

	// Consider registering the JSON formatting editor, or otherwise treating the editor as JSON?
	// registerDocumentFormattingEditProvider(selector: DocumentSelector, provider: DocumentFormattingEditProvider): Disposable

	//showTextDocument(document: TextDocument, column?: ViewColumn, preserveFocus?: boolean): Thenable<TextEditor>
	const myScheme = 'bixx';
	const myProvider = new class implements vscode.TextDocumentContentProvider {
		onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
		onDidChange = this.onDidChangeEmitter.event;

		async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
			const fileContent = await zipHandler.contentFromFile(uri);
			const prettyContent = JSON.stringify(JSON.parse(fileContent), null, 2);
			return prettyContent;
		}
	}
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(myScheme, myProvider));

	context.subscriptions.push(vscode.commands.registerCommand('BIxxReader.Edit', async (uri: vscode.Uri) => {
		const newUri = vscode.Uri.parse(`bixx:${uri.path}`);
		const doc = await vscode.workspace.openTextDocument(newUri);
		await vscode.window.showTextDocument(doc, { preview: false })
	}));
}
