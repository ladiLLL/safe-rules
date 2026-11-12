'use strict';

const zlib = require('node:zlib');

/**
 * CRC-32 calculation table for ZIP archive creation (.xlsx)
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function escapeXml(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function colIndexToLetter(index) {
  let letter = '';
  let temp = index + 1;
  while (temp > 0) {
    const mod = (temp - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    temp = Math.floor((temp - mod) / 26);
  }
  return letter;
}

function colLetterToIndex(letters) {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

/**
 * Creates a standard ZIP buffer from an array of { name, data (Buffer|string) }
 */
function createZipBuffer(files) {
  const localFileHeaders = [];
  const centralDirHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const uncompressedBuf = Buffer.isBuffer(file.data)
      ? file.data
      : Buffer.from(String(file.data), 'utf8');
    const compressedBuf = zlib.deflateRawSync(uncompressedBuf);
    const crc = crc32(uncompressedBuf);

    // Local file header (30 bytes + filename)
    const lfh = Buffer.alloc(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0); // signature
    lfh.writeUInt16LE(20, 4);         // version needed
    lfh.writeUInt16LE(0x0800, 6);     // UTF-8 flag
    lfh.writeUInt16LE(8, 8);          // deflate compression
    lfh.writeUInt16LE(0, 10);         // mod time
    lfh.writeUInt16LE(0x5821, 12);    // mod date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compressedBuf.length, 18);
    lfh.writeUInt32LE(uncompressedBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);         // extra length
    nameBuf.copy(lfh, 30);

    localFileHeaders.push(lfh, compressedBuf);

    // Central directory header (46 bytes + filename)
    const cdh = Buffer.alloc(46 + nameBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(8, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x5821, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compressedBuf.length, 20);
    cdh.writeUInt32LE(uncompressedBuf.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    nameBuf.copy(cdh, 46);

    centralDirHeaders.push(cdh);
    offset += lfh.length + compressedBuf.length;
  }

  const cdBuffer = Buffer.concat(centralDirHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localFileHeaders, cdBuffer, eocd]);
}

/**
 * Extracts entries from a standard ZIP buffer (.xlsx)
 */
