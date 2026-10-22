import fs from "node:fs/promises";
import ts from "typescript";

const check = process.argv.includes("--check");
const files = ["build-server.ts", "scripts/format.ts"];
for (const directory of ["server", "shared"]) {
  for (const entry of await fs.readdir(directory)) {
    if (entry.endsWith(".ts")) files.push(`${directory}/${entry}`);
  }
}

const options: ts.FormatCodeSettings = {
  ...ts.getDefaultFormatCodeSettings("\n"),
  indentSize: 2,
  tabSize: 2,
  convertTabsToSpaces: true,
};
let changed = false;
for (const file of files) {
  const source = await fs.readFile(file, "utf8");
  const service = ts.createLanguageService({
    getCompilationSettings: () => ({}),
    getScriptFileNames: () => [file],
    getScriptVersion: () => "0",
    getScriptSnapshot: (name) => name === file ? ts.ScriptSnapshot.fromString(source) : undefined,
    getCurrentDirectory: () => process.cwd(),
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
  });
  let formatted = source;
  const edits = service.getFormattingEditsForDocument(file, options);
  for (const edit of edits.sort((a, b) => b.span.start - a.span.start)) {
    formatted = formatted.slice(0, edit.span.start) + edit.newText + formatted.slice(edit.span.start + edit.span.length);
  }
  service.dispose();
  formatted = formatted.trimEnd() + "\n";
  if (formatted === source) continue;
  changed = true;
  console.log(file);
  if (!check) await fs.writeFile(file, formatted);
}
if (check && changed) process.exitCode = 1;
