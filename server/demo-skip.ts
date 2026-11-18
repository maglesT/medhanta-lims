// Demo installations only: skips every wait running now in a analysis, or in one of its stages, as the named demo person
// (server/demo.ts). node dist/server/demo-skip.js <analysis no.> [stage] --as <username>
import { demoSkipCommand } from './demo.js';
import { LIMS } from './product.js';

process.exitCode = await demoSkipCommand(LIMS, process.argv.slice(2), process.env);
