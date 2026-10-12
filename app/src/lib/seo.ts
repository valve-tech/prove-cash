import { LOCALES, pathForLocale, t, type LocaleCode } from './i18n.ts'

/**
 * What a crawler is told about this page, in every language.
 *
 * The problem this solves: the app picks its language at run time, from `localStorage` and then
 * `navigator.languages`. A person gets their own language that way and a search engine never
 * does. Googlebot crawls from one place with `Accept-Language: en` and reports a single English
 * tag in `navigator.languages`, so the run-time picker answers English every time it is asked.
 * Thirty-four translations that only exist after a click are, to a crawler, not on the internet.
 *
 * Three things fix that, and all three are here:
 *
 * 1. **A URL per language.** `pathForLocale` decides them. A search engine indexes URLs, so a
 *    language with no URL of its own has nowhere to be indexed.
 * 2. **The words in the HTML that URL serves.** `scripts/prerender.ts` renders the page to
 *    static markup per locale and puts these tags in its head, so the translation is in the
 *    first response rather than after a bundle, a dictionary fetch and a render.
 * 3. **`hreflang`, on every one of them.** Thirty-five pages that say the same thing in different
 *    languages look like thirty-five thin duplicates until they name each other. The cluster has
 *    to be complete and mutual — each page lists all thirty-five, itself included — or Google
 *    drops the lot. `x-default` names the page for a reader whose language is not on the list.
 *
 * This module is the single source for all of it: the prerender writes the head from `head()`,
 * `sitemap()` writes the same cluster again in the form Search Console reads, and `seo.test.ts`
 * holds `index.html` to `head('en')` so the file Vite serves in development cannot drift from
 * the file the crawler gets.
 */

/** Absolute, because a crawler and a link preview both resolve these outside any page context. */
export const ORIGIN = 'https://prove.cash'

/** The card image. In `public/`, so the URL survives a rebuild. */
const IMAGE = `${ORIGIN}/hero.png`

/** The five characters that end an attribute early or start a tag. */
export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function urlFor(code: LocaleCode): string {
  return ORIGIN + pathForLocale(code)
}

/**
 * The alternates block, identical in all thirty-five pages.
 *
 * `hreflang` takes the registry's own spelling — `zh-Hans`, `pt-BR`, `es-419` — because the
 * attribute is a BCP-47 tag. The path it points at is lower case, because a path is bytes. The
 * two differing is deliberate; see `pathForLocale`.
 */
export function alternates(indent = '    '): string {
  const rows = [`<link rel="alternate" hreflang="x-default" href="${ORIGIN}/" />`]
  for (const l of LOCALES) {
    rows.push(`<link rel="alternate" hreflang="${l.code}" href="${urlFor(l.code)}" />`)
  }
  return rows.map((r) => indent + r).join('\n')
}

/**
 * Everything between the `seo` markers in `index.html`, for one locale.
 *
 * Reads the active dictionary, so the caller sets the locale first. One tag per line and no
 * wrapping: this string is compared to the committed `index.html` character for character, and a
 * reflow would be a failure with nothing wrong behind it.
 */
export function head(code: LocaleCode, indent = '    '): string {
  const title = esc(t('seo.title'))
  const description = esc(t('seo.description'))
  const url = urlFor(code)
  const rows = [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<link rel="canonical" href="${url}" />`,
    '',
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="prove.cash" />',
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:image" content="${IMAGE}" />`,
    '<meta property="og:image:width" content="343" />',
    '<meta property="og:image:height" content="361" />',
    `<meta property="og:image:alt" content="${esc(t('seo.image.alt'))}" />`,
    '',
    // The image is square, so the small card suits it better than the wide one.
    '<meta name="twitter:card" content="summary" />',
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${IMAGE}" />`,
    '',
  ]
  return rows.map((r) => (r ? indent + r : '')).join('\n') + '\n' + alternates(indent)
}

/** The `<html>` tag for a locale. One line, because the prerender replaces it whole. */
export function htmlTag(code: LocaleCode): string {
  const rtl = LOCALES.find((l) => l.code === code)?.rtl
  return `<html lang="${code}"${rtl ? ' dir="rtl"' : ''}>`
}

/**
 * The sitemap: thirty-five URLs, each naming all thirty-five.
 *
 * The `xhtml:link` rows repeat what the pages already carry in their heads. That is not
 * redundancy for its own sake — Search Console reads the cluster from whichever of the two it
 * finds, and a sitemap is the copy it reads first for a site it has not crawled yet.
 */
export function sitemap(): string {
  const links = [
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}/" />`,
    ...LOCALES.map(
      (l) => `    <xhtml:link rel="alternate" hreflang="${l.code}" href="${urlFor(l.code)}" />`,
    ),
  ].join('\n')
  const urls = LOCALES.map(
    (l) => `  <url>\n    <loc>${urlFor(l.code)}</loc>\n${links}\n  </url>`,
  ).join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    urls,
    '</urlset>',
    '',
  ].join('\n')
}
