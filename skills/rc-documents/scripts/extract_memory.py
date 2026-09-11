#!/usr/bin/env python3
"""Bounded, read-only passage extraction for the gateway memory bank."""
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import subprocess
import sys
import tempfile

VERSION = 'rc-memory-extractor-1'
DEFAULTS = dict(maxPages=1000, maxExpandedBytes=128*1024*1024, maxTextBytes=12*1024*1024,
                maxSeconds=60, maxMemoryBytes=512*1024*1024, passageChars=1800, overlapChars=200)
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


class Extractor:
    def __init__(self, options):
        self.options = {**DEFAULTS, **options}
        for key, default in DEFAULTS.items():
            value = self.options[key]
            if type(value) is not int or value <= 0 or value > default:
                raise ValueError('Invalid extraction limit: ' + key)
        if self.options['overlapChars'] >= self.options['passageChars']:
            raise ValueError('Passage overlap must be smaller than passage size')
        self.passages, self.warnings, self.bytes = [], [], 0
        self.status = 'ready'

    def partial(self, reason):
        self.status = 'partial'
        if reason not in self.warnings:
            self.warnings.append(reason)

    def add(self, text, locator):
        text = text.strip()
        if not text:
            return
        maximum = self.options['maxTextBytes']
        remaining = maximum - self.bytes
        raw = text.encode('utf-8')
        if len(raw) > remaining:
            text = raw[:remaining].decode('utf-8', 'ignore')
            self.partial('Extracted text limit reached; later content was not indexed')
        self.bytes += len(text.encode('utf-8'))
        size, overlap = self.options['passageChars'], self.options['overlapChars']
        for start in range(0, len(text), size-overlap):
            chunk = text[start:start+size]
            if not chunk.strip():
                continue
            loc = {**locator, 'charStart': start, 'charEnd': start+len(chunk)}
            self.passages.append(dict(ordinal=len(self.passages), locator=loc, text=chunk,
                                      hash=hashlib.sha256(chunk.encode()).hexdigest()))
            if start+size >= len(text):
                break

    def lines(self, text, markdown):
        heading, block, first = '', [], 1
        for number, line in enumerate(text.splitlines(), 1):
            is_heading = markdown and re.match(r'^#{1,6}\s+(.+)', line)
            if is_heading or sum(len(s)+1 for s in block) >= self.options['passageChars']:
                self.add('\n'.join(block), dict(kind='lines', startLine=first, endLine=number-1, heading=heading))
                # Keep bounded overlap with exact original line locations.
                while block and sum(len(s)+1 for s in block) > self.options['overlapChars']:
                    block.pop(0)
                    first += 1
                if is_heading:
                    block, first, heading = [], number, is_heading.group(1)
            if not block:
                first = number
            block.append(line)
            if self.bytes >= self.options['maxTextBytes']:
                break
        self.add('\n'.join(block), dict(kind='lines', startLine=first, endLine=first+len(block)-1, heading=heading))

    def docx(self, path):
        import zipfile
        from lxml import etree
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > 4096 or len({i.filename for i in entries}) != len(entries):
                raise ValueError('Too many or duplicate document parts')
            expanded = 0
            for item in entries:
                expanded += item.file_size
                if expanded > self.options['maxExpandedBytes'] or item.file_size > max(item.compress_size,1)*200:
                    raise ValueError('Document expansion limit exceeded')
                if item.flag_bits & 1:
                    raise ValueError('Encrypted document parts are unsupported')
            parser = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=False)
            def xml(name):
                data = archive.read(name)
                if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
                    raise ValueError('Document entities are unsupported')
                return etree.fromstring(data, parser)
            root = xml('word/document.xml')
            styles = {}
            if 'word/styles.xml' in archive.namelist():
                for style in xml('word/styles.xml').iter(W+'style'):
                    name = style.find(W+'name')
                    styles[style.get(W+'styleId')] = name.get(W+'val', '') if name is not None else ''
            heading, paragraph, table = '', 0, 0
            def content(node):
                return ''.join((e.text or '') if e.tag == W+'t' else '\n' if e.tag in (W+'br', W+'cr') else '\t' if e.tag == W+'tab' else '' for e in node.iter())
            body = root.find(W+'body')
            if body is None:
                raise ValueError('Document body unavailable')
            for node in body:
                if node.tag == W+'p':
                    paragraph += 1
                    text = content(node)
                    style = node.find('./'+W+'pPr/'+W+'pStyle')
                    style_name = styles.get(style.get(W+'val'),style.get(W+'val','')) if style is not None else ''
                    if re.match(r'heading\s*\d', style_name, re.I):
                        heading = text
                    self.add(text, dict(kind='paragraph', paragraph=paragraph, heading=heading))
                elif node.tag == W+'tbl':
                    table += 1
                    for row, tr in enumerate(node.findall(W+'tr'), 1):
                        for cell, tc in enumerate(tr.findall(W+'tc'), 1):
                            text = '\n'.join(content(p) for p in tc.iter(W+'p'))
                            self.add(text,dict(kind='table-cell',table=table,row=row,cell=cell,heading=heading))
                elif node.tag != W+'sectPr':
                    self.partial('Some structured document blocks need manual review')
                if self.bytes >= self.options['maxTextBytes']:
                    break
            if any(name.startswith(('word/header','word/footer','word/footnotes','word/endnotes')) for name in archive.namelist()):
                self.partial('Headers, footers, footnotes, and endnotes remain in the original file')
            if any(True for _ in root.iter(W+'drawing')):
                self.partial('Text in drawings and images was not indexed')

    def pdf(self,path):
        info = subprocess.run(['pdfinfo',str(path)],capture_output=True,timeout=self.options['maxSeconds'],check=True)
        found = re.search(rb'^Pages:\s*(\d+)',info.stdout,re.M)
        if not found:
            raise ValueError('PDF page count unavailable')
        pages = int(found.group(1))
        maximum = min(pages,self.options['maxPages'])
        if pages > maximum:
            self.partial('PDF page limit reached: indexed the first '+str(maximum)+' of '+str(pages)+' pages')
        empty_pages = []
        # One page per bounded subprocess preserves page locators and early progress.
        for page in range(1,maximum+1):
            result = subprocess.run(['pdftotext','-f',str(page),'-l',str(page),'-layout','-enc','UTF-8',str(path),'-'],capture_output=True,timeout=self.options['maxSeconds'],check=True)
            text = result.stdout.decode('utf-8','replace').replace('\f','').strip()
            if not text:
                empty_pages.append(page)
            self.add(text,dict(kind='page',page=page))
            if self.bytes >= self.options['maxTextBytes']:
                break
        if not self.passages:
            self.status = 'needs_ocr'
            self.warnings.append('No extractable text. OCR is not configured; retain the PDF for manual reading')
        elif empty_pages:
            self.partial('Pages without extractable text: '+', '.join(map(str,empty_pages[:30])))

    def run(self,path,format):
        if format == 'docx':
            self.docx(path)
        elif format == 'pdf':
            self.pdf(path)
        elif format in ('md','txt'):
            with open(path,'rb') as source:
                raw = source.read(self.options['maxTextBytes']+1)
            if len(raw) > self.options['maxTextBytes']:
                self.partial('Input text limit reached; later content was not indexed')
                raw = raw[:self.options['maxTextBytes']]
            text = raw.decode('utf-8-sig','replace')
            if '\ufffd' in text:
                self.partial('Some text could not be decoded as UTF-8')
            self.lines(text,format=='md')
        else:
            self.status = 'unsupported'
            self.warnings.append('This format is downloadable but is not indexed')
        if not self.passages and self.status in ('ready','partial'):
            self.status = 'failed'
            self.warnings.append('No text was extracted')
        return dict(extractor=VERSION,format=format,state=self.status,warnings=self.warnings,
                    textBytes=self.bytes,passages=self.passages,limits=self.options)


def main():
    path,format,output = sys.argv[1:4]
    extractor = Extractor(json.loads(sys.argv[4]) if len(sys.argv)>4 else {})
    o = extractor.options
    resource.setrlimit(resource.RLIMIT_CPU,(o['maxSeconds'],o['maxSeconds']))
    resource.setrlimit(resource.RLIMIT_AS,(o['maxMemoryBytes'],o['maxMemoryBytes']))
    resource.setrlimit(resource.RLIMIT_FSIZE,(64*1024*1024,64*1024*1024))
    resource.setrlimit(resource.RLIMIT_NOFILE,(128,128))
    result = extractor.run(Path(path),format)
    with open(output,'w') as handle:
        json.dump(result,handle,ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error':str(error)[:2000]}),file=sys.stderr)
        sys.exit(1)
