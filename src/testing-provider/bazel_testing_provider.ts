import * as vscode from "vscode";
import {
  getContentFromFilesystem,
  MarkdownTestData,
  TestCase,
  testData,
  TestFile,
} from "./testTree";
import { queryQuickPickTargets } from "../bazel";
import { bazelGetTargetOutput } from "../extension/extension";

export class BazelTestingProvider {
  private context: vscode.ExtensionContext;
  private ctrl: vscode.TestController;

  constructor(private context_: vscode.ExtensionContext) {
    this.context = context_;
    this.ctrl = vscode.tests.createTestController(
      "bazelTestExplorer",
      "Bazel Tests",
    );
    this.context.subscriptions.push(this.ctrl);
  }

  public async activate() {
    // TODO: test stuff here

    const fileChangedEmitter = new vscode.EventEmitter<vscode.Uri>();
    const runHandler = (
      request: vscode.TestRunRequest2,
      cancellation: vscode.CancellationToken,
    ) => {
      if (!request.continuous) {
        return startTestRun(request);
      }

      const l = fileChangedEmitter.event((uri) =>
        startTestRun(
          new vscode.TestRunRequest2(
            [this.getOrCreateFile(this.ctrl, uri).file],
            undefined,
            request.profile,
            true,
          ),
        ),
      );
      cancellation.onCancellationRequested(() => l.dispose());
    };

    const startTestRun = (request: vscode.TestRunRequest) => {
      const queue: { test: vscode.TestItem; data: TestCase }[] = [];
      const run = this.ctrl.createTestRun(request);
      // map of file uris to statements on each line:
      const coveredLines = new Map<
        /* file uri */ string,
        (vscode.StatementCoverage | undefined)[]
      >();

      const discoverTests = async (tests: Iterable<vscode.TestItem>) => {
        for (const test of tests) {
          if (request.exclude?.includes(test)) {
            continue;
          }

          const data = testData.get(test);
          if (data instanceof TestCase) {
            run.enqueued(test);
            queue.push({ test, data });
          } else {
            if (data instanceof TestFile && !data.didResolve) {
              await data.updateFromDisk(this.ctrl, test);
            }

            await discoverTests(this.gatherTestItems(test.children));
          }

          if (test.uri && !coveredLines.has(test.uri.toString())) {
            try {
              const lines = (await getContentFromFilesystem(test.uri)).split(
                "\n",
              );
              coveredLines.set(
                test.uri.toString(),
                lines.map((lineText, lineNo) =>
                  lineText.trim().length
                    ? new vscode.StatementCoverage(
                        0,
                        new vscode.Position(lineNo, 0),
                      )
                    : undefined,
                ),
              );
            } catch {
              // ignored
            }
          }
        }
      };

      const runTestQueue = async () => {
        for (const { test, data } of queue) {
          run.appendOutput(`Running ${test.id}\r\n`);
          if (run.token.isCancellationRequested) {
            run.skipped(test);
          } else {
            run.started(test);
            await data.run(test, run);
          }

          const lineNo = test.range!.start.line;
          const fileCoverage = coveredLines.get(test.uri!.toString());
          if (fileCoverage) {
            fileCoverage[lineNo]!.executionCount++;
          }

          run.appendOutput(`Completed ${test.id}\r\n`);
        }

        run.end();
      };

      run.coverageProvider = {
        provideFileCoverage() {
          const coverage: vscode.FileCoverage[] = [];
          for (const [uri, statements] of coveredLines) {
            coverage.push(
              vscode.FileCoverage.fromDetails(
                vscode.Uri.parse(uri),
                statements.filter((s): s is vscode.StatementCoverage => !!s),
              ),
            );
          }

          return coverage;
        },
      };

      discoverTests(
        request.include ?? this.gatherTestItems(this.ctrl.items),
      ).then(runTestQueue);
    };

    this.ctrl.refreshHandler = async () => {
      await Promise.all(
        this.getWorkspaceTestPatterns().map(({ pattern }) =>
          this.findInitialFiles(this.ctrl),
        ),
      );
    };

    this.ctrl.createRunProfile(
      "Run Bazel Tests",
      vscode.TestRunProfileKind.Run,
      runHandler,
      true,
      undefined,
      true,
    );

    this.ctrl.createRunProfile(
      "Debug Bazel Tests",
      vscode.TestRunProfileKind.Debug,
      runHandler,
      true,
      undefined,
      true,
    );

    this.ctrl.resolveHandler = async (item) => {
      if (!item) {
        this.context.subscriptions.push(
          ...this.startWatchingWorkspace(this.ctrl, fileChangedEmitter),
        );
        return;
      }

      const data = testData.get(item);
      if (data instanceof TestFile) {
        await data.updateFromDisk(this.ctrl, item);
      }
    };

    function updateNodeForDocument(e: vscode.TextDocument) {
      if (e.uri.scheme !== "file") {
        return;
      }

      if (!e.uri.path.endsWith(".md")) {
        return;
      }

      const { file, data } = this.getOrCreateFile(this.ctrl, e.uri);
      data.updateFromContents(this.ctrl, e.getText(), file); // TODO: here is how to a add a file to the tree
    }

    for (const document of vscode.workspace.textDocuments) {
      updateNodeForDocument(document);
    }

    this.context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
      vscode.workspace.onDidChangeTextDocument((e) =>
        updateNodeForDocument(e.document),
      ),
    );
  }

  protected getOrCreateFile(
    controller: vscode.TestController,
    uri: vscode.Uri,
  ) {
    const existing = controller.items.get(uri.toString());
    if (existing) {
      return { file: existing, data: testData.get(existing) as TestFile };
    }

    const file = controller.createTestItem(
      uri.toString(),
      uri.path.split("/").pop()!,
      uri,
    );
    controller.items.add(file);

    const data = new TestFile();
    testData.set(file, data);

    file.canResolveChildren = true;
    return { file, data };
  }

  protected gatherTestItems(collection: vscode.TestItemCollection) {
    const items: vscode.TestItem[] = [];
    collection.forEach((item) => items.push(item));
    return items;
  }

  protected getWorkspaceTestPatterns() {
    if (!vscode.workspace.workspaceFolders) {
      return [];
    }

    return vscode.workspace.workspaceFolders.map((workspaceFolder) => ({
      workspaceFolder,
      pattern: new vscode.RelativePattern(workspaceFolder, "**/*.md"),
    }));
  }

  protected async findInitialFiles(controller: vscode.TestController) {
    // TODO: write code here
    for (const target of await queryQuickPickTargets(
      "kind('.*_test rule', ...)",
    )) {
      console.log(target);
      console.log(target.label);
      const commandOptions = target.getBazelCommandOptions();
      console.log(commandOptions.targets[0]);
      console.log(commandOptions.options);

      let target_output = await bazelGetTargetOutput(
        commandOptions.targets[0],
        commandOptions.options,
      );
      console.log(target_output);
      this.getOrCreateFile(controller, vscode.Uri.file(target_output));
    }
  }

  protected startWatchingWorkspace(
    controller: vscode.TestController,
    fileChangedEmitter: vscode.EventEmitter<vscode.Uri>,
  ) {
    return this.getWorkspaceTestPatterns().map(
      ({ workspaceFolder, pattern }) => {
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);

        watcher.onDidCreate((uri) => {
          this.getOrCreateFile(controller, uri);
          fileChangedEmitter.fire(uri);
        });
        watcher.onDidChange(async (uri) => {
          const { file, data } = this.getOrCreateFile(controller, uri);
          if (data.didResolve) {
            await data.updateFromDisk(controller, file);
          }
          fileChangedEmitter.fire(uri);
        });
        watcher.onDidDelete((uri) => controller.items.delete(uri.toString()));

        this.findInitialFiles(controller);

        return watcher;
      },
    );
  }
}
