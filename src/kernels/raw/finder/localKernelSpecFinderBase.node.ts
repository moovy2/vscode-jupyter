// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

'use strict';

import * as path from '../../../platform/vscode-path/path';
import * as uriPath from '../../../platform/vscode-path/resources';
import { CancellationToken, Memento, Uri } from 'vscode';
import { IPythonExtensionChecker } from '../../../platform/api/types';
import { IApplicationEnvironment, IWorkspaceService } from '../../../platform/common/application/types';
import { PYTHON_LANGUAGE } from '../../../platform/common/constants';
import { traceInfo, traceVerbose, traceError, traceDecoratorError } from '../../../platform/logging';
import { getDisplayPath } from '../../../platform/common/platform/fs-paths';
import { IFileSystemNode } from '../../../platform/common/platform/types.node';
import { IDisposable, IDisposableRegistry, ReadWrite } from '../../../platform/common/types';
import { isUri, noop } from '../../../platform/common/utils/misc';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import {
    deserializeKernelConnection,
    getInterpreterKernelSpecName,
    getKernelRegistrationInfo,
    serializeKernelConnection
} from '../../../kernels/helpers';
import {
    IJupyterKernelSpec,
    LocalKernelConnectionMetadata,
    LocalKernelSpecConnectionMetadata,
    PythonKernelConnectionMetadata
} from '../../../kernels/types';
import { JupyterKernelSpec } from '../../jupyter/jupyterKernelSpec';
import { getComparisonKey } from '../../../platform/vscode-path/resources';
import { removeOldCachedItems } from '../../common/commonFinder';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const flatten = require('lodash/flatten') as typeof import('lodash/flatten');

type KernelSpecFileWithContainingInterpreter = { interpreter?: PythonEnvironment; kernelSpecFile: Uri };
export const isDefaultPythonKernelSpecSpecName = /python\s\d*.?\d*$/;
export const oldKernelsSpecFolderName = '__old_vscode_kernelspecs';

/**
 * Base class for searching for local kernels that are based on a kernel spec file.
 */
export abstract class LocalKernelSpecFinderBase<
    T extends LocalKernelSpecConnectionMetadata | PythonKernelConnectionMetadata
