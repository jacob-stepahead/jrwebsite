// Bundles js/hero/hero.js (+ three.js) into js/hero.min.js.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

await build({
  entryPoints: [here('../js/hero/hero.js')],
  outfile: here('../js/hero.min.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
  nodePaths: [here('./node_modules')],
  legalComments: 'none',
  logLevel: 'info',
});
