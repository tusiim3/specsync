#!/usr/bin/env node
// Fail with a clear message on unsupported Node versions (the PDF reader needs 22.13+).
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(`specsync needs Node.js 22.13 or newer; this is ${process.version}. Install a current LTS from https://nodejs.org.\n`);
  process.exit(2);
}

const { main } = await import('./cli.js');
void main();
