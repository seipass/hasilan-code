export const HASHLINE_EDIT_DESCRIPTION = `Edit previously inspected workspace files using the exact [PATH#TAG] header and numbered source returned by read or edit. Never invent tags, line numbers, or omitted source.

Example (replace illustrative header/numbers with actual results):
*** Begin Patch
[src/example.ts#ABCD]
PUT 2.=3:
+const ready = true;
+
PUT >5:
+start();
*** End Patch

Use both envelope markers or neither. Group each file's operations under one header. All numbers address the original snapshot for this call, not positions shifted by earlier hunks.

Operations:
- PUT N.=M: replaces inclusive lines N through M; PUT N*: replaces a multiline Markdown or TS/JS syntax block at its opener. Include associated decorators/doc comments; never anchor the closer or an inner statement.
- PUT <N:, PUT >N:, PUT >N*:, PUT >$: insert before a line, after a line, after a block, or at file tail. <N* is invalid.
- Literal PUT bodies require + on every row. A lone + inserts a blank row; ++text inserts +text; +-text inserts -text. Indentation is preserved. Never send removed - rows, bare context, Markdown fences, or unified diff hunks. Use CUT, not an empty PUT, for deletion.
- CUT N.=M or CUT N* deletes and captures. Append @name for a named register. PUT locator @name pastes without colon or body; gap/tail PUT may omit @name to paste the anonymous cut. Range/block paste requires @name.
- REM deletes a fully inspected file. MV destination moves it after edits; JSON-quote paths with spaces. Existing destinations cannot be overwritten.

Only displayed lines are editable; read omitted or truncated regions first. Inspect an entire block before N* and the entire file before REM/MV. Use explicit ranges for languages other than Markdown/TS/JS. Preserve surrounding unchanged code and split unrelated changes into separate hunks.

Wait for each edit result before the next call. Use the returned fresh header and numbered preview, and recalculate positions after insertions/deletions. A fresh tag alone does not make omitted lines inspected. Conservative stale recovery is not a reason to reuse old positions: if rejected as stale, unread, or ambiguous, read the relevant region and rebuild the patch. Registers persist within this session. BOM/EOL/trailing newline are preserved; mixed EOL edits are refused. Multi-file I/O can partially apply: inspect each file's result before retrying.`;
