import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import electron from 'electron';
const env={...process.env,FRIEND_PI_NODE:process.execPath};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,[resolve('apps/desktop'),...process.argv.slice(2)],{stdio:'inherit',env});
child.on('exit',code=>process.exit(code||0));
