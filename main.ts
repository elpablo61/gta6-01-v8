// Crescent Bay — entry point for the make.fun gta6-01 bounty (Node 22, no
// dependencies beyond the standard library plus the vendored dossier builder).
//
// The playable game is plain static files under game/ (index.html and ES
// modules, fully offline, no network requests). This script gathers the
// entry for the judge: it copies game/ and screenshots/ next to this file
// into the output directory (MAKEFUN_OUTPUT_DIR, default /output) and then
// writes dossier.json there using buildDossier from vendor/makefun-game.ts.
//
// Run it locally with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// Serve the game for playtesting with `node serve.ts` (http://localhost:8080).

import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The dossier must stay comfortably under the scorer's hard cap, so we keep
// our own tighter warning line and shout about it while building.
const DOSSIER_WARN_BYTES = 1_450_000;

mkdirSync(outputDir, { recursive: true });
cpSync(join(repoRoot, 'game'), join(outputDir, 'game'), { recursive: true });
mkdirSync(join(outputDir, 'screenshots'), { recursive: true });
if (existsSync(join(repoRoot, 'screenshots'))) {
  cpSync(join(repoRoot, 'screenshots'), join(outputDir, 'screenshots'), {
    recursive: true,
  });
}

// Caps mirror the scorer's gates (reference/gate.json): at most 4
// screenshots, none over 256 KiB; at most 993 files and 48 MiB under game/;
// no game path longer than 1000 bytes. text_max_bytes is the only cap that
// shapes the dossier bytes; the rest refuse an entry the scorer would refuse.
const dossierPath = join(outputDir, 'dossier.json');
writeFileSync(
  dossierPath,
  buildDossier(outputDir, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);

const dossierBytes = statSync(dossierPath).size;
console.log(`dossier.json: ${dossierBytes} bytes`);
if (dossierBytes > DOSSIER_WARN_BYTES) {
  console.warn(
    `WARNING: dossier is ${dossierBytes} bytes, over the ${DOSSIER_WARN_BYTES} byte budget — shrink the screenshots before submitting.`,
  );
}