function extractZipEntries(zipBuffer) {
  const entries = {};
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= 0; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP / XLSX archive: End of Central Directory not found.');
  }
  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 8);
  let cdPos = zipBuffer.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < totalEntries; i++) {
    if (zipBuffer.readUInt32LE(cdPos) !== 0x02014b50) break;
    const compressionMethod = zipBuffer.readUInt16LE(cdPos + 10);
    const compressedSize = zipBuffer.readUInt32LE(cdPos + 20);
    const fileNameLen = zipBuffer.readUInt16LE(cdPos + 28);
    const extraLen = zipBuffer.readUInt16LE(cdPos + 30);
    const commentLen = zipBuffer.readUInt16LE(cdPos + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(cdPos + 42);
    const fileName = zipBuffer.subarray(cdPos + 46, cdPos + 46 + fileNameLen).toString('utf8');

    const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) {
      entries[fileName] = rawData;
    } else if (compressionMethod === 8) {
      entries[fileName] = zlib.inflateRawSync(rawData);
    }
    cdPos += 46 + fileNameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Generates a multi-sheet Office Open XML (.xlsx) Buffer.
 * @param {Array<{name: string, columns: Array<{key: string, header: string}>, rows: Array<Object>}>} sheets
 * @returns {Buffer}
 */
function writeXlsxBuffer(sheets) {
  const validSheets = (sheets && sheets.length > 0)
    ? sheets
    : [{ name: 'Results', columns: [], rows: [] }];

  const files = [];

  // 1. [Content_Types].xml
  const sheetOverrides = validSheets.map((_, idx) =>
    `<Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join('\n  ');

  files.push({
    name: '[Content_Types].xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheetOverrides}
</Types>`
  });

  // 2. _rels/.rels
  files.push({
    name: '_rels/.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
  });

  // 3. xl/workbook.xml
  const sheetNodes = validSheets.map((s, idx) => {
    const cleanName = escapeXml((s.name || `Sheet${idx + 1}`).replace(/[\[\]\*\/\\\?\:]/g, '_').slice(0, 31));
    return `<sheet name="${cleanName}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>`;
  }).join('\n    ');

  files.push({
    name: 'xl/workbook.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${sheetNodes}
  </sheets>
</workbook>`
  });

  // 4. xl/_rels/workbook.xml.rels
  const wbRels = validSheets.map((_, idx) =>
    `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>`
  ).join('\n  ');

  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${wbRels}
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
  });

  // 5. xl/styles.xml (Style 0 = normal, Style 1 = bold header with dark fill)
  files.push({
    name: 'xl/styles.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1E293B"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  </cellXfs>
</styleSheet>`
  });

  // 6. Worksheets
  validSheets.forEach((sheet, idx) => {
    const cols = sheet.columns && sheet.columns.length > 0
      ? sheet.columns
      : (sheet.rows && sheet.rows.length > 0
          ? Object.keys(sheet.rows[0]).map(k => ({ key: k, header: k }))
          : []);

    const xmlRows = [];

    // Header row (r="1")
    if (cols.length > 0) {
      const headerCells = cols.map((col, cIdx) => {
        const ref = `${colIndexToLetter(cIdx)}1`;
        return `<c r="${ref}" t="inlineStr" s="1"><is><t>${escapeXml(col.header || col.key)}</t></is></c>`;
      }).join('');
      xmlRows.push(`<row r="1">${headerCells}</row>`);
    }

    // Data rows
    const rows = sheet.rows || [];
    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const rowObj = rows[rIdx];
      const rowNum = rIdx + 2;
      const cells = [];
      for (let cIdx = 0; cIdx < cols.length; cIdx++) {
        const key = cols[cIdx].key;
        const val = rowObj[key];
        if (val === undefined || val === null || val === '') continue;
        const ref = `${colIndexToLetter(cIdx)}${rowNum}`;
        if (typeof val === 'number' && Number.isFinite(val)) {
          cells.push(`<c r="${ref}" t="n"><v>${val}</v></c>`);
        } else if (typeof val === 'boolean') {
          cells.push(`<c r="${ref}" t="b"><v>${val ? 1 : 0}</v></c>`);
        } else {
          cells.push(`<c r="${ref}" t="inlineStr"><is><t>${escapeXml(String(val))}</t></is></c>`);
        }
      }
      xmlRows.push(`<row r="${rowNum}">${cells.join('')}</row>`);
    }

    files.push({
      name: `xl/worksheets/sheet${idx + 1}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    ${xmlRows.join('\n    ')}
  </sheetData>
</worksheet>`
    });
  });

  return createZipBuffer(files);
}

/**
 * Parses an Office Open XML (.xlsx) buffer into an array of row objects
 */
