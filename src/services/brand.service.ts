import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * The brand assets, served from the back-end.
 *
 * Front-ends ask for these rather than bundling their own copies. Three sites
 * carry the MastiPe mark — the marketing page, the admin panel and the game
 * board — and a logo committed into each of them is a logo that is replaced in
 * two of them the day it changes. Serving it from one place means a new file in
 * src/images is live everywhere without a deploy.
 *
 * The manifest is built by reading the folder, not from a hardcoded list, so
 * dropping in a new size needs no code change. Purpose and dimensions are
 * derived from the filename, which is why the generator names them the way it
 * does.
 */

const IMAGES_DIR = resolve(process.env['IMAGES_DIR'] || join(process.cwd(), 'src', 'images'));

/** What each asset is for, so a front-end can pick without guessing. */
const PURPOSE: Array<[RegExp, string]> = [
  [/^favicon-/, 'favicon'],
  [/^apple-touch-icon/, 'apple-touch-icon'],
  [/^icon-maskable/, 'maskable-icon'],
  [/^icon-print/, 'print-master'],
  [/^icon-/, 'icon'],
  [/^whatsapp-profile/, 'whatsapp-profile'],
  [/^mark-/, 'mark'],
  [/^logo-horizontal/, 'wordmark'],
  [/^logo-email/, 'email-signature'],
  [/^og-/, 'open-graph'],
  [/^twitter-/, 'twitter-card'],
  [/^play-feature/, 'feature-graphic'],
  [/^logo-.*\.svg$/, 'vector'],
];

function purposeOf(file: string): string {
  return PURPOSE.find(([re]) => re.test(file))?.[1] ?? 'other';
}

/** Dimensions out of the filename: icon-512 → 512×512, og-1200x630 → 1200×630. */
function sizeOf(file: string): { width: number; height: number } | null {
  const wh = file.match(/(\d+)x(\d+)/);
  if (wh) return { width: Number(wh[1]), height: Number(wh[2]) };
  const square = file.match(/-(\d+)\.(png|jpg|webp)$/);
  if (square) return { width: Number(square[1]), height: Number(square[1]) };
  return null;
}

export interface BrandAsset {
  file: string;
  url: string;
  purpose: string;
  width: number | null;
  height: number | null;
  bytes: number;
}

export interface BrandManifest {
  name: string;
  tagline: string;
  colors: Record<string, string>;
  /** The ones a front-end almost always wants, resolved by name. */
  primary: Record<string, string | null>;
  assets: BrandAsset[];
}

const COLORS = {
  maroon: '#7d0f22',
  maroonDark: '#5c0a19',
  gold: '#f0a202',
  green: '#1f9d55',
  cream: '#f6f3ef',
  ink: '#1e2733',
};

/**
 * Absolute URLs, not paths.
 *
 * The marketing site, the admin panel and an Open Graph crawler are all on
 * different origins from this API, and a crawler fetching og:image will not
 * resolve a relative path against our host.
 */
function urlFor(file: string): string {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${base}${apiImagePath()}/${file}`;
}

export function apiImagePath(): string {
  return `${env.API_BASE_PATH}/public/brand/images`;
}

export function imagesDir(): string {
  return IMAGES_DIR;
}

export async function getBrandManifest(): Promise<BrandManifest> {
  let files: string[] = [];
  try {
    files = (await readdir(IMAGES_DIR)).filter((f) => /\.(png|svg|jpg|webp|ico)$/i.test(f)).sort();
  } catch (err) {
    logger.warn({ err, dir: IMAGES_DIR }, 'brand images folder is missing');
  }

  const assets: BrandAsset[] = [];
  for (const file of files) {
    let bytes = 0;
    try {
      bytes = (await stat(join(IMAGES_DIR, file))).size;
    } catch {
      continue;
    }
    const size = sizeOf(file);
    assets.push({
      file,
      url: urlFor(file),
      purpose: purposeOf(file),
      width: size?.width ?? null,
      height: size?.height ?? null,
      bytes,
    });
  }

  const byName = (name: string): string | null =>
    assets.find((a) => a.file === name)?.url ?? null;

  return {
    name: env.BRAND_NAME,
    tagline: env.BRAND_TAGLINE,
    colors: COLORS,
    // Named rather than picked by size at the call site: which file is "the
    // logo" is a brand decision, and it belongs here rather than repeated in
    // every front-end.
    primary: {
      icon: byName('icon-256.png'),
      iconLarge: byName('icon-512.png'),
      favicon: byName('favicon-32.png'),
      appleTouchIcon: byName('apple-touch-icon-180.png'),
      maskable: byName('icon-maskable-512.png'),
      wordmark: byName('logo-horizontal-1000.png'),
      wordmarkLight: byName('logo-horizontal-light-1000.png'),
      mark: byName('mark-maroon-512.png'),
      markLight: byName('mark-white-512.png'),
      // The one you asked to use wherever a wide banner is needed.
      feature: byName('play-feature-1024x500.png'),
      openGraph: byName('og-1200x630.png'),
      twitter: byName('twitter-1200x600.png'),
      whatsappProfile: byName('whatsapp-profile-640.png'),
      emailSignature: byName('logo-email-300.png'),
    },
    assets,
  };
}
