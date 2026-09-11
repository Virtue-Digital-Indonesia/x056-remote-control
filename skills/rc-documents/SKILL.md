---
name: rc-documents
description: Inspect, create, and revise documents in Remote Control Chat. Save immutable versions and generate previews through the Chat file tools.
---

Use `list_chat_files` to find saved inputs. Read the selected version, then use `checkout_chat_file` for a working copy.
Saved paths are originals. Never edit them directly.

Run the bundled helper with the document Python environment:

```sh
/opt/rc-documents/bin/python scripts/documents.py inspect /path/to/document.docx
/opt/rc-documents/bin/python scripts/documents.py edit /path/to/working.docx /path/to/edits.json
/opt/rc-documents/bin/python scripts/documents.py create /path/to/new.docx /path/to/content.json
```

Resolve `scripts/documents.py` relative to this skill directory. Runtime setup provides `/opt/rc-documents/bin/python`.

Edits use `{"replacements":[{"find":"old text","replace":"new text","count":1}]}`.
The helper preserves untouched package parts and run formatting outside each replacement.
It refuses replacements inside tracked changes, fields, drawings, or content controls.
Use another capable tool for unsupported edits, keeping the working copy and validating the result.

Creation accepts `{"title":"Proposal","paragraphs":["Introduction"],"tables":[[["Item","Cost"],["Service","100"]]]}`.
For richer layouts, use the installed `python-docx` package on the working copy.
PDF inspection uses `pdftotext`. Spreadsheet and slide files remain available to other installed tools.

Inspect the output and compare affected text, tables, styles, headers, footers, images, and page breaks.
Use `commit_chat_file` with the checkout token, base version, and a stable operation ID.
For a new document, use `register_chat_file` with its working path and a stable operation ID.
Request `preview_chat_file`, inspect its pages, and link the saved version's download URL.
A preview error leaves the valid document downloadable.

After an account switch, list saved versions before continuing.
An outdated checkout requires a fresh checkout; preserve useful edits separately and reconcile them against the latest version.
Retry a completed operation with its original ID. Use a new ID only for a new edit.
