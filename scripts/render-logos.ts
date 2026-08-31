/**
 * Renders the PNG brand assets from the SVG sources in src/images.
 *
 * The PNGs are what everything actually serves — the website header, the link
 * previews, the WhatsApp profile — and they bake the tagline in as pixels. So
 * editing the SVG is only half the change; without this script the old wording
 * keeps shipping from the PNG. Run it after touching any logo SVG:
 *
 *   npx tsx scripts/render-logos.ts
 *
 * Only the tagline-bearing renders are listed. The icons and marks carry no
 * words, so they never go stale and are left alone.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const images = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'images');

interface Render {
  from: string;
  to: string;
  width: number;
  height: number;
  /** Colour swaps applied to the SVG before rendering, for the light variant. */
  swap?: Array<[string, string]>;
}

const RENDERS: Render[] = [
  { from: 'logo-horizontal.svg', to: 'logo-horizontal-1000.png', width: 1000, height: 300 },
  {
    from: 'logo-horizontal.svg',
    to: 'logo-horizontal-light-1000.png',
    width: 1000,
    height: 300,
    // The same wordmark for dark backgrounds: maroon text becomes cream, the
    // tile behind the mark disappears.
    swap: [
      ['fill="#7d0f22"', 'fill="#fdfaf5"'],
      ['<rect width="512" height="512" rx="112" fill="#fdfaf5"/>', ''],
    ],
  },
  { from: 'logo-horizontal.svg', to: 'logo-email-300.png', width: 300, height: 90 },
  { from: 'logo-social.svg', to: 'og-1200x630.png', width: 1200, height: 630 },
  { from: 'logo-social.svg', to: 'twitter-1200x600.png', width: 1200, height: 600 },
];

for (const render of RENDERS) {
  let svg = await readFile(join(images, render.from), 'utf8');
  for (const [find, replace] of render.swap ?? []) svg = svg.split(find).join(replace);

  const png = await sharp(Buffer.from(svg))
    .resize(render.width, render.height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  await writeFile(join(images, render.to), png);
  console.log(`${render.to}  ${render.width}x${render.height}`);
}
