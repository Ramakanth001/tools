const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { requireToolDep } = require('../requireToolDep');

const archiver = requireToolDep('archiver');

async function zipFolderToFileStream({ folderPath, outZipPath, onProgress }) {
  await fsp.mkdir(path.dirname(outZipPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    let bytes = 0;
    output.on('close', () => resolve({ bytes }));
    output.on('error', reject);
    archive.on('error', reject);

    archive.on('data', (chunk) => {
      bytes += chunk.length;
      if (onProgress) onProgress({ phase: 'zip', bytes });
    });

    archive.directory(folderPath, false);
    archive.pipe(output);
    archive.finalize();
  });
}

module.exports = { zipFolderToFileStream };
