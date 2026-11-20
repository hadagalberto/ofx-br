#!/usr/bin/env node
import { createNodeCliIO, runCli } from './node/cli.js';

process.exitCode = runCli(process.argv.slice(2), createNodeCliIO());
