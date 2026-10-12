/**
 * Every locale dictionary, in one place, so a test cannot quietly check fewer than all of them.
 *
 * `parity.test.ts` built this map inline. A second test that needs every dictionary would have to
 * copy thirty-five imports, and a copy that forgets one does not fail — it passes, having checked
 * thirty-four. That is the silent-skip this repository keeps finding, so the map is a module and
 * both tests import it.
 *
 * Nothing in `src/` outside the tests imports this: the app loads one dictionary at a time, on
 * demand, and pulling all thirty-five into a bundle is the opposite of what `surface.ts` splits
 * them for.
 */
import { type LocaleDict } from './en.ts'
import ar from './ar.ts'
import ca from './ca.ts'
import cs from './cs.ts'
import da from './da.ts'
import de from './de.ts'
import el from './el.ts'
import es419 from './es-419.ts'
import es from './es.ts'
import fi from './fi.ts'
import fr from './fr.ts'
import he from './he.ts'
import hi from './hi.ts'
import hr from './hr.ts'
import hu from './hu.ts'
import id from './id.ts'
import it from './it.ts'
import ja from './ja.ts'
import ko from './ko.ts'
import ms from './ms.ts'
import nb from './nb.ts'
import nl from './nl.ts'
import pl from './pl.ts'
import ptBR from './pt-BR.ts'
import ptPT from './pt-PT.ts'
import ro from './ro.ts'
import ru from './ru.ts'
import sk from './sk.ts'
import sv from './sv.ts'
import th from './th.ts'
import tr from './tr.ts'
import uk from './uk.ts'
import vi from './vi.ts'
import zhHans from './zh-Hans.ts'
import zhHant from './zh-Hant.ts'

export const DICTS: Record<string, LocaleDict> = {
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
  ja,
  ko,
  fr,
  de,
  es,
  'es-419': es419,
  it,
  'pt-BR': ptBR,
  'pt-PT': ptPT,
  nl,
  sv,
  da,
  nb,
  fi,
  ru,
  pl,
  tr,
  ar,
  he,
  th,
  vi,
  id,
  ms,
  hi,
  el,
  cs,
  sk,
  hu,
  ro,
  uk,
  hr,
  ca,
}