> implements IDisposable
{
    private _oldKernelSpecsFolder?: string;
    private findKernelSpecsInPathCache = new Map<string, Promise<KernelSpecFileWithContainingInterpreter[]>>();

    protected get oldKernelSpecsFolder() {
        return this._oldKernelSpecsFolder || this.globalState.get<string>('OLD_KERNEL_SPECS_FOLDER__', '');
    }
    private set oldKernelSpecsFolder(value: string) {
        this._oldKernelSpecsFolder = value;
        this.globalState.update('OLD_KERNEL_SPECS_FOLDER__', value).then(noop, noop);
    }
    private cache?: KernelSpecFileWithContainingInterpreter[];
    // Store our results when listing all possible kernelspecs for a resource
    private kernelSpecCache = new Map<
        string,
        {
            usesPython: boolean;
            wasPythonExtInstalled: boolean;
            promise: Promise<T[]>;
        }
    >();

    // Store any json file that we have loaded from disk before
    private pathToKernelSpec = new Map<string, Promise<IJupyterKernelSpec | undefined>>();

    constructor(
        protected readonly fs: IFileSystemNode,
        protected readonly workspaceService: IWorkspaceService,
        protected readonly extensionChecker: IPythonExtensionChecker,
        protected readonly globalState: Memento,
        disposables: IDisposableRegistry,
        private readonly env: IApplicationEnvironment
    ) {
        disposables.push(this);
    }

    public abstract dispose(): void | undefined;
    /**
     * @param {boolean} dependsOnPythonExtension Whether this list of kernels fetched depends on whether the python extension is installed/not installed.
     * If for instance first Python Extension isn't installed, then we call this again, after installing it, then the cache will be blown away
     */
    @traceDecoratorError('List kernels failed')
    protected async listKernelsWithCache(
        cacheKey: string,
        dependsOnPythonExtension: boolean,
        finder: () => Promise<T[]>,
        ignoreCache?: boolean
    ): Promise<T[]> {
        // If we have already searched for this resource, then use that.
        const result = this.kernelSpecCache.get(cacheKey);
        if (result && !ignoreCache) {
            // If python extension is now installed & was not installed previously, then ignore the previous cache.
            if (
                result.usesPython &&
                result.wasPythonExtInstalled === this.extensionChecker.isPythonExtensionInstalled
            ) {
                return result.promise;
            } else if (!result.usesPython) {
                return result.promise;
            }
        }
        const promise = finder().then((items) => {
            const distinctKernelMetadata = new Map<string, T>();
            items.map((kernelSpec) => {
                // Check if we have already seen this.
                if (!distinctKernelMetadata.has(kernelSpec.id)) {
                    distinctKernelMetadata.set(kernelSpec.id, kernelSpec);
                }
            });

            return Array.from(distinctKernelMetadata.values()).sort((a, b) => {
                const nameA = a.kernelSpec.display_name.toUpperCase();
                const nameB = b.kernelSpec.display_name.toUpperCase();
                if (nameA === nameB) {
                    return 0;
                } else if (nameA < nameB) {
                    return -1;
                } else {
                    return 1;
                }
            });
        });
        // Keep track of whether Python extension was installed or not when fetching this list of kernels.
        // Next time if its installed then we can ignore this cache.
        const wasPythonExtInstalled = this.extensionChecker.isPythonExtensionInstalled;
        this.kernelSpecCache.set(cacheKey, { usesPython: dependsOnPythonExtension, promise, wasPythonExtInstalled });

        // ! as the has and set above verify that we have a return here
        return this.kernelSpecCache.get(cacheKey)!.promise;
    }
    protected async listKernelsFirstTimeFromMemento(cacheKey: string): Promise<T[]> {
        // Check memento too
        const cache = this.globalState.get<{ kernels: T[]; extensionVersion: string }>(cacheKey, {
            kernels: [],
            extensionVersion: ''
        });

        let kernels: T[] = [];
        /**
         * The cached list of raw kernels is pointing to kernelSpec.json files in the extensions directory.
         * Assume you have version 1 of extension installed.
         * Now you update to version 2, at this point the cache still points to version 1 and the kernelSpec.json files are in the directory version 1.
         * Those files in directory for version 1 could get deleted by VS Code at any point in time, as thats an old version of the extension and user has now installed version 2.
         * Hence its wrong and buggy to use those files.
         * To ensure we don't run into weird issues with the use of cached kernelSpec.json files, we ensure the cache is tied to each version of the extension.
         */
        if (cache && Array.isArray(cache.kernels) && cache.extensionVersion === this.env.extensionVersion) {
            kernels = cache.kernels.map(deserializeKernelConnection) as T[];
        }

        // Validate
        const validValues: T[] = [];
        await Promise.all(
            kernels.map(async (item) => {
                if (await this.isValidCachedKernel(item)) {
                    validValues.push(item);
                }
            })
        );
        return validValues;
    }

    protected async writeToMementoCache(values: T[], cacheKey: string) {
        const serialized = values.map(serializeKernelConnection);
        await Promise.all([
            removeOldCachedItems(this.globalState),
            this.globalState.update(cacheKey, {
                kernels: serialized,
                extensionVersion: this.env.extensionVersion
            })
        ]);
    }
    protected async isValidCachedKernel(kernel: LocalKernelConnectionMetadata): Promise<boolean> {
        switch (kernel.kind) {
            case 'startUsingPythonInterpreter':
                // Interpreters have to still exist
                return this.fs.exists(kernel.interpreter.uri);

            case 'startUsingLocalKernelSpec':
                // Spec files have to still exist and interpreters have to exist
                const promiseSpec = kernel.kernelSpec.specFile
                    ? this.fs.exists(Uri.file(kernel.kernelSpec.specFile))
                    : Promise.resolve(true);
                return promiseSpec.then((r) => {
                    return r && kernel.interpreter ? this.fs.exists(kernel.interpreter.uri) : Promise.resolve(true);
                });
        }
    }
    /**
     * Load the IJupyterKernelSpec for a given spec path, check the ones that we have already loaded first
     */
    protected async getKernelSpec(
        specPath: Uri,
        cancelToken: CancellationToken,
        interpreter?: PythonEnvironment,
        globalSpecRootPath?: Uri
    ): Promise<IJupyterKernelSpec | undefined> {
        // This is a backup folder for old kernels created by us.
        if (specPath.fsPath.includes(oldKernelsSpecFolderName)) {
            return;
        }
        const key = getComparisonKey(specPath);
        // If we have not already loaded this kernel spec, then load it
        if (!this.pathToKernelSpec.has(key)) {
            this.pathToKernelSpec.set(key, this.loadKernelSpec(specPath, cancelToken, interpreter));
        }
        // ! as the has and set above verify that we have a return here
        return this.pathToKernelSpec.get(key)!.then((kernelSpec) => {
            // Delete old kernelSpecs that we created in the global kernelSpecs folder.
            const shouldDeleteKernelSpec =
                kernelSpec &&
                globalSpecRootPath &&
                getKernelRegistrationInfo(kernelSpec) &&
                kernelSpec.specFile &&
                uriPath.isEqualOrParent(Uri.file(kernelSpec.specFile), globalSpecRootPath);
            if (kernelSpec && !shouldDeleteKernelSpec) {
                return kernelSpec;
            }
            if (kernelSpec?.specFile && shouldDeleteKernelSpec) {
                // If this kernelSpec was registered by us and is in the global kernels folder,
                // then remove it.
                this.deleteOldKernelSpec(kernelSpec.specFile).catch(noop);
            }

            // If we failed to get a kernelSpec full path from our cache and loaded list
            this.pathToKernelSpec.delete(key);
            this.cache = this.cache?.filter((itemPath) => uriPath.isEqual(itemPath.kernelSpecFile, specPath));
            return undefined;
        });
    }

    private async deleteOldKernelSpec(kernelSpecFile: string) {
        // Just copy this folder into a seprate location.
        const kernelSpecFolderName = path.basename(path.dirname(kernelSpecFile));
        const destinationFolder = path.join(path.dirname(path.dirname(kernelSpecFile)), oldKernelsSpecFolderName);
        this.oldKernelSpecsFolder = destinationFolder;
        const destinationFile = path.join(destinationFolder, kernelSpecFolderName, path.basename(kernelSpecFile));
        await this.fs.createDirectory(Uri.file(path.dirname(destinationFile)));
        await this.fs.copy(Uri.file(kernelSpecFile), Uri.file(destinationFile)).catch(noop);
        await this.fs.delete(Uri.file(kernelSpecFile));
        traceInfo(`Old KernelSpec '${kernelSpecFile}' deleted and backup stored in ${destinationFolder}`);
    }
    /**
     * Load kernelspec json from disk
     */
    private async loadKernelSpec(
        specPath: Uri,
        cancelToken: CancellationToken,
        interpreter?: PythonEnvironment
    ): Promise<IJupyterKernelSpec | undefined> {
        return loadKernelSpec(specPath, this.fs, cancelToken, interpreter);
    }
    // Given a set of paths, search for kernel.json files and return back the full paths of all of them that we find
    protected async findKernelSpecsInPaths(
        paths: (Uri | { interpreter: PythonEnvironment; kernelSearchPath: Uri })[],
        cancelToken: CancellationToken
    ): Promise<KernelSpecFileWithContainingInterpreter[]> {
        const items = await Promise.all(paths.map((searchItem) => this.findKernelSpecsInPath(searchItem, cancelToken)));
        return flatten(items);
    }
    // Given a set of paths, search for kernel.json files and return back the full paths of all of them that we find
    private async findKernelSpecsInPath(
        searchItem: Uri | { interpreter: PythonEnvironment; kernelSearchPath: Uri },
        cancelToken: CancellationToken
    ): Promise<KernelSpecFileWithContainingInterpreter[]> {
        const cacheKey = isUri(searchItem)
            ? getComparisonKey(searchItem)
            : `${getComparisonKey(searchItem.interpreter.uri)}${getComparisonKey(searchItem.kernelSearchPath)}`;

        const previousPromise = this.findKernelSpecsInPathCache.get(cacheKey);
        if (previousPromise) {
            return previousPromise;
        }
        const searchPath = isUri(searchItem) ? searchItem : searchItem.kernelSearchPath;
        const promise = (async () => {
            if (await this.fs.exists(searchPath)) {
                if (cancelToken.isCancellationRequested) {
                    return [];
                }
                const files = await this.fs.searchLocal(`**/kernel.json`, searchPath.fsPath, true);
                return files
                    .map((item) => uriPath.joinPath(searchPath, item))
                    .map((item) => {
                        return {
                            interpreter: isUri(searchItem) ? undefined : searchItem.interpreter,
                            kernelSpecFile: item
                        };
                    });
            } else {
                traceVerbose(`Not Searching for kernels as path does not exist, ${getDisplayPath(searchPath)}`);
                return [];
            }
        })();
        this.findKernelSpecsInPathCache.set(cacheKey, promise);
        const disposable = cancelToken.onCancellationRequested(() => {
            if (this.findKernelSpecsInPathCache.get(cacheKey) === promise) {
                this.findKernelSpecsInPathCache.delete(cacheKey);
            }
        });
        promise.finally(() => disposable.dispose());
        promise.catch((ex) => {
            if (this.findKernelSpecsInPathCache.get(cacheKey) === promise) {
                this.findKernelSpecsInPathCache.delete(cacheKey);
            }
            traceVerbose(`Failed to search for kernels in ${getDisplayPath(searchPath)} with an error`, ex);
        });
        return promise;
    }
}

