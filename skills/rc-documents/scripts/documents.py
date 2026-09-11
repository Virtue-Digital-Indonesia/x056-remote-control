#!/usr/bin/env python3
"""RC document toolkit v1. Edits copy unchanged ZIP entries byte-for-byte."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import resource
import subprocess
import sys
import tempfile
import zipfile

VERSION = "rc-documents-2"
MAX_EXPANDED = 200 * 1024 * 1024
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def limits():
    resource.setrlimit(resource.RLIMIT_CPU, (90, 90))
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_EXPANDED, MAX_EXPANDED))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))


def package(path, extension=None):
    from lxml import etree
    archive = zipfile.ZipFile(path)
    entries = archive.infolist()
    if len(entries) > 4096 or len({i.filename for i in entries}) != len(entries):
        raise ValueError("Archive has too many or duplicate entries")
    total = 0
    for item in entries:
        name = PurePosixPath(item.filename)
        if name.is_absolute() or ".." in name.parts or "\\" in item.filename or item.flag_bits & 1:
            raise ValueError("Unsafe or encrypted archive entry")
        if (item.external_attr >> 16) & 0o170000 == 0o120000:
            raise ValueError("Archive contains symbolic links")
        total += item.file_size
        if total > MAX_EXPANDED or item.file_size > MAX_EXPANDED or item.file_size > max(item.compress_size, 1) * 200:
            raise ValueError("Archive expansion limit exceeded")
    extension = extension or Path(path).suffix.lower()
    required = {".docx": "word/document.xml", ".xlsx": "xl/workbook.xml", ".pptx": "ppt/presentation.xml"}.get(extension)
    if required and (required not in archive.namelist() or "[Content_Types].xml" not in archive.namelist()):
        raise ValueError("Invalid Office package")
    roots = {}
    for item in entries:
        data = archive.read(item)  # verifies CRC, bounded above before expansion
        if item.filename.endswith((".xml", ".rels")):
            if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
                raise ValueError("XML entities are unsupported")
            roots[item.filename] = etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True))
    return archive, roots


def inspect(path, extension=None):
    extension = extension or Path(path).suffix.lower()
    if extension == ".pdf":
        result = subprocess.run(["pdftotext", "-f", "1", "-l", "100", str(path), "-"], check=True, capture_output=True, timeout=60)
        return {"format": "pdf", "text": result.stdout.decode("utf-8", "replace")[:200000]}
    archive, roots = package(path, extension)
    with archive:
        result = {"format": extension.lstrip("."), "entries": len(archive.infolist()), "parts": {i.filename: hashlib.sha256(archive.read(i)).hexdigest() for i in archive.infolist()}}
        if extension == ".docx":
            paragraphs = []
            structures = {name: 0 for name in ["tbl", "drawing", "numPr", "br", "sectPr", "ins", "del", "sdt", "fldChar"]}
            for name, root in roots.items():
                if not name.startswith("word/"):
                    continue
                for tag in structures:
                    structures[tag] += len(root.findall(".//{" + W + "}" + tag))
                for p in root.findall(".//{" + W + "}p"):
                    text = "".join(t.text or "" for t in p.findall(".//{" + W + "}t"))
                    if text:
                        paragraphs.append({"part": name, "text": text})
            result.update(paragraphs=paragraphs, structures=structures)
        return result


def edit(path, spec):
    from lxml import etree
    replacements = spec.get("replacements", [])
    if not replacements or len(replacements) > 100:
        raise ValueError("Provide 1 to 100 text replacements")
    archive, roots = package(path, ".docx")
    changed = set()
    with archive:
        for replacement in replacements:
            find, replace, count = replacement["find"], replacement["replace"], replacement.get("count", 1)
            if not isinstance(find, str) or not find or not isinstance(replace, str) or any(c in replace for c in "\r\n\t"):
                raise ValueError("Replacement must be plain paragraph text")
            matches = []
            for name, root in roots.items():
                if not name.startswith("word/"):
                    continue
                for p in root.findall(".//{" + W + "}p"):
                    nodes = p.findall(".//{" + W + "}t")
                    text = "".join(n.text or "" for n in nodes)
                    start = 0
                    while True:
                        start = text.find(find, start)
                        if start < 0:
                            break
                        blocked = ["ins", "del", "sdt", "fldChar", "instrText", "drawing", "br", "tab"]
                        if any(p.findall(".//{" + W + "}" + tag) for tag in blocked) or any(a.tag == "{" + W + "}sdt" for a in p.iterancestors()):
                            raise ValueError("Replacement touches an unsupported structure")
                        matches.append((name, nodes, start, start + len(find)))
                        start += len(find)
            if len(matches) != count:
                raise ValueError(f"Expected {count} occurrences, found {len(matches)}")
            for name, nodes, start, end in reversed(matches):
                offset, inserted = 0, False
                for node in nodes:
                    value = node.text or ""
                    stop = offset + len(value)
                    if offset < end and stop > start:
                        left, right = max(0, start - offset), min(len(value), end - offset)
                        node.text = value[:left] + (replace if not inserted else "") + value[right:]
                        node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
                        inserted = True
                    offset = stop
                changed.add(name)
        temporary = str(path) + ".rc-edit.tmp"
        try:
            with zipfile.ZipFile(temporary, "w") as output:
                for item in archive.infolist():
                    data = etree.tostring(roots[item.filename], xml_declaration=True, encoding="UTF-8", standalone=True) if item.filename in changed else archive.read(item)
                    output.writestr(item, data)
            package(temporary, ".docx")[0].close()
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    return {"changedParts": sorted(changed), "inspection": inspect(path)}


def create(path, spec):
    from docx import Document
    document = Document()
    if spec.get("title"):
        document.add_heading(spec["title"], 0)
    for paragraph in spec.get("paragraphs", []):
        document.add_paragraph(paragraph)
    for rows in spec.get("tables", []):
        if not rows or not rows[0] or any(len(row) != len(rows[0]) for row in rows):
            raise ValueError("Tables require rows with equal column counts")
        table = document.add_table(rows=len(rows), cols=len(rows[0]))
        table.style = "Table Grid"
        for row_index, row in enumerate(rows):
            for col_index, value in enumerate(row):
                table.cell(row_index, col_index).text = str(value)
    temporary = str(path) + ".rc-create.tmp"
    try:
        document.save(temporary)
        package(temporary, ".docx")[0].close()
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return inspect(path)


def preview(path, directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    if Path(path).suffix.lower() == ".pdf":
        pdf = Path(path)
    else:
        archive, roots = package(path, ".docx")
        with archive:
            if any("vba" in name.lower() for name in archive.namelist()):
                raise ValueError("Preview unavailable for documents containing macros")
            for root in roots.values():
                for node in root.iter():
                    if node.get("TargetMode", "").lower() == "external" and not node.get("Type", "").endswith("/hyperlink"):
                        raise ValueError("Preview unavailable for externally linked document resources")
                    if node.tag in ("{" + W + "}instrText", "{" + W + "}fldSimple"):
                        instruction = (node.text or "") + node.get("{" + W + "}instr", "")
                        if any(word in instruction.upper().split() for word in ["DDE", "DDEAUTO", "INCLUDEPICTURE", "INCLUDETEXT", "LINK"]):
                            raise ValueError("Preview unavailable for externally linked document fields")
        with tempfile.TemporaryDirectory(prefix="rc-office-") as profile:
            user = Path(profile) / "user"
            user.mkdir()
            (user / "registrymodifications.xcu").write_text('''<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item></oor:items>''')
            subprocess.run(["libreoffice", "-env:UserInstallation=" + Path(profile).as_uri(), "--headless", "--nologo", "--nodefault", "--norestore", "--convert-to", "pdf:writer_pdf_Export", "--outdir", str(directory), str(path)], check=True, capture_output=True, timeout=75)
        pdf = directory / (Path(path).stem + ".pdf")
        if not pdf.is_file():
            raise ValueError("Converter did not produce a PDF")
    subprocess.run(["pdftoppm", "-f", "1", "-l", "30", "-scale-to", "1400", "-png", str(pdf), str(directory / "page")], check=True, capture_output=True, timeout=75)
    pages = sorted(directory.glob("page-*.png"))
    if not pages:
        raise ValueError("Converter did not produce pages")
    return {"pdf": str(pdf), "pages": [str(p) for p in pages], "pageLimit": 30}


if __name__ == "__main__":
    limits()
    try:
        command, path = sys.argv[1:3]
        if command in ("inspect", "validate"):
            result = inspect(path, sys.argv[3] if len(sys.argv) > 3 else None)
            if command == "validate":
                result = {"valid": True, "format": result["format"]}
        elif command in ("edit", "create"):
            spec = json.loads(Path(sys.argv[3]).read_text())
            result = edit(path, spec) if command == "edit" else create(path, spec)
        elif command == "preview":
            result = preview(path, sys.argv[3])
        else:
            raise ValueError("Unknown document command")
        print(json.dumps({"toolkit": VERSION, **result}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
