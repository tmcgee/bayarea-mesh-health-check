#!/usr/bin/env node
// Prints the Docker-safe form of the package version, e.g.
//   1.3.8+bayarea.1  ->  1.3.8-bayarea.1
// Docker tags cannot contain '+'. Use this in build/push commands:
//   docker build -t bayarea-mesh-health-check:"$(npm run -s docker:tag)" .

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dockerTag } from '../lib/version.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

process.stdout.write(`${dockerTag(pkg.version)}\n`);
