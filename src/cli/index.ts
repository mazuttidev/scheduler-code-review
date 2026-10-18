#!/usr/bin/env node
import { existsSync } from 'node:fs';

import { runCli } from './program.js';

// Os tokens vêm do ambiente. Em uso manual, o `.env` do diretório atual os
// fornece; variáveis já definidas têm precedência sobre as do arquivo.
// `NIGHTLY_REVIEW_ENV_FILE` troca o arquivo, como no scripts/nightly.sh.
const envFile = process.env.NIGHTLY_REVIEW_ENV_FILE ?? '.env';
if (existsSync(envFile)) process.loadEnvFile(envFile);

process.exitCode = await runCli(process.argv.slice(2));
