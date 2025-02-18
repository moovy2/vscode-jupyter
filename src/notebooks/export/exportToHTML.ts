// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CancellationToken, NotebookDocument, Uri } from 'vscode';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { ExportFormat, IExportBase } from './types';
import { ServiceContainer } from '../../platform/ioc/container';

export class ExportToHTML {
    public async export(
        sourceDocument: NotebookDocument,
        target: Uri,
        interpreter: PythonEnvironment,
        token: CancellationToken
    ): Promise<void> {
        const exportBase = ServiceContainer.instance.get<IExportBase>(IExportBase);
        await exportBase.executeCommand(sourceDocument, target, ExportFormat.html, interpreter, token);
    }
}