function parseXlsxBuffer(buffer) {
  const entries = extractZipEntries(buffer);

  // Parse shared strings if present
  const sharedStrings = [];
  if (entries['xl/sharedStrings.xml']) {
    const ssXml = entries['xl/sharedStrings.xml'].toString('utf8');
    const siRegex = /<si[\s>]([\s\S]*?)<\/si>/g;
    let siMatch;
    while ((siMatch = siRegex.exec(ssXml)) !== null) {
      const inner = siMatch[1];
      const tRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
      let tMatch;
      let text = '';
      while ((tMatch = tRegex.exec(inner)) !== null) {
        text += unescapeXml(tMatch[1]);
      }
      sharedStrings.push(text);
    }
  }

  // Find first worksheet
  const sheetKey = Object.keys(entries).find(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  if (!sheetKey) {
    throw new Error('No worksheet found in XLSX file.');
  }

  const sheetXml = entries[sheetKey].toString('utf8');
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  const rawGrid = [];
  let rowMatch;

  while ((rowMatch = rowRegex.exec(sheetXml)) !== null) {
    const rowContent = rowMatch[1];
    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    const rowCells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      const attrs = cellMatch[1] || '';
      const inner = cellMatch[2] || '';
      const rMatch = /\br="([A-Z]+)\d+"/.exec(attrs);
      const tMatch = /\bt="([^"]+)"/.exec(attrs);
      const colIdx = rMatch ? colLetterToIndex(rMatch[1]) : rowCells.length;
      const cellType = tMatch ? tMatch[1] : 'n';

      let value = null;
      if (cellType === 'inlineStr') {
        const tVal = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(inner);
        value = tVal ? unescapeXml(tVal[1]) : '';
      } else {
        const vVal = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const rawV = vVal ? unescapeXml(vVal[1]) : '';
        if (cellType === 's') {
          const ssIdx = parseInt(rawV, 10);
          value = sharedStrings[ssIdx] !== undefined ? sharedStrings[ssIdx] : rawV;
        } else if (cellType === 'b') {
          value = rawV === '1' || rawV === 'true';
        } else if (cellType === 'str' || cellType === 'e') {
          value = rawV;
        } else {
          const num = Number(rawV);
          value = (rawV !== '' && !Number.isNaN(num)) ? num : rawV;
        }
      }
      rowCells[colIdx] = value;
    }
    rawGrid.push(rowCells);
  }

  if (rawGrid.length === 0) return [];
  const headers = rawGrid[0].map((h, idx) => (h !== undefined && h !== null && String(h).trim() !== '') ? String(h).trim() : `col_${idx + 1}`);
  const result = [];
  for (let i = 1; i < rawGrid.length; i++) {
    const rowArr = rawGrid[i];
    if (!rowArr || rowArr.every(v => v === undefined || v === null || v === '')) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = rowArr[c] !== undefined ? rowArr[c] : null;
    }
    result.push(obj);
  }
  return result;
}

/**
 * Generates UTF-8 CSV string with BOM for full Hungarian Excel compatibility
 */
function toCsv(columns, rows, delimiter = ',') {
  const cols = columns && columns.length > 0
    ? columns
    : (rows && rows.length > 0 ? Object.keys(rows[0]).map(k => ({ key: k, header: k })) : []);

  const escapeCsvCell = (val) => {
    if (val === null || val === undefined) return '';
    const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (str.includes(delimiter) || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [];
  lines.push(cols.map(c => escapeCsvCell(c.header || c.key)).join(delimiter));
  for (const row of (rows || [])) {
    lines.push(cols.map(c => escapeCsvCell(row[c.key])).join(delimiter));
  }
  return '\uFEFF' + lines.join('\r\n');
}

/**
 * Parses CSV string (supports comma or semicolon delimiter, UTF-8 BOM, quoted fields, type coercion)
 */
function parseCsv(csvString) {
  if (!csvString) return [];
  const clean = csvString.replace(/^\uFEFF/, '').trim();
  if (!clean) return [];

  // Auto-detect delimiter from first line
  const firstLineEnd = clean.indexOf('\n');
  const firstLine = firstLineEnd >= 0 ? clean.slice(0, firstLineEnd) : clean;
  const semiCount = (firstLine.match(/;/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const delimiter = semiCount > commaCount ? ';' : ',';

  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const next = clean[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        currentRow.push(currentField);
        currentField = '';
      } else if (ch === '\r' && next === '\n') {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
      } else {
        currentField += ch;
      }
    }
  }
  currentRow.push(currentField);
  if (currentRow.length > 1 || currentRow[0] !== '') {
    rows.push(currentRow);
  }

  if (rows.length < 2) return [];
  const headers = rows[0].map((h, i) => h.trim() || `col_${i + 1}`);
  const records = [];

  for (let r = 1; r < rows.length; r++) {
    const vals = rows[r];
    if (vals.every(v => v.trim() === '')) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      const raw = vals[c] !== undefined ? vals[c].trim() : '';
      if (raw === '') {
        obj[headers[c]] = null;
      } else if (raw === 'true' || raw === 'TRUE') {
        obj[headers[c]] = true;
      } else if (raw === 'false' || raw === 'FALSE') {
        obj[headers[c]] = false;
      } else if (/^-?\d+(\.\d+)?$/.test(raw)) {
        obj[headers[c]] = Number(raw);
      } else {
        obj[headers[c]] = raw;
      }
    }
    records.push(obj);
  }
  return records;
}

module.exports = {
  writeXlsxBuffer,
  parseXlsxBuffer,
  toCsv,
  parseCsv
};
