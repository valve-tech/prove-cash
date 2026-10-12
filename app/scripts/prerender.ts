/**
 * One static HTML file per language, written into `dist` after Vite has built it.
 *
 *     npm run build          # tsc, vite, then this
 *     npx tsx scripts/prerender.ts
 *
 * Why this exists is in `src/lib/seo.ts`: a crawler never runs the language picker, so a
 * translation that only appears after a click is a translation no search engine can see. Each
 * page here carries its own words in the first response, its own `lang` and `dir`, its own
 * `<title>` and description, and the whole `hreflang` cluster.
 *
 * **The prerendered markup is a seed, not a hydration target.** `main.tsx` calls `createRoot`,
 * which discards what it finds and renders fresh — deliberately, because the hero card draws a
 * random offer over random days and no two renders of it agree. So a mismatch here is not a
 * hydration bug, and this file's job is to put the right sentences in front of a crawler and the
 * right pixels in front of a reader a few hundred milliseconds before the bundle arrives.
 *
 * **Every module is loaded through Vite, and that is not a preference.** `lib/i18n` holds the
 * active dictionary in a module-level variable, so `setLocale` and the `t()` calls inside the
 * page have to be the same instance of that module. Two loaders means two instances, and the
 * page renders in English while the head says Japanese. Vite is also what compiles the JSX with
 * the automatic runtime and applies the project's own config, which is why the components are
 * not imported at the top of this file.
 *
 * The dapp keeps one URL, `/app`, with no locale in its path. It is behind a wallet and it indexes
 * as nothing, so it gets a bare shell rather than a page: the English head, whose canonical is
 * `/`, and the loading line `Root` shows while the dapp arrives. Without the shell the SPA
 * fallback served `/app` the whole landing page, and a slow phone painted the marketing page
 * again before the dapp replaced it.
 */
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { createServer } from 'vite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as I18n from '../src/lib/i18n.ts'
import type * as Seo from '../src/lib/seo.ts'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(APP, 'dist')

/**
 * The three cuts, and what each one is anchored to.
 *
 * All three are exact strings from `index.html`, and all three are asserted rather than replaced
 * blind. A silent no-op here would ship thirty-five identical English pages that claim in their
 * `hreflang` to be thirty-five languages, which is worse for the site than shipping none.
 */
const OPEN = '<html lang="en">'
const ROOT = '<div id="root"></div>'
const SEO_OPEN = '<!--seo-->'
const SEO_CLOSE = '<!--/seo-->'

async function main(): Promise<void> {
  // Vite's output, so the script and stylesheet tags carry this build's hashes.
  const template = await readFile(join(DIST, 'index.html'), 'utf8')
  for (const marker of [OPEN, ROOT, SEO_OPEN, SEO_CLOSE]) {
    if (!template.includes(marker)) throw new Error(`dist/index.html has no ${marker}`)
  }

  const before = template.slice(0, template.indexOf(SEO_OPEN) + SEO_OPEN.length)
  const after = template.slice(template.indexOf(SEO_CLOSE))

  const vite = await createServer({
    root: APP,
    // No HTTP server and no index.html handling: this asks Vite for modules and nothing else.
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'warn',
  })
  try {
    const i18n = (await vite.ssrLoadModule('/src/lib/i18n.ts')) as typeof I18n
    const seo = (await vite.ssrLoadModule('/src/lib/seo.ts')) as typeof Seo
    const { default: Landing } = (await vite.ssrLoadModule('/src/landing/Landing.tsx')) as {
      default: ComponentType
    }
    const { Booting } = (await vite.ssrLoadModule('/src/Root.tsx')) as { Booting: ComponentType }

    for (const locale of i18n.LOCALES) {
      // The dictionary has to be in place before the tree reads a single string from it. Not
      // remembered: there is no reader here and nothing to remember it for.
      await i18n.setLocale(locale.code, { remember: false })
      const body = renderToString(createElement(Landing))

      const page = (before + '\n' + seo.head(locale.code) + '\n' + after)
        .replace(OPEN, seo.htmlTag(locale.code))
        .replace(ROOT, `<div id="root">${body}</div>`)

      const path = i18n.pathForLocale(locale.code)
      const file = join(DIST, path, 'index.html')
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, page)
      process.stdout.write(`${path.padEnd(11)} ${(page.length / 1024).toFixed(0)} KB\n`)
    }

    // The dapp's shell. It is not in the sitemap and it names no language of its own.
    //
    // `app.html`, not `app/index.html`. Cloudflare serves a directory index only at `/app/`, so it
    // answers `/app` with a 307 there, and every link to the dapp is `/app`. Measured on
    // `wrangler dev`: the directory costs a redirect and the file does not.
    await i18n.setLocale('en', { remember: false })
    const shell = (before + '\n' + seo.head('en') + '\n' + after)
      .replace(OPEN, seo.htmlTag('en'))
      .replace(ROOT, `<div id="root">${renderToString(createElement(Booting))}</div>`)
    await writeFile(join(DIST, 'app.html'), shell)
    process.stdout.write(`${'/app'.padEnd(11)} ${(shell.length / 1024).toFixed(0)} KB\n`)

    await writeFile(join(DIST, 'sitemap.xml'), seo.sitemap())
    process.stdout.write(`\n${i18n.LOCALES.length} pages, sitemap.xml\n`)
  } finally {
    await vite.close()
  }
}

await main()