/**
 * Load kernelspec json from disk
 */
export async function loadKernelSpec(
    specPath: Uri,
    fs: IFileSystemNode,
    cancelToken: CancellationToken,
    interpreter?: PythonEnvironment
): Promise<IJupyterKernelSpec | undefined> {
    // This is a backup folder for old kernels created by us.
    if (specPath.fsPath.includes(oldKernelsSpecFolderName)) {
        return;
    }
    let kernelJson: ReadWrite<IJupyterKernelSpec>;
    try {
        traceVerbose(
            `Loading kernelspec from ${getDisplayPath(specPath)} for ${
                interpreter?.uri ? getDisplayPath(interpreter.uri) : ''
            }`
        );
        kernelJson = JSON.parse(await fs.readFile(specPath));
    } catch (ex) {
        traceError(`Failed to parse kernelspec ${specPath}`, ex);
        return;
    }
    if (cancelToken.isCancellationRequested) {
        return;
    }

    // Special case. If we have an interpreter path this means this spec file came
    // from an interpreter location (like a conda environment). Modify the name to make sure it fits
    // the kernel instead
    // kernelJson.originalName = kernelJson.name;
    kernelJson.name = interpreter ? await getInterpreterKernelSpecName(interpreter) : kernelJson.name;
    if (cancelToken.isCancellationRequested) {
        return;
    }

    // Update the display name too if we have an interpreter.
    const isDefaultPythonName = kernelJson.display_name.toLowerCase().match(isDefaultPythonKernelSpecSpecName);
    if (!isDefaultPythonName && kernelJson.language === PYTHON_LANGUAGE && kernelJson.argv.length > 2) {
        // Default kernel spec argv for Python kernels is `"python","-m","ipykernel_launcher","-f","{connection_file}"`
        // Some older versions had `ipykernel` instead of `ipykernel_launcher`
        // If its different, then use that as an identifier for the kernel name.
        const argv = kernelJson.argv
            .slice(1) // ignore python
            .map((arg) => arg.toLowerCase())
            .filter((arg) => !['-m', 'ipykernel', 'ipykernel_launcher', '-f', '{connection_file}'].includes(arg));
        if (argv.length) {
            kernelJson.name = `${kernelJson.name}.${argv.join('#')}`;
        }
    }
    kernelJson.metadata = kernelJson.metadata || {};
    kernelJson.metadata.vscode = kernelJson.metadata.vscode || {};
    if (!kernelJson.metadata.vscode.originalSpecFile) {
        kernelJson.metadata.vscode.originalSpecFile = specPath.fsPath;
    }
    if (!kernelJson.metadata.vscode.originalDisplayName) {
        kernelJson.metadata.vscode.originalDisplayName = kernelJson.display_name;
    }
    if (kernelJson.metadata.originalSpecFile) {
        kernelJson.metadata.vscode.originalSpecFile = kernelJson.metadata.originalSpecFile;
        delete kernelJson.metadata.originalSpecFile;
    }

    const kernelSpec: IJupyterKernelSpec = new JupyterKernelSpec(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        kernelJson as any,
        specPath.fsPath,
        // Interpreter information may be saved in the metadata (if this is a kernel spec created/registered by us).
        interpreter?.uri.fsPath || kernelJson?.metadata?.interpreter?.path,
        getKernelRegistrationInfo(kernelJson)
    );

    // Some registered kernel specs do not have a name, in this case use the last part of the path
    kernelSpec.name = kernelJson?.name || path.basename(path.dirname(specPath.fsPath));

    // Possible user deleted the underlying kernel.
    const interpreterPath = interpreter?.uri.fsPath || kernelJson?.metadata?.interpreter?.path;
    if (interpreterPath && !(await fs.exists(Uri.file(interpreterPath)))) {
        return;
    }

    return kernelSpec;
}
