import * as vscode from 'vscode';
import * as Path from 'path';
import JSZip = require('JSZip');
import jsonMinify = require('jsonminify');
import fs = require('fs');

function getInnerFileName (sourceUri: vscode.Uri) : string {
	return decodeURIComponent(Path.parse(sourceUri.toString()).name).toString().replace(/\+/g,' ');
}

export async function contentFromFile (sourceUri: vscode.Uri) : Promise<string> {
	const zipContent : string[] = [];
	
	const zipPromise = new JSZip.external.Promise(function (resolve, reject) {
		fs.readFile(sourceUri.fsPath, function(err, data) {
			if (err) {
				reject(err);
			} else {
				resolve(data);
			}
		});
	}).then(function (data : any) {
		return JSZip.loadAsync(data);
	}).then(function (zip : JSZip) {
		return zip.file(getInnerFileName(sourceUri))?.async("string");
	}).then(function (content : any | string) {
		console.log("Opening a file within '", sourceUri.fsPath, "' with length", content?.length);
		zipContent.push(content);
	});

	await Promise.all([zipPromise]);
	return zipContent[0];
}

export async function updateFileContent (sourceUri: vscode.Uri, newContent: string) : Promise<void> {
	// We minify the string, assuming it's JSON, and write the updates to the file
	const contentPromise = new JSZip.external.Promise(function (resolve, reject) {
		// We could probably just init JSZip / handle better to enable save-as
		fs.readFile(sourceUri.fsPath, function(err, data) {
			if (err) {
				reject(err);
			} else {
				resolve(data);
			}
		});
	}).then(function (data : any) {
		return JSZip.loadAsync(data);
	}).then(function (zip : JSZip) {
		zip.file(getInnerFileName(sourceUri), jsonMinify(newContent));
	});

	await Promise.all([contentPromise]);
}