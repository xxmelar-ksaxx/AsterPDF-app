const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const platform = process.argv[2];
  const project = path.join(__dirname, '..');
  const { version } = require(path.join(project, 'package.json'));
  const artifacts = platform === 'win'
    ? [`AsterPDF-${version}-Windows-x64-Setup.exe`]
    : platform === 'mac'
      ? [`AsterPDF-${version}-macOS-arm64.dmg`, `AsterPDF-${version}-macOS-arm64.zip`]
      : null;
  if (!artifacts) throw new Error('Usage: node scripts/write-checksums.cjs win|mac');

  for (const name of artifacts) {
    const file = path.join(project, 'release', name);
    const stats = await fs.stat(file);
    if (!stats.isFile() || stats.size === 0) throw new Error(`Build artifact is missing or empty: ${file}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    const digest = hash.digest('hex');
    const checksumFile = `${file}.sha256`;
    await fs.writeFile(checksumFile, `${digest}  ${name}\n`, 'utf8');
    process.stdout.write(`${path.basename(checksumFile)}: ${digest}\n`);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
