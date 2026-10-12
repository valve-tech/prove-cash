/**
 * The shape of a spoken-sentence module.
 *
 * `lib/speech.ts` used to glue English words to numbers. Glue does not translate: Turkish puts the
 * denominator first, Japanese writes no space before a counter, and Russian picks one of three
 * nouns from the last two digits of the count. So a locale does not supply words for a sentence
 * this file assembles — it supplies the whole sentence, as a pattern, and keeps the word order.
 *
 * Every field is data. A pattern names its holes with `{name}`, the way a dictionary string does,
 * and `speech.ts` fills them. Nothing here is a function, so a locale module is a plain object that
 * a translator can read and Vite can put in its own chunk.
 *
 * The numbers themselves never appear here. `speech.ts` formats every figure with
 * `Intl.NumberFormat` in the active locale before it reaches a pattern, so a German reader hears
 * `1.234,5` and a translator never has to think about a separator.
 */

/** The four units a countdown is spoken in. Two of them at most, largest first. */
export type DurationUnit = 'second' | 'minute' | 'hour' | 'day'

/**
 * One noun in all the forms its language's plural rules name.
 *
 * The keys are CLDR plural categories, chosen by `Intl.PluralRules` for the active locale — never
 * by a hand-rolled `n === 1`. A language supplies the categories its own rules can return and
 * `other` as the floor: Russian fills `one`, `few` and `many`, Japanese fills only `other`, Arabic
 * fills all six.
 *
 * Each form is a pattern, not a bare noun, so a language whose count word disappears in one form
 * can drop it: Hebrew says `שעתיים` for two hours and never speaks the numeral.
 */
export type Plural = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }

/**
 * The same noun again, in the form one slot of a sentence asks for.
 *
 * Every category is optional, including `other`. A category this leaves out falls back to the
 * matching category of `units`, so a language that inflects one noun at one count writes one line
 * and leaves the other fifteen entries alone.
 */
export type PluralOverride = Partial<Record<Intl.LDMLPluralRule, string>>

/**
 * One slot's worth of overrides: a unit, a category, a phrase. Everything absent falls back.
 *
 * A language whose slot matches its citation form omits the field that holds one of these. A
 * language whose two slots take the same form writes the table once and names it twice — it is a
 * plain object, so a `const` above the module is data and not glue.
 */
export type UnitForms = Partial<Record<DurationUnit, PluralOverride>>

/** Everything one language needs to say about an amount, a countdown and a rate. */
export type SpeechModule = {
  /** A figure whose digits were dropped. `{value}` is the rest of the sentence. */
  approximately: string
  /** A negative figure. `{value}` is the rest of the sentence. */
  minus: string
  /** A figure and its token symbol. `{symbol}` is never translated. */
  amount: string
  /** A countdown that has run out. No numbers in it. */
  noTimeLeft: string
  /**
   * The four unit nouns, in the form a sentence names on its own. `{n}` is the count, already
   * formatted for the locale. This is the citation form: the one a dictionary prints.
   */
  units: Record<DurationUnit, Plural>
  /**
   * The same four, in the form a bare measure of time takes: `{duration} after it opens`,
   * `firm for {duration}`, `longer than {duration}`. No preposition governs the phrase — the
   * sentence names a span or a distance and the phrase carries it.
   *
   * Czech puts an accusative here and says `1 minutu po otevření` where its dictionary says
   * `1 minuta`. Finnish puts the singular in the accusative and leaves the rest partitive:
   * `1 minuutin`, `5 minuuttia`. German changes nothing, because a bare German measure is already
   * the nominative: `2 Tage nach dem Öffnen`.
   */
  unitsMeasure?: UnitForms
  /**
   * The same four, after a preposition meaning *in* or *after*: `expires in {duration}`,
   * `opens in {duration}`.
   *
   * This is the slot German needs and its measure slot does not. `in`, `nach` and `vor` all
   * govern the dative, so German says `in 2 Tagen` here and `2 Tage` there — one language, two
   * requirements, which is why a single adverbial slot could not hold both. Finnish is the same
   * shape in a different case: `kuluttua` governs the genitive at every count, so `5 minuutin
   * kuluttua`, where the measure slot keeps the partitive `5 minuuttia`.
   */
  unitsWithin?: UnitForms
  /**
   * The same four, as the period something lasts or holds: `firm for {duration}`,
   * `now, for {duration}`.
   *
   * Hungarian is the language that makes this its own slot. It marks "for a period" on the noun
   * itself with the terminative `-ig`, at every count — `5 percig`, `1 óráig` — while a bare
   * Hungarian measure stays plain: `5 perc múlva`. Everywhere else this slot happens to agree with
   * the measure slot, so those languages name one table twice.
   */
  unitsSpan?: UnitForms
  /**
   * The same four, after a preposition meaning *ago*: `{duration} ago`.
   *
   * Czech and Slovak reach for the instrumental here — `před 1 minutou`, `před 2 minutami` — and
   * no rewording avoids it, because neither language has an accusative way to say *ago*. Croatian
   * takes the genitive: `prije 1 minute`. Polish, Russian and Ukrainian take the same accusative
   * their other slots take, so they name one table three times. Finnish takes the citation form,
   * because `sitten` governs nothing.
   */
  unitsElapsed?: UnitForms
  /** Two units of a countdown, largest first: `{first}` then `{second}`. */
  joinDuration: string
  /** An exchange rate. `{value}` of `{out}` buys one `{in}`; both symbols stay as they are. */
  rate: string
  /** The pair has no price. Both symbols stay as they are. */
  noRate: string
}
