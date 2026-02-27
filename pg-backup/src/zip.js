const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');

async function addFolderToZip(zip, folderPath, zipRoot = '') {
  const entries = await fsp.readdir(folderPath, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(folderPath, e.name);
    const rel = path.join(zipRoot, e.name);
    if (e.isDirectory()) {
      await addFolderToZip(zip, abs, rel);
    } else if (e.isFile()) {
      const buf = await fsp.readFile(abs);
      zip.file(rel, buf);
    }
  }
}

async function zipFolderToFile({ folderPath, outZipPath }) {
  const zip = new JSZip();
  await addFolderToZip(zip, folderPath);
  const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await fsp.mkdir(path.dirname(outZipPath), { recursive: true });
  await fsp.writeFile(outZipPath, content);
}

module.exports = { zipFolderToFile };
