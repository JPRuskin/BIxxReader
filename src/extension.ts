import * as vscode from 'vscode';
import * as BixxViewer from './BIxxViewer';

export function activate(context: vscode.ExtensionContext) {
	// Register our custom editor provider
	context.subscriptions.push(BixxViewer.BiEditorProvider.register(context));

	// Consider registering the JSON formatting editor, or otherwise treating the editor as JSON?
	// registerDocumentFormattingEditProvider(selector: DocumentSelector, provider: DocumentFormattingEditProvider): Disposable

	//showTextDocument(document: TextDocument, column?: ViewColumn, preserveFocus?: boolean): Thenable<TextEditor>
}
