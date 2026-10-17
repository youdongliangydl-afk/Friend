import {globSync} from 'node:fs';
import {spawn} from 'node:child_process';
// Model catalogs are configuration, not the loopback/fake inference under test.
// PI_OFFLINE prevents implicit pi.dev refreshes; it does not replace credentials.
const files=globSync(['tests/*.test.ts','packages/*/test/*.test.ts','packages/*/test/v2/*.test.ts']).sort();
const child=spawn(process.execPath,['--import','tsx','--test','--test-concurrency=2',...process.argv.slice(2),...files],{stdio:'inherit',env:{...process.env,PI_OFFLINE:'1'}});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
