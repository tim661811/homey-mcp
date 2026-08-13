#!/usr/bin/env node
// Puts the execute bit back on the compiled bin entry.
//
// TypeScript preserves the shebang but writes the file with the default mode, so
// a freshly built `dist/index.js` is not runnable as `./dist/index.js`. npm sets
// the bit itself when it installs the package, which hides the problem until
// someone runs the built file straight out of a clone.

import { chmodSync, existsSync } from 'node:fs'

const binaryPath = new URL('../dist/index.js', import.meta.url)

if (!existsSync(binaryPath)) {
  process.stderr.write('make-bin-executable: dist/index.js does not exist yet, run the build first\n')
  process.exit(1)
}

chmodSync(binaryPath, 0o755)
