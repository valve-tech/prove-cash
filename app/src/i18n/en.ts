/**
 * English, and the shape every other locale answers to.
 *
 * This file loads with the app. Every other dictionary is a dynamic import, so a reader who never
 * opens the picker downloads one language. `Dict` is taken from this object rather than declared
 * on its own, which means a key added here is a key TypeScript knows about everywhere.
 *
 * A key is named after the place it is drawn, not after the sentence it holds. `wallet.none.short`
 * is the two words in the header button; `wallet.none` is the sentence a screen reader gets. When
 * the copy changes the key does not, so a translator sees a changed string rather than a new one.
 *
 * Phase 1 was the chrome: the header, the board's four figures, the filter controls, the empty
 * states, the footer, and the endpoints dialog. Phase 2 is the three views' bodies — the sign
 * form, the board row, the selection tray, the token picker, the tour, the custody ladder and the
 * charts. The spoken sentences in `lib/speech.ts` come later; a screen-reader amount is still
 * built in English and handed to a translated frame. See
 * `docs/specs/2026-08-17-i18n.md`.
 *
 * What never gets translated: token symbols, addresses, hashes, chain names, units, and the route
 * words `board`, `sign`, `mine` and `cleanup`. They are protocol, not copy.
 *
 * **The route words are the URL paths, not the labels.** `/board` is protocol; the word on the
 * nav button is copy and every locale translates it — Libro, Carnet, Panou, ボード, Доска. So is
 * the ordinary noun in `rpc.board.field`. Four separate audits read this paragraph four different
 * ways and it cost real work: six Germanic files kept `board` in the chrome and switched to a
 * native word in exactly six chart strings, so one concept ran under two words across 36 strings,
 * and four CJK/SEA files left a whole label in English while translating the same word one line
 * below it. If a string is rendered to a reader, translate it.
 */

export const en = {
  // The three views. Each icon carries its word twice: `.tip` for a mouse, `.spoken` for a screen
  // reader. They differ only in how they join the count, and both are whole strings because a
  // count glued to a noun does not survive translation.
  'view.board': 'Board',
  'view.board.tip': 'Board · {count} open',
  'view.board.spoken': 'Board, {count} open',
  'view.sign': 'Sign an offer',
  'view.mine': 'Mine',
  'view.mine.tip': 'Mine · keeping {count} alive',
  'view.mine.tip.reposts': 'Mine · keeping {count} alive · {reposts} re-posts',
  'view.mine.spoken': 'Mine, keeping {count} alive',
  'view.mine.spoken.reposts': 'Mine, keeping {count} alive, {reposts} re-posts',
  // The fourth view: exclusive quotes. "Quotes" is the noun a trading desk uses for a price
  // named for one client, and it is what this view holds — not the public book next door.
  'view.rfq': 'Quotes',
  'view.rfq.tip': 'Quotes · {count} for you',
  'view.rfq.spoken': 'Quotes, {count} for you',

  // The header.
  'header.skip': 'Skip to content',
  'header.home': 'prove.cash home',
  'header.views': 'Views',
  'header.network': 'Network',
  'header.endpoints': 'Endpoints: {health} — {hosts}. Bring your own node.',
  'header.endpoints.tip': 'Endpoints — {health} · {hosts}',
  'header.endpoints.custom': 'custom',
  'header.tour': 'How it works',

  // The wallet button. The short strings sit in a 7rem button; the long ones are what a screen
  // reader hears. "No wallet" means this browser has no wallet extension, not that the wallet is
  // empty — keep that distinction in every language.
  'wallet.connected': 'Wallet connected: {address}',
  'wallet.connect': 'Connect wallet',
  'wallet.connect.short': 'Connect',
  'wallet.none': 'No wallet found in this browser',
  'wallet.none.short': 'No wallet',

  // How the board itself is doing. "not accepting posts" is a board that answers but is closed for
  // writing; "unreachable" is a board that does not answer at all.
  'board.live': 'board live',
  'header.settings': 'Settings',
  'header.endpoints.throttled': 'chain reads throttled',
  'board.unreachable': 'board unreachable',
  'board.closed': 'board not accepting posts',
  // Before the first answer. Not a claim about the board: we have not heard from it yet.
  'board.checking': 'checking the board',

  // The page's own heading, one per view. It is drawn for nobody and read by everybody using a
  // screen reader, so it is the first sentence the app says. `prove.cash` is the app's name and
  // stays as it is in every language; the words after the dash are the ones that translate.
  'page.board': 'prove.cash — the board of signed swap offers',
  'page.sign': 'prove.cash — sign a swap offer',
  'page.mine': 'prove.cash — your signed offers',
  'page.cleanup': 'prove.cash — cleanup for {address}',
  'page.rfq': 'prove.cash — exclusive quotes',

  // What a screen reader hears when the board changes. Nothing in it ticks, so it speaks on news
  // and stays quiet the rest of the time. One offer gets its own sentence rather than a plural
  // suffix glued on, the same way `batch.fill.one` and `batch.fill.many` do it.
  'board.news.error': 'Board error: {error}',
  'board.news.loading': 'Loading the board',
  'board.news.open.one': '1 open offer on the board',
  'board.news.open.other': '{count} open offers on the board',

  // The offers table's name. The board is a CSS grid carrying table roles, and this is the only
  // thing that tells a screen reader what the table holds.
  'board.table': 'Signed swap offers',

  // The language picker.
  'language.label': 'Language: {language}',
  'language.search': 'Search languages',
  'language.list': 'Languages',
  'language.none': 'No language matches',

  // The board's four figures. "notional" is the total value on offer; "profit on table" is what an
  // executor could take right now, not what a maker earns.
  'stat.open': 'open intents',
  'stat.notional': 'notional',
  'stat.profit': 'profit on table',
  'stat.profitable': 'profitable',
  'stat.profitable.value': '{count} of {total}',
  'stat.unknown': 'not known',
  'stat.profit.spoken': 'plus {amount}',
  // A caption above the four figures, shown only under a token filter. It says the figures count
  // the filtered offers, not the whole board. Same arrow words as `filter.dir.*`.
  'stat.for.into': 'Figures for offers into {symbol}',
  'stat.for.out': 'Figures for offers out of {symbol}',
  'stat.for.either': 'Figures for offers into or out of {symbol}',

  // The filter row. The three short words are button faces and share a row, so they stay short.
  'filter.scope.group': 'Which offers to show',
  'filter.scope.open': 'open',
  'filter.scope.all': 'all',
  'filter.scope.open.label': 'Show open offers only, live and fillable',
  'filter.scope.all.label': 'Show all offers, including expired history',
  'filter.scope.open.tip': 'Live and fillable',
  'filter.scope.all.tip': 'Include expired history',
  'filter.sort.group': 'Sort offers by',
  'filter.sort.spread': 'spread',
  'filter.sort.expiry': 'expiry',
  'filter.sort.size': 'size',
  'filter.sort.label': 'Sort by {sort}',
  // The token filter. A board row reads `A → B`: the maker gives A and wants B. The filter's words
  // follow that arrow, and each one says where the chosen token sits in the row:
  //
  //   into X     X comes AFTER the arrow. It is the token the maker wants.
  //   out of X   X comes BEFORE the arrow. It is the token the maker gives.
  //
  // Read them only from the arrow: "into" is the token the arrow points at, "out of" is the one it
  // leaves. Do not translate them as buy or sell, or as receive or pay. Those words need a subject,
  // and the maker and the taker would each read them the other way round. Many languages use a
  // different preposition for each; choose the pair that says movement toward a thing and away
  // from it. "Before" and "after" are in reading order: in Arabic and Hebrew the arrow points
  // left, so "after the arrow" is to the left of it.
  'filter.token': 'Filter by token',
  // The menu's first entry, and its face when no token is chosen.
  'filter.token.all': 'every token',
  // Beside each token in the menu: how many open offers name it, on either side of the arrow.
  'filter.token.open': '{count} open',
  // A button in the empty state. It removes the token filter and nothing else.
  'filter.token.clear': 'Show every token',
  // Names the three direction buttons for a screen reader.
  'filter.dir.group': 'Which side of the arrow {symbol} is on',
  // The three button faces. One or two words each: they sit beside the token menu on a phone.
  'filter.dir.into': 'into',
  'filter.dir.out': 'out of',
  'filter.dir.either': 'either',
  // What each button does. A tooltip, and the description a screen reader reads after the face.
  'filter.dir.into.tip': 'Show offers where the maker wants {symbol}: after the arrow',
  'filter.dir.out.tip': 'Show offers where the maker gives {symbol}: before the arrow',
  'filter.dir.either.tip': 'Show offers with {symbol} on either side of the arrow',
  'filter.profitable': 'profitable only',

  // The archive strip, at the end of the filter row. The count line is one sentence in four
  // shapes, because the total and the oldest date are each either known or not. Four whole
  // sentences rather than clauses glued together: ` of {total}` after `archive {loaded}` fixes an
  // English word order on every language, and the date has to be free to move.
  'archive.tip': 'Archived posts verify locally, like live ones. The book keeps 30 days past expiry.',
  'archive.unreachable': 'archive unreachable',
  'archive.loading': 'archive …',
  'archive.count': 'archive {loaded}',
  'archive.count.total': 'archive {loaded} of {total}',
  'archive.count.since': 'archive {loaded} · since {date}',
  'archive.count.total.since': 'archive {loaded} of {total} · since {date}',
  // The button's face is one word at the end of a crowded row; `.spoken` is what it means.
  'archive.more': 'older',
  'archive.more.spoken': 'older archived offers',
  'archive.more.loading': 'loading…',

  // Nothing to show.
  'empty.board': 'The board is quiet.',
  // "The board is quiet." used to cover a board that did not answer, too.
  'empty.board.unreachable': 'The board did not answer. Offers may still be there.',
  // A chain the registry carries with no settlement behind it. The board is not quiet here and it
  // is not unreachable: there is nowhere to settle, so an offer on it could never be filled. The
  // list is withheld rather than drawn, because a row a reader can select is an offer we are
  // inviting them to take. Same `{network}` the footer and the sign form name.
  'empty.board.off': 'The contracts are not live on {network} yet. Nothing can fill an offer here, so the board stays closed.',
  'empty.profitable': 'Nothing profitable right now.',
  // The empty state under a token filter. It names the filter, because "The board is quiet." would
  // say the whole board is empty when only this token is. Same arrow words as `filter.dir.*`.
  'empty.token.into': 'No offers into {symbol}.',
  'empty.token.out': 'No offers out of {symbol}.',
  'empty.token.either': 'No offers into or out of {symbol}.',
  // The same, when the token has offers but "profitable only" hides every one of them.
  'empty.token.profitable.into': 'Nothing profitable into {symbol} right now.',
  'empty.token.profitable.out': 'Nothing profitable out of {symbol} right now.',
  'empty.token.profitable.either': 'Nothing profitable into or out of {symbol} right now.',
  'empty.sign': 'Sign an intent',

  // The footer. Three short labels with glyphs; the `.aria` keys keep the longer sentences a
  // screen reader should still hear. `{board}` is the msgboard name — untranslated — so a
  // language that wants it first can move the placeholder.
  'footer.about': 'About this app',
  'footer.shared': 'intents shared over {board}',
  'footer.shared.aria': 'signed swap intents shared over {board}',
  'footer.how': 'how',
  'footer.how.aria': 'how it works',
  // Opens our SimpleX contact address. It takes bug reports and security holes alike, so the
  // spoken name still says "bug", the word a visitor with either one will look for.
  'footer.report': 'report',
  'footer.report.aria': 'report a bug',
  // Beside the disabled sign button, where the reason belongs.
  'sign.off.network': 'Signing opens on {network} when the contracts go live. Try it on testnet now.',
  'footer.settlement.missing': 'The contracts are not live on {network} yet. You can browse, but not sign.',

  // The endpoints dialog. "board endpoint" wants a node carrying the msgboard_ module; "chain
  // endpoint" is any node that answers eth_ reads. Locked means one URL drives both.
  'rpc.title': 'Endpoints',
  'rpc.link.label': 'Use one URL for both endpoints',
  'rpc.locked': 'locked · one URL',
  'rpc.unlocked': 'unlocked · two URLs',
  'rpc.locked.tip': 'One URL drives both. Unlock for two.',
  'rpc.unlocked.tip': 'Two independent URLs. Lock to couple them.',
  // `board` in these keys is the ordinary noun, not the `/board` route. Translate it, the same
  // way the nav label is translated. Four CJK/SEA files left a whole label in English here while
  // translating the same word one line below it.
  'rpc.board.field': 'board endpoint',
  'rpc.chain.field': 'chain endpoint',
  // `{prefix}` is the literal `msgboard_`, and it is a placeholder so the component can isolate
  // it. The underscore is a neutral character: the moment the word beside it is translated into
  // Hebrew or Arabic, the underscore takes the paragraph direction and paints on the far side of
  // the token, so the reader is shown `_msgboard` for a prefix they have to type into a config
  // field. Keep the placeholder, and put it where your language wants it.
  'rpc.board.hint': '{prefix} module',
  'rpc.chain.hint': 'eth_ reads · balances, quotes',
  'rpc.check': 'Check',
  'rpc.checking': 'Checking…',
  // `{kind}` in the two labels below is one of these two words, translated. Interpolating the raw
  // `EndpointKind` would drop an English noun into the middle of a translated sentence.
  'rpc.kind.board': 'board',
  'rpc.kind.chain': 'chain',
  'rpc.check.label': 'Check the {kind} endpoint',
  'rpc.reset': 'Default',
  'rpc.reset.label': 'Reset the {kind} endpoint to the default',
  'rpc.save': 'Use these endpoints',
  'rpc.demo': "The default is valve.city's demo key, rate limited. Your own node is faster.",
  'rpc.bad': 'Not usable: {text}',
  'rpc.board.ok': 'msgboard live · {count} messages',
  'rpc.board.disabled': 'node reachable, board disabled',
  'rpc.board.missing': 'no msgboard_ module at this URL',
  'rpc.chain.ok': 'chain {id} · block {block}',
  'rpc.chain.wrong': 'answers chain {id} — expected {expected}',
  'rpc.chain.missing': 'no eth_ answer at this URL',

  // ── The sign form ─────────────────────────────────────────────────────────────────────────
  // "You give, at most" and "You want at least" are a promise, not a quote: the maker never pays
  // more than the first and never receives less than the second. Keep the bound in both.
  'sign.title': 'Sign a swap offer',
  'sign.give': 'You give, at most',
  'sign.want': 'You want at least',
  // The maker types one number and it is their floor, decay or no decay. `sign.want.start` labels
  // the other end of the curve — where the offer opens, which the form computes from the pool
  // rather than asking for. It used to label a second field, and that field asked the maker to
  // invent a number below the one they had already called their minimum.
  'sign.want.start': 'You want at least, at the start',
  // The two sides of the swap, as one word each. They land inside the two labels below.
  'sign.side.give': 'give',
  'sign.side.receive': 'receive',
  'sign.token.change': '{side} token: {symbol}. Change it.',
  'sign.token.choose': 'Choose the {side} token',
  'sign.token.select': 'Select',
  'sign.amount.in': '{label}, in {symbol}',
  // "separator", not "point". The field accepts a comma and normalises it, so a locale that
  // writes its decimals with a comma must not be told to type a full stop.
  'sign.amount.digits': 'Enter digits and at most one decimal separator.',
  'sign.amount.zero': 'Enter an amount above zero.',
  'sign.amount.decimals': 'This token holds {count} decimal places. Shorten the amount.',
  // `bal` is the four-character face of the balance; `sign.balance` is what a screen reader hears.
  'sign.balance.short': 'bal {amount}',
  'sign.balance': 'Balance {amount}',
  'sign.max': 'max',
  'sign.max.label': 'Use the whole balance',
  'sign.flip.label': 'Swap the two tokens around',
  'sign.flip.tip': 'Swap direction',
  // The floor is the worst rate the maker will accept. Not a target, not an estimate.
  'sign.floor.spoken': 'Your floor: at least {rate}',
  'sign.terms.label': 'Offer terms: {duration}, {partial}, {decay}',
  'sign.partial.ok': 'partial ok',
  'sign.partial.none': 'all or nothing',
  'sign.partial.toggle': 'Allow partial fills',
  'sign.decay.on': 'decaying',
  'sign.decay.off': 'fixed',
  'sign.decay.toggle': 'Open above your minimum and decay to it',
  /*
   * The shape of the fall: where inside the window the price moves, and where it sits still.
   *
   * The control is two handles on the line itself, so these words are a read-out and a label, not
   * an explanation. `sign.fall.open` and `sign.fall.close` are the two ends of the window, and
   * they appear as faces beside the handles — keep them to one short word each, because they sit
   * in a row about eight characters wide on a 375px screen.
   */
  'sign.fall': 'falls',
  'sign.fall.open': 'open',
  'sign.fall.close': 'close',
  'sign.fall.from': 'When the price starts falling',
  'sign.fall.to': 'When the price reaches your floor',
  // What a screen reader hears in place of a handle's position. `{duration}` is a phrase that is
  // already inflected and already agreed with its own count, so it goes in whole.
  'sign.fall.atOpen': 'when the offer opens',
  'sign.fall.atClose': 'when the offer expires',
  'sign.fall.after': '{duration} after it opens',
  // The same two instants, on the collapsed form. It appears only once the shape leaves the
  // straight line, the way the fee row appears only once the fee leaves its default. `{from}`
  // and `{to}` are the phrases above, already inflected, so they go in whole.
  'sign.fall.label': 'The price starts falling {from} and reaches your floor {to}. Change it.',
  'sign.custody': 'custody',
  'sign.custody.label': 'Custody: {mode}. {where} Change it.',
  'sign.expires': 'expires',
  'sign.expires.group': 'Expires after',
  'sign.expires.label': 'Expires after {duration}',
  'sign.expires.tooLong': '{duration}, and past {max} revoking your approval will not cancel this offer.',
  'sign.expires.tooLong.tip': 'This works. Past an hour, only Cancel ends the offer — revoking your approval does not.',
  'sign.window.note':
    'A longer window is a longer commitment. The offer stays fillable until it expires.',
  // ── When the offer opens ──────────────────────────────────────────────────────────────────
  // The chain has always taken a start time and this form has always sent "now". These strings
  // are the control that lets a maker move it, and the two refusals it can produce.
  //
  // `{max}` and `{duration}` both arrive from `spokenDuration`, already agreed with their own
  // count in the reader's language. Place them; do not put an article or a numeral in front.
  'sign.opens': 'opens',
  'sign.opens.group': 'Opens after',
  'sign.opens.now': 'now',
  'sign.opens.nowLabel': 'Opens as soon as it is posted',
  'sign.opens.label': 'Opens in {duration}',
  // A wallet offer is armed by an approval this protocol cannot see revoked, so the contract
  // bounds how far ahead it may open as well as how long it may run.
  'sign.opens.tooFar': 'Opening in {duration}, and past {max} revoking your approval will not cancel this offer.',
  'sign.opens.tooFar.tip': 'This works. Past an hour, only Cancel ends the offer — revoking your approval does not.',
  'sign.opens.zombie': 'This rests longer than {max} on {mode} custody. Revoking your approval will stop it filling but will not cancel it, so approving that token again later brings this signature back. Cancel is the only thing that ends it.',
  'sign.opens.note': 'The offer rests until it opens. The price starts falling only after that.',
  // ── When the authorization opens ──────────────────────────────────────────────────────────
  // The second window, and the reason this rung is worth choosing. An EIP-3009 authorization
  // funds the reservation at fill time, so a scheduled offer commits nothing while it waits.
  'sign.funds': 'funds from',
  'sign.funds.group': 'The authorization opens after',
  'sign.funds.nowLabel': 'The authorization opens immediately',
  'sign.funds.label': 'The authorization opens in {duration}',
  'sign.funds.note':
    'Your tokens stay in your wallet until the authorization opens, and the token itself refuses a fill before then. Escrow takes them the moment you deposit.',
  // The near miss. Legal on chain, and it costs the maker the top of their own curve.
  'sign.funds.stranded':
    'The authorization opens {duration} after the offer does. The price falls for that whole time and nobody can fill it.',
  // The dead offer. Nothing on chain refuses this, so this form does.
  'sign.funds.dead':
    'Nothing can ever fill this offer. The authorization opens in {duration}, and the offer is gone by then. The chain accepts it and every fill fails for a reason that names something else.',
  // The intersection, in one line: the only seconds this offer is worth anything in.
  'sign.live': 'fillable',
  'sign.live.now': 'now, for {duration}',
  'sign.live.in': 'in {time}, for {duration}',
  'sign.live.never': 'never',
  'sign.need.schedule': 'Fix the schedule',
  // Where the fee goes. An offer signs one fee config: a bytes32 hash of up to eight destinations
  // and their weights, plus three rates (handover, output, proceeds). The chain's defaults supply
  // the config and the first two rates; the maker's own rate is the proceeds one, taken out of
  // their number. The settlement never calls a destination: it reserves the fee under the hash and
  // anyone may `claim` it out to the destinations by weight. A destination's own name comes from
  // the SDK registry, not from here.
  'sign.fee': 'fee goes to',
  'sign.fee.group': 'Where the fee goes',
  'sign.fee.label': 'The fee config this offer signs, and your rate. Change the rate.',
  // The defaults the offer signs. `{rate}` is a percentage; `{where}` is a destination's name or short
  // address.
  'sign.fee.default': 'The default fee is {rate}%, to {where}. Your offer signs it, and nobody can change it after you sign.',
  'sign.fee.unread': 'The default fee could not be read from the chain, so this offer cannot be signed yet.',
  // The chain's default is a config this build does not ship: shown with its destinations, and
  // signed only after the maker accepts them. A warning about the config, never about a rate.
  'sign.fee.changed': 'The chain\'s fee default is a config this app does not ship. Read its destinations above and accept them to sign.',
  'sign.fee.ack': 'I have checked these destinations',
  // The fee defaults warn line: a rate above it still signs; the chain takes any rate up to 100%.
  'sign.fee.warn': 'This rate, {rate}%, is above the {warn}% that the fee defaults flag as high. You can still sign it.',
  'sign.need.fee': 'Fix the fee',
  'sign.fee.note':
    'The fill pays one number, and the settlement splits it: you take your amount, and your share of the fee is reserved for the destinations of the fee config above. You sign a number big enough to cover both, so you still receive what you typed. Your rate costs you that share and nothing else. The other two take points of the config are paid by the executor, not by you.',
  // The three numbers a rate produces, as a small table under the rate field. `{where}` is the
  // destination's own name or its short address — a name, so it is not translated.
  'sign.split.receive': 'you receive',
  'sign.split.signed': 'the offer signs for',
  'sign.split.fee': 'of that, to {where}',
  // The rate this offer charges, beside the fee config it pays into. A percentage on screen; a fraction of
  // one ether on the wire. Empty is zero. `{max}` is the form's own ceiling, not the
  // chain's; the chain's only bound is one hundred per cent for each rate.
  'sign.rate': 'charging',
  'sign.rate.invalid': 'A percentage, at most {max}',
  // The other ceiling, and it is the chain's rather than this form's. At one hundred per cent the
  // fee is the whole payment and the maker banks nothing; above it their share underflows, so
  // `_termsOk` refuses the intent and every solver steps over it. An offer signed above it is
  // dead the moment it is made, and only this form can say so before the signature.
  'sign.rate.refused':
    'A percentage, at most {cap}. The settlement itself refuses {max} or more, where the fee takes the whole fill and you receive nothing.',
  // The button's face, phase by phase. Each one says what the app is waiting for.
  'sign.phase.signing': 'Waiting for signature…',
  'sign.phase.authorizing': 'Waiting for authorization signature…',
  'sign.phase.approving': 'Approving…',
  'sign.phase.depositing': 'Depositing to escrow…',
  'sign.phase.posting': 'Posting to the board…',
  'sign.need.tokens': 'Pick two tokens',
  'sign.need.amounts': 'Enter amounts',
  'sign.go': 'Sign and broadcast',
  'sign.go.twice': 'Sign twice and broadcast',
  'sign.go.escrow': 'Sign, escrow, broadcast',
  'sign.cancel': 'Cancel',
  'sign.tries': '{count} tries',
  'sign.done.spoken': 'Your offer is on the board.',
  'sign.done.short': 'on the board · {hash}',
  'sign.done.hash': 'On the board, message hash {hash}.',
  'sign.done.alive': 'this tab keeps it alive',
  'sign.board.closed': 'The board is not accepting posts.',
  'wallet.failed': 'Could not connect a wallet.',
  // Two wallet extensions have taken the same slot in the browser and neither one answers now.
  // Say what to do about it. The engine's own words for this are "'get' on proxy: property 'on'
  // is a read-only and non-configurable data property", and nobody can act on that.
  'wallet.conflict': 'Two wallet extensions are in conflict. Turn one off and reload the page.',
  // What the page says when a render, an effect or a click throws and nothing else caught it.
  // The alternative is a white screen, which is what production showed.
  'crash.lead': 'Something on this page stopped working. Reload the page to start again.',

  // ── Custody: where the maker's tokens sit while the offer is live ─────────────────────────
  // The three `where` labels are the money-safety line of the whole app. "in escrow" is the
  // contract holding them; "funded at fill" is one signature moving them at the moment of the
  // fill; "in wallet" means they are still the maker's to spend, so the offer can go unfunded.
  //
  // All three are past participles describing where the tokens ARE, never verbs describing what
  // the app does. The old `funds at fill` read both ways and the locales split four to four,
  // half of them promising the app would fund something. It sits between two unambiguous
  // phrases, so match them.
  'custody.group': 'Custody: where your tokens sit while the offer is live',
  'custody.where.escrow': 'in escrow',
  'custody.where.fill': 'funded at fill',
  'custody.where.wallet': 'in wallet',
  'custody.where.escrow.spoken': 'The tokens sit in escrow.',
  'custody.where.fill.spoken': 'The tokens leave your wallet at the moment of the fill.',
  'custody.where.wallet.spoken':
    'The tokens stay in your wallet, and you can spend them elsewhere.',
  // The four rungs. Each names its mechanism: an EIP-3009 authorization, a contract escrow, an
  // EIP-2612 permit, an ERC-20 approval.
  'custody.mode.authorization': 'authorization',
  'custody.mode.escrow': 'escrow',
  'custody.mode.permit': 'permit',
  'custody.mode.permit2': 'permit2',
  'custody.mode.approval': 'approval',
  'custody.cost.signatures': '2 signatures · 0 tx',
  // `{count}` is a bare figure — `1`, `2`, `1–2`, `≤1` — and `tx` beside it is the abbreviation
  // a trader reads in a compact row. The SPOKEN keys below carry a whole noun phrase instead,
  // and they use a different placeholder name for that reason: `{tx}` used to be both, so a
  // translator had no way to tell which one a key was going to be handed.
  'custody.cost.signatures.tx': '2 signatures · {count} tx',
  'custody.cost.signature': '1 signature · {count} tx',
  'custody.exit.none': 'out 0 tx',
  'custody.exit.one': 'out 1 tx',
  'custody.tx.none': 'no transaction',
  'custody.tx.one': 'one transaction',
  'custody.tx.two': 'two transactions',
  'custody.tx.upto': 'at most one transaction',
  'custody.tx.oneOrTwo': 'one or two transactions',
  'custody.spoken.authorization':
    'Two signatures and no transaction to sign. No transaction to get out.',
  // `{transactions}` arrives as a whole noun phrase — "one transaction", "two transactions" —
  // already agreed with its own count by `custody.tx.*`. Put it where your language accepts one;
  // do not write an article or a numeral in front of it.
  'custody.spoken.escrow':
    'One signature and {transactions} to sign. One transaction to get out, whenever you like, and that ends the offer.',
  'custody.spoken.permit':
    'Two signatures and no transaction to sign. No transaction to get out, because nothing is held.',
  'custody.spoken.permit2':
    'Two signatures and at most one transaction: an approval you give once and never again. No transaction to get out, because nothing is held.',
  'custody.spoken.approval':
    'One signature and {transactions} to sign. No transaction to get out, because nothing is held.',
  // Why a rung cannot be climbed, in the two words the label slot holds.
  'custody.lock.deploy': 'on deploy',
  'custody.lock.no3009': 'no eip-3009',
  'custody.lock.no2612': 'no eip-2612',
  'custody.locked': '{name}, not available: {reason}',
  'custody.rung.label': '{name}. {where} {cost}',

  // ── Mine: what this wallet has signed, and how to undo it ─────────────────────────────────
  // "withdraw" takes escrowed money back and ends the offer in one call. "cancel" ends an offer
  // the contract holds nothing against. They are not interchangeable words.
  'mine.title': 'Your signed offers',
  'mine.locked': 'Your intents live behind your wallet.',
  'mine.none': 'No intents from this wallet.',
  'mine.clean': 'Nothing to clean up.',
  'mine.cleanup.title': 'Cleanup for {address}',
  'mine.cleanup.note': 'What {address} left open.',
  'mine.cleanup.readonly': 'Only that wallet can act.',
  'mine.table.cleanup': 'Offers to clean up',
  'mine.escrow.lead': 'Escrow comes back in one transaction.',
  'mine.escrow.body':
    'No unlock step and no waiting, and it ends the offer at the same time — the deposit is what armed it, so taking the money back takes the offer with it.',
  'mine.wallet.lead': 'An offer in your wallet needs a cancel.',
  'mine.wallet.body':
    'Nothing is held, so there is nothing to withdraw. A cancel is a transaction and it bites on the block it lands. Taking the post off the board is not a cancel — the signature outlives the post, and an executor may already hold a copy.',
  'mine.copy': 'copy cleanup link',
  'mine.copied': 'copied',
  'mine.copy.label':
    'Copy a cleanup link for this wallet. It opens whatever this wallet still has to withdraw or cancel.',
  'mine.copy.tip': 'A link to whatever this wallet still has to withdraw or cancel',
  'mine.clipboard.failed': 'The browser refused the clipboard.',
  'mine.col.pair': 'pair',
  'mine.col.size': 'size',
  'mine.col.custody': 'custody',
  'mine.col.reserved': 'reserved',
  'mine.col.action': 'action',
  'mine.col.escrow': 'escrow',
  'mine.pair': '{in} to {out}',
  'mine.where.escrow': 'the contract holds them',
  'mine.where.fill': 'they leave your wallet at the fill',
  'mine.where.wallet': 'you can still spend them elsewhere',
  'mine.reserved.none': 'nothing reserved',
  'mine.reserved.reading': 'reading the escrow',
  'mine.reserved.of': 'of {amount}',
  'mine.reserved.spoken': '{amount} reserved out of {total}',
  'mine.withdraw': 'withdraw',
  'mine.cancel': 'cancel',
  'mine.withdraw.label':
    'Withdraw the escrow on {pair}. One transaction, no waiting. It ends the offer too, and nobody can fund it again.',
  'mine.cancel.label':
    'Cancel the offer on {pair}. One transaction, and it bites on the block it lands.',
  'mine.withdraw.tip': 'One transaction, no waiting. It ends the offer too.',
  'mine.cancel.tip': 'One transaction. It bites on the block it lands.',
  'mine.withdraw.failed': 'withdraw failed',
  'mine.cancel.failed': 'cancel failed',
  'mine.notDeployed': 'not deployed',
  'mine.funds.fill': 'funds move at fill',
  'mine.nothing.held': 'nothing held',

  // ── The bulk off switch ───────────────────────────────────────────────────────────────────
  //
  // One transaction ends many offers, and the reason it beats one cancel each is not the gas. A
  // cancel takes the whole signed offer back, so fifty cancels need fifty of them, and a maker
  // who cleared their browser holds none. This compares a number, so it needs none. Keep that
  // sentence — it is the point of the feature.
  //
  // Two costs, and neither may be softened. The number ends EVERY offer below it, so a maker
  // cannot keep an older one, and it reaches offers this device never saw. And it returns no
  // money on its own: the deposit rests in the contract until somebody moves it into the capital
  // resting here, which is one more transaction per token.
  //
  // Keep the word you chose for "resting here" in `mine.parked.*`. The maker has to see that the
  // money the switch leaves behind and the money in the table below are the same money.
  //
  // `mine.retire.label` names a button that OPENS the list. It sends nothing, and it must not
  // read as though it does. `mine.retire.confirm` is the button that sends.
  'mine.retire': 'turn every offer off',
  'mine.retire.label':
    'Show every offer one transaction would end. Nothing is sent until you confirm.',
  'mine.retire.tip': 'One transaction ends every offer listed. Nothing brings one back.',
  'mine.retire.lead': 'One transaction ends these offers.',
  'mine.retire.body':
    'It raises the number this contract measures your offers against, and every offer below it stops being fillable. You do not need the offers themselves to send it — that is what makes it one transaction instead of one for each. It ends every offer you signed below that number, including any this device never saw, and nothing brings one back. Your escrow is not lost: anybody may then move a dead offer’s deposit into the capital resting here, and one withdrawal per token takes it home.',
  'mine.retire.confirm': 'yes, end these offers',
  'mine.retire.back': 'keep them',
  'mine.retire.spared':
    'These offers stay live. The number covers one group of offers and these were signed outside it, so cancel each one on its own row.',
  'mine.retire.failed': 'ending the offers failed',

  // ── Capital resting here, and the property a maker lost to it ─────────────────────────────
  //
  // A vocabulary note, because three things in this view are money and they are not the same
  // money. "reserved" is what the contract holds against ONE offer. "resting here" is the
  // maker's own capital inside the contract that belongs to no offer at all — the chain calls it
  // parked. "in your wallet" is everything else. Pick one word per idea in your language and
  // hold it across all six keys below; a reader who cannot tell the three apart cannot tell
  // whether their money moved.
  //
  // The hazard paragraph is not decoration and it must not become a tooltip. Until this landed,
  // an escrow offer a maker signed and never funded could never fill: only a transaction from
  // them changed that, and "I just will not deposit" was a real off switch. It is gone. Any
  // solver may now fund such an offer out of capital freed from another of that maker's dead
  // offers, at a moment the solver picks, with no action by the maker. Translate it plainly. Do
  // not soften it, and do not make it frightening either — the money is only ever the maker's,
  // and cancelling still works.
  'mine.parked.title': 'Capital resting here',
  'mine.parked.lead': 'This money belongs to no offer.',
  'mine.parked.body':
    'A dead offer’s deposit rests here until something spends it. The next escrow offer you signed can be funded out of it, by any solver, without you. Take it back with one transaction per token.',
  'mine.parked.hazard.lead': 'An escrow offer you never funded is no longer inert.',
  'mine.parked.hazard.body':
    'Not depositing used to be an off switch. It is not one now. When one of your offers dies, anybody may move its deposit out of it. Any solver may then spend that money on another escrow offer you signed. They pick the moment, and you do nothing. Cancel every offer you do not want funded — cancelling is the off switch, and it is the only one.',
  'mine.parked.col.token': 'token',
  'mine.parked.col.amount': 'resting here',
  'mine.parked.spoken': '{amount} resting here, committed to no offer',
  'mine.parked.withdraw.label':
    'Take back the {symbol} resting here. One transaction, and it pays the wallet that sends it.',
  'mine.parked.withdraw.tip': 'One transaction. It pays the wallet that sends it.',
  'mine.parked.failed': 'the withdrawal of resting capital failed',
  // The cancel offered on a live offer the maker never funded. There was no button here at all
  // until parked capital made an empty escrow fundable by a stranger.
  'mine.unfunded.label':
    'Cancel the unfunded offer on {pair}. Nothing is deposited, and that no longer stops a fill. A solver may fund it out of capital resting here.',
  'mine.unfunded.tip':
    'Nothing is deposited, and that no longer stops a fill. A solver can fund this offer out of capital resting here. Cancel is the off switch.',

  // ── The board table's column headings ─────────────────────────────────────────────────────
  // Six cells over a grid whose column widths are fixed, and `expires` is fixed at 4.5rem. A word
  // that does not fit its column overflows it, so each of these is the shortest faithful word the
  // language has. `select` is the checkbox column, which draws nothing and is only heard. The
  // middot in `board.col.pair` separates two words; it is punctuation, not one of them.
  'board.col.select': 'select',
  'board.col.pair': 'pair · maker',
  'board.col.size': 'size',
  'board.col.rate': 'rate',
  'board.col.edge': 'edge',
  'board.col.expires': 'expires',

  // ── A board row ───────────────────────────────────────────────────────────────────────────
  'row.to': 'to',
  'row.for': 'for ≥',
  'row.ask': 'ask',
  'row.mkt': 'mkt',
  'row.expired': 'expired',
  'row.expired.spoken': 'Expired, cannot be filled',
  'row.expired.ago': 'Expired {duration} ago',
  'row.expires.in': 'Expires in {duration}',
  'row.ago': '{time} ago',
  'row.select': 'Select offer: {amount} for {symbol}, maker {address}',
  'row.maker': 'maker {address}',
  // The escrow flag is set but the reservation has not been read, or has been read and is empty.
  // Neither is "in escrow", and a reader must not be told it is.
  'row.escrow.unread': 'escrow · unread',
  'row.escrow.empty': 'escrow empty',
  'row.escrow.unread.tip': 'This offer uses escrow. The app has not read what the contract holds for it yet.',
  'row.escrow.empty.tip': 'This offer uses escrow, and the contract holds nothing for it. It cannot fill.',
  'row.offBoard': 'off-board',
  'row.offBoard.tip':
    'Signed and valid, but not broadcasting on the live board. Off the board is not cancelled: only cancel on chain stops a fill, and an executor may already hold a signed copy.',
  // A TERM of the offer, set when it is signed: it may fill in parts. Not a report that it is
  // partly filled — the pie beside it carries that. Its opposite is `sign.partial.none`,
  // "all or nothing", which the row reuses rather than saying it twice.
  'row.partial': 'fills in parts',
  'row.partial.tip': 'It can fill in parts. Whatever is left stays open.',
  // `{pct}` arrives already formatted in the reader's digits, with its percent sign.
  'row.partial.filled': '{pct} filled so far. The rest stays open.',
  // The two ends, where `row.partial.filled` would be false: at none there is nothing to report,
  // and at all there is no rest to stay open.
  'row.partial.none': 'Nothing is filled yet.',
  'row.partial.done': 'It is completely filled. Nothing is left to take.',
  'row.whole.tip': 'It fills in one go, or not at all.',
  'row.decaying': 'decaying',
  'row.decaying.tip': 'The price falls over time towards the floor the maker set.',
  // Whether the maker's balance still covers the offer. An unfunded offer cannot be filled.
  'row.funded': 'funded',
  'row.unfunded': 'unfunded',
  'row.funded.tip': "The maker's wallet still holds enough to cover this offer.",
  'row.unfunded.tip': "The maker's wallet no longer holds enough. It cannot fill until they top up.",
  'row.amounts.spoken': 'Gives at most {amount}, and a fill pays at least {least}',
  'row.rate.spoken': 'Signed rate {signed}. Market rate {market}.',
  'row.rate.spoken.loading': 'Signed rate {signed}. Market rate loading.',
  'row.rate.spoken.none': 'Signed rate {signed}. No market rate.',
  'row.profitable': 'Profitable',
  'row.loss': 'Loss',
  'row.even': 'Break even',
  'row.edge.spoken': '{verdict}: {pct} percent, {amount}',
  'row.edge.loading': 'Edge loading',
  'row.noRoute': 'no route',
  'row.noRoute.spoken': 'No route',
  'row.noEdge.expired': 'No edge, expired',

  // ── The token picker ──────────────────────────────────────────────────────────────────────
  'picker.title': 'Choose a token',
  'picker.search': 'search name, symbol, or paste address',
  'picker.search.label': 'Search by name or symbol, or paste a token address',
  'picker.selected': 'selected',
  'picker.wrap': 'x402 wrapper',
  'picker.address': 'address {address}',
  'picker.balance': 'balance {amount}',
  'picker.reading': 'reading token…',
  'picker.reading.spoken': 'Reading the token from the chain',
  'picker.count': '{count} tokens',
  'picker.none': "No match. Paste the token's address.",
  'picker.none.spoken': 'No match',

  // ── The tour ──────────────────────────────────────────────────────────────────────────────
  // Six steps, and the only place the app explains its own mechanics. Every claim here is
  // checkable against the contract — see `docs/specs/2026-08-12-surfaces-and-claims.md`.
  'tour.steps': 'Tour steps',
  'tour.step': 'Step {n} of {total}: {title}',
  'tour.title': 'How prove.cash works, step {n} of {total}:',
  'tour.skip': 'Skip',
  'tour.back': 'Back',
  'tour.next': 'Next',
  'tour.done': 'Got it',
  'tour.work.title': 'Work, not gas',
  'tour.work.body':
    'Posting an offer costs a moment of proof of work in your browser. No transaction, no fee, no sign-up. The counter that runs while you post is that work.',
  'tour.where.title': 'Where the tokens are',
  'tour.where.body':
    'Every offer says where the maker’s tokens sit. In escrow: the contract holds them. Funds at fill: one signature moves them the moment the offer fills. In wallet: the maker can still spend them elsewhere. Executors simulate first either way.',
  'tour.ladder.title': 'The custody ladder',
  'tour.ladder.body':
    'Approval leaves tokens in your wallet — the floor. Escrow moves them into the contract, where an executor can see them; one transaction in, one back out, whenever you like. Authorization adds a second signature that moves them at fill time, with no gas. The app picks the strongest rung your token supports. To override it, open custody in the offer form.',
  'tour.callback.title': 'Fill without inventory',
  'tour.callback.body':
    'An executor with no inventory implements proveCallback and calls fillWithCallback itself. There is no target to name: the settlement calls whoever called it. It releases the maker’s token to that caller, calls it, then pulls what the caller owes out of it. So the caller must end the call holding that amount, with an allowance for the relayer. The spread stays with the executor. ProveExecutor is that contract, deployed once for everyone, so an EOA can fill from any venue.',
  // Two different things, and the whole point of the card is the difference between them. "the
  // board" is msgboard, the broadcast every solver reads. "this app" is prove.cash, which keeps
  // its own archive and can still show an offer the broadcast has dropped. Seven of eight
  // Romance locales collapsed the two into one word and the card stopped saying anything.
  //
  // The English said "this book", which named a third thing. It is "this app" now, so a
  // translator has two clearly separate nouns to carry across.
  'tour.offboard.title': 'Off the board, still alive',
  'tour.offboard.body':
    'The board carries roughly 120 blocks, and an archive remembers a year. Ageing off costs you reach, not validity: the signature still stands and this app still shows it, but solvers watching the board directly stop seeing it. An open tab re-posts it. Only the chain decides what can still fill. A cancel is a transaction, because an executor may already hold a signed copy.',
  'tour.cancel.title': 'What a cancel costs',
  'tour.cancel.body':
    'Cancelling is an on-chain call, so it costs gas, and it bites on the block it lands. In escrow you do not need one: withdrawing takes the money back and cancels the intent in the same transaction. A short expiry is cheaper than either — an offer that expires in minutes cancels itself. An offer left in your wallet expires within the hour whatever you choose.',

  // ── The selection tray ────────────────────────────────────────────────────────────────────
  // `fillBatch`, `fillWithAuthorization` and `fill` are contract functions. They are identifiers,
  // not words, and stay as they are in every language.
  'batch.region': 'Selected offers',
  // A plural set, not a sentence. `.other` is the floor every language has; a language that needs
  // more forms adds them in its own file and `tCount` finds them. Arabic sits in its 2-to-10 band
  // for the ordinary size of a selection and cannot be rephrased out of it — the Slavic files
  // were, by putting the count last behind a participle the numeral cannot govern.
  'batch.selected.other': '{count} selected',
  'batch.pay': 'you pay',
  'batch.receive': 'you receive',
  // Not "fee" on its own. The figure beside it is the whole outlay and the fee is already inside
  // it, so a bare label reads as a second charge and the reader adds the two.
  'batch.fee': 'fee, inside what you pay',
  'batch.net': 'est. net',
  'batch.net.tip':
    'Priced along the pool curve in fill order, opposing rows netted first. Each fill moves the pool for the next one.',
  'batch.nothing': 'nothing',
  'batch.and': 'and',
  'batch.unquoted': '({count} unquoted)',
  'batch.sim.tip': 'Every fill is dry-run with eth_call before the button arms.',
  // `dry run`, not `sim`. The short form collides with a real word in five languages — a phone
  // SIM in Japanese, Korean, Vietnamese and Malay, a driving licence in Indonesian — and it was
  // the only untranslated English word in the whole ja file and the whole ko file, so it was
  // read as protocol rather than copy. Nothing forces three characters here: the chip is
  // `aria-hidden` and the words a screen reader hears are the `.spoken` keys below.
  'batch.sim.ok': 'dry run ✓{note}',
  'batch.sim.fail': 'dry run ✗ {reason}',
  'batch.sim.running': 'dry run …',
  'batch.sim.idle': 'dry run —',
  'batch.sim.ok.spoken': 'Simulation passed',
  'batch.sim.ok.spoken.note': 'Simulation passed. {note}',
  'batch.sim.fail.spoken': 'Simulation failed: {reason}',
  'batch.sim.running.spoken': 'Simulating',
  'batch.sim.idle.spoken': 'Not simulated yet',
  'batch.clear': 'Clear',
  'batch.notDeployed': 'Settlement not deployed',
  'batch.filling': 'Filling…',
  'batch.simulating': 'Simulating…',
  'batch.fill.one': 'Fill 1 intent',
  // `.many` starts at TWO, not at "lots". This is the fill button and it fires whenever the
  // selection is not exactly one, so its ordinary arguments are 2, 3 and 4 — which is precisely
  // where Slavic languages take a plural class of their own and Arabic takes a dual. Czech read
  // `Splnit 2 intentů`, the genitive plural, where it needs `2 intenty`.
  //
  // A language with a 2-to-4 class should put the count LAST, behind a noun the numeral cannot
  // govern, the way ~two dozen other keys here already do. The natural phrasing is wrong in six
  // languages, so say this rather than let each translator rediscover it.
  'batch.fill.other': 'Fill {count} intents',
  'batch.sent': 'sent · {hash}',
  'batch.failed': 'fill failed',
  'batch.mode.batch': 'fillBatch · {count} intents · skips invalid',
  // One selected row whose escrow its own 3009 authorization funds. `fillWithAuthorization` is
  // the cheaper door for a single leg; several such rows go through `fillBatch`, which carries
  // the same signature on each leg's `arming`. There used to be a warning here that they had to
  // be filled one at a time, and that is no longer true.
  'batch.mode.auth': "fillWithAuthorization · maker's 3009 signature funds escrow at fill",
  'batch.mode.direct': 'fill · pays {symbol} from your wallet',
  'batch.solo': 'rows priced alone',
  'batch.solo.tip':
    "What the table's edge column adds up to. Each row there is quoted against the untouched pool, so the sum ignores the impact every fill leaves for the next one.",
  'batch.alone.one': '1 row priced alone · no pool',
  // `.many` starts at two — see `batch.fill.many` for why that matters and what to do about it.
  'batch.alone.other': '{count} rows priced alone · no pool',
  'batch.alone.tip': 'No PulseX pool trades this pair, so the walk cannot price it.',
  'batch.bound': 'fee bound {rate}',
  'batch.bound.spoken': 'Fee bound {rate}, the most this transaction will pay.',
  'batch.bound.tip': 'The highest fee this transaction will pay.',

  // ── The charts ────────────────────────────────────────────────────────────────────────────
  // Nothing here claims a fill. A curve drawn from one reserve snapshot is a bound that can move
  // before anybody executes, so "at these reserves" has to survive translation.
  'chart.v.reserves': 'reserves',
  'chart.res.figure': '{base} against {quote} in reserve space: the board moves the pool by {moved}.',
  'chart.res.moves': 'The board pushes {amount} {base} through the pool, taking the rate from {from} to {to}.',
  'chart.res.tiny': 'The board moves {amount} {base} — too little to draw at this depth. The rate goes {from} to {to}.',
  'chart.res.still': 'Nothing on the board beats the pool for {in} into {out} right now.',
  'chart.res.matched': '{amount} {base} matches between offers and never touches the pool.',
  'chart.v.impact': 'impact',
  // `tape` is the trading sense: the running record of live offers over time, as in "reading the
  // tape". Not adhesive tape, and not a ribbon. Five locales guessed a ribbon word and Swedish
  // guessed `tejp`, the sticky material; Danish, Norwegian and Dutch have the same trap, and in
  // Norwegian the word is also the verb "to lose". Translate the meaning, not the word.
  'chart.v.tape': 'tape',
  'chart.impact.figure': 'Rate against trade size for {base} into {quote}, with the resting offers on it.',
  'chart.tape.figure': 'Every live offer for {base} against {quote} across its remaining life: {count} of them.',
  'chart.tape.now': 'now',
  'chart.v.capacity': 'depth',
  'chart.cap.both': 'pool + board',
  'chart.cap.pool': 'pool only',
  'chart.cap.what': 'What the depth curve counts',
  'chart.cap.figure': 'Depth for {base} against {quote}: how much fills at each price.',
  'chart.ladder.empty': 'No resting offers on this pair yet.',
  'chart.ladder.spot': 'pool',
  'chart.ladder.figure': 'The board for {base} against {quote}, {levels} price levels.',
  'chart.pick': 'Which chart',
  'chart.v.curve': 'curve',
  'chart.v.ladder': 'ladder',
  'chart.pool.label': 'Pool preview',
  'chart.pool.pick': 'Pick two different tokens and this shows what the pool pays for them.',
  'chart.pool.reading': "Reading the pair's reserves…",
  'chart.pool.noRouter': 'This chain has no constant-product router the app can read.',
  'chart.pool.failed': "The pair's reserves did not come back. The endpoint may be rate limiting.",
  'chart.pool.noPool': 'No PulseX pool trades {in} for {out}.',
  'chart.pool.empty': 'The {in}/{out} pool holds no liquidity.',
  'chart.pool.rest':
    'Your offer can still rest on the board. Nothing prices it against a market, so pick the floor you want rather than the one a pool would pay.',
  'chart.pool.figure': "The pool's rate against trade size for {in} into {out}. {verdict}",
  'chart.verdict.none': 'Type a size and a floor to place them on this curve.',
  'chart.verdict.fills': 'Fills now: a taker keeps {pct} at these reserves.',
  'chart.verdict.rests': 'Rests: {pct}% above what the pool pays.',
  'chart.spot': 'spot {rate}',
  'chart.pays': 'pool pays',
  'chart.charges': 'pool charges',
  'chart.move': 'your {size} {symbol} moves this pool {pct}%',
  'chart.move.tip':
    "The gap between the pool's own rate and the rate this size executes at, the pool's cut included.",
  'chart.floors.one': '1 other floor rests on this pair, drawn as ticks.',
  'chart.floors.other': '{count} other floors rest on this pair, drawn as ticks.',
  'chart.decay.none':
    'Set a size, a starting floor and a floor at expiry to see when the decay crosses the pool.',
  'chart.decay.now': 'fillable from the start, at these reserves',
  'chart.decay.crosses': 'crosses the pool in ≈{time}',
  'chart.decay.never': 'never reaches the pool before it expires',
  'chart.decay.figure': 'The decaying floor over {time}: {note}.',
  // A scheduled offer is not decaying yet, so the strip draws a flat run-in and says when the
  // fall starts. `chart.decay.now` would be a lie about an offer nobody can fill for six hours.
  'chart.decay.opens': 'opens in ≈{time}, and fills at once at these reserves',
  'chart.decay.open': 'opens',
  'chart.now': 'now',
  'chart.minutes.under': 'under a minute',
  // `cut`, not `fee`. See the three-fees note above `landing.console.gwei`: on this page a fee is
  // the maker's own, and what a pool takes is a cut.
  'chart.source': 'computed from pair {pair} reserves · pool cut {fee}%',
  'chart.source.block': 'computed from pair {pair} reserves · block {block} · pool cut {fee}%',
  'chart.walk.figure':
    'The batch walking the {symbol} pool: {fills} fills, {size} {symbol} sold, ending at {net} {netSymbol} net.',
  'chart.walk.net': 'net {amount} {symbol}',
  'chart.walk.caption': '{size} {symbol} through the pool, in fill order',
  'chart.walk.rest.one': '1 more pays {symbol}',
  'chart.walk.rest.other': '{count} more pay {symbol}',

  // ── The landing page ───────────────────────────────────────────────────────
  //
  // A different job from everything above. The app's strings label controls for somebody who has
  // already decided to be here; these have to explain what the thing is to somebody who has not.
  // So they are longer, they are prose, and the order they appear in is the argument.
  //
  // Keep the argument. Every locale is free to reword a sentence and none is free to drop the
  // claim inside it — "the rate you sign is the rate you get" is a promise the contract keeps and
  // the page must not soften it into "good rates".
  //
  // `prove.cash` is the product's name and never translates. Nor do `EIP-3009`, `EIP-2612`,
  // `msgboard`, `PulseChain` or `tx`.

  // The chrome. The skip link, the "how it works" link and the footer sentence are the app's own
  // keys — `header.skip`, `header.tour`, `footer.shared`, `footer.about` — because the two headers
  // are word for word and a second copy is a second thing to translate and to drift.
  //
  // Only the button that crosses between the surfaces is new, because only this page has one.
  // The two strings a search engine and a link preview read, and the only strings on this page
  // nobody sees in the page. `scripts/prerender.ts` writes them into `<title>`, the meta
  // description and the Open Graph and Twitter cards of every locale's HTML.
  //
  // A title is a promise made in about sixty characters — a search result truncates past that,
  // and so does a browser tab. The product name leads because it is the word somebody searches
  // for. The description is one claim from the list in
  // `docs/specs/2026-08-12-surfaces-and-claims.md` and stays under about 155
  // characters for the same reason.
  //
  // Length is the constraint here, not the wording: translate the claim, and if your language
  // needs more room than English, shorten the sentence rather than dropping the claim.
  'seo.title': 'prove.cash — sign a swap offer, send no transaction',
  'seo.description':
    'Signing an offer costs no gas and no transaction. Anyone can execute it, and you receive exactly the rate you signed. Swap intents on PulseChain.',
  // The card image, described. A screen reader on a social platform reads this and nothing else
  // about the picture, so it says what the picture shows rather than what the product does.
  'seo.image.alt': 'Two stacked slabs: the signed offer above, the settled trade below.',

  'landing.open': 'Open the app',

  // The section switcher in the header. Lower case on purpose: it is set in small caps with wide
  // tracking, and a capital letter in that face reads as a shout.
  'landing.nav.label': 'Sections of this page',
  'landing.nav.how': 'how',
  'landing.nav.custody': 'custody',
  'landing.nav.costs': 'cost',
  'landing.nav.solvers': 'solvers',
  // Six labels now share one header row with a wordmark, a button and the language picker,
  // and the nav only appears from 768px up. English measures about 300px. One short word.
  'landing.nav.console': 'split',
  'landing.nav.control': 'limits',

  // ── The voice of this page ────────────────────────────────────────────────────────────────
  //
  // The reader wants to swap one token for another without paying gas and without handing their
  // coins to anybody. They are not a protocol engineer, and they do not know our words. So:
  //
  //   1. Say what the reader gets, not how we do it. A mechanism is allowed only where it is the
  //      answer to a fear the reader already has, and then in their words.
  //   2. Teach a term before using it, and use it only after. "floor" is taught in the hero;
  //      "executor" at the third step; "maker" and "solver" in the solvers section. "rung",
  //      "intent", "gross", "index", "relayer" are never taught, so they do not appear.
  //   3. One idea per sentence. Present tense. Name the actor. No em-dash subordinate clauses.
  //   4. Keep every number and every caveat. Shorten the sentence, never the claim.
  //   5. Mechanism that a reader does not need in their face goes behind a hover.
  //
  // The hero. The headline is three lines that have to break where they break — each is its own
  // key so a language that needs two lines or four can have them, and the third is the one the
  // accent colour lands on.
  'landing.hero.eyebrow': 'signed swap offers · pulsechain',
  'landing.hero.line1': 'Name your rate.',
  'landing.hero.line2': 'The market',
  'landing.hero.line3': 'comes to you.',
  'landing.hero.lede':
    'prove.cash is an order book for swaps on PulseChain. You post an offer at your rate. It stays open until someone takes it. No pool price, no slippage, no transaction from you.',
  // This is where "floor" is taught. Every later use of the word leans on this sentence.
  'landing.hero.sub':
    'It fills at your rate or better, or not at all. You can let the rate fall over time to a floor: the least you will accept. You can also let it fill in parts.',

  // The three facts under the hero. Each is the answer to a question a reader has already formed
  // by this point, in the order they form them.
  'landing.fact.rate.head': 'You receive at least what you asked for',
  'landing.fact.rate.body':
    'The contract holds whoever fills your offer to the number you signed, and rounds in your favour. If you add a fee, the app raises the amount you sign to cover it. You still receive what you asked for.',
  'landing.fact.anyone.head': 'Anyone can fill it',
  'landing.fact.anyone.body':
    'No allowlist, no bond, no registration. Whoever fills your offer pays the gas. They keep whatever the market gives above the number you signed.',
  'landing.fact.free.head': 'Posting costs no gas',
  'landing.fact.free.body':
    'Your browser does a moment of work to post it. No gas, no transaction, no sign-up.',

  // The specimen offer beside the hero. It is a drawing of a signed offer, so the labels are the
  // ones a reader would use for its fields.
  'landing.card.eyebrow': 'the offer you sign',
  'landing.card.example': 'example',
  'landing.card.note': 'You sign this. You send nothing.',
  'landing.card.floor': 'your floor',
  'landing.card.hold': 'what you hold',
  'landing.card.market': 'the market',
  'landing.card.settled': 'the offer, settled',
  'landing.card.atLeast': 'at least',

  // The specimen's own field names and the sentence under its chart. `{symbol}`, `{from}` and
  // `{to}` are token symbols and never translate; `{hours}` and `{rate}` are figures already
  // formatted for the reader. The row labels sit in a 4.25rem column: one short word each.
  'landing.card.maker': 'signer',
  'landing.card.give': 'give',
  'landing.card.upTo': 'up to',
  'landing.card.receive': 'receive',
  // A term of the offer: which address may fill it. Not a record of who did.
  'landing.card.executor': 'may fill',
  'landing.card.anyone': 'anyone',
  'landing.card.heading': 'An example signed offer, drawn over real {from}/{to} prices.',
  'landing.card.resting': 'waiting · floor {floor}',
  'landing.card.filledAtHour': 'filled at hour {hour} · {price}',
  'landing.card.rate': '1 {from} = {rate} {to}',
  'landing.card.caption.resting':
    'Your floor falls until the market reaches it. You get the number on the green line.',
  'landing.card.caption.filled':
    'Someone filled it at the rate you signed. You hold {symbol} now, so the green line follows the market.',
  'landing.card.chart':
    'A signed floor of {floor} {to} falls over {hours} hours against the real {from}/{to} market. At hour {hour} the market reaches it and anyone can fill it at {price} {to}.',
  'landing.card.filledAt': 'filled at',

  // How it works: three parties, then the five ways a token can move.
  'landing.how.title': 'How it works',
  'landing.how.tokens.title': 'What you sign depends on your token',
  'landing.how.tokens.body':
    'There are five ways your tokens can move at the fill. The app reads your token and picks the cheapest one it supports, so the choice is not yours to get wrong.',
  // The actor labels are who ACTS, which is the surprising part: the maker never touches the
  // chain and the party who does is a stranger. Lower case, set in small caps.
  'landing.step.sign.actor': 'you',
  'landing.step.carry.actor': 'the board',
  'landing.step.execute.actor': 'anyone',
  'landing.step.sign.title': 'Sign the offer',
  'landing.step.sign.body':
    'Take up to this much of one token, deliver at least this much of another, inside this window. That is the whole commitment.',
  'landing.step.carry.title': 'Carries the offer',
  'landing.step.carry.body':
    'The offer travels over a message board, not the chain. Posting costs your browser a moment of work. No transaction, no gas, no account.',
  'landing.step.execute.title': 'Fills it',
  // This is where "executor" is taught. The costs section and the console lean on it.
  'landing.step.execute.body':
    'No allowlist, no bond, no registration. Whoever fills it is the executor. They pay the gas and the number you signed, and keep whatever the market gives above that.',

  // The five settlement paths. `EIP-3009`, `EIP-2612` and `Permit2` are names and stay; the words
  // around them are copy.
  // The price of each path, in the same notation the app's custody ladder uses. `tx` is the
  // abbreviation a trader reads and does not translate; the words around it do.
  'landing.rung.auth.cost': '2 signatures',
  'landing.rung.permit.cost': '2 signatures',
  'landing.rung.allowance.cost': '1 tx, once',
  'landing.rung.escrow.cost': '1 tx',
  'landing.rung.permit2.cost': '2 signatures, 1 tx once',
  'landing.rung.auth.name': 'EIP-3009',
  'landing.rung.auth.body':
    'The token can move on a signature alone. You never send a transaction, and nothing is approved in advance.',
  'landing.rung.permit.name': 'EIP-2612 permit',
  'landing.rung.permit.body':
    'Two signatures. Your tokens stay in your wallet until the moment someone fills.',
  'landing.rung.allowance.name': 'an allowance',
  // "the contract", not "the relayer": the relayer is the settlement contract, and a reader has
  // met the contract by now and the relayer never.
  'landing.rung.allowance.body':
    'Approve the contract once. Every offer after that is one signature.',
  'landing.rung.escrow.name': 'escrow',
  'landing.rung.escrow.body':
    'Deposit up front. It costs a transaction, and in exchange the offer is funded, so an executor can trust it on sight.',
  // `Permit2` is Uniswap's contract and keeps its name in every language.
  'landing.rung.permit2.name': 'Permit2',
  'landing.rung.permit2.body':
    'Approve Permit2 once. Its address is the same on every chain, and its code cannot change. Every offer after that is two signatures, and your token needs no special support.',

  // The custody ladder. The three `where` labels are the same claim the app's own ladder makes,
  // and they are past participles describing where the tokens ARE — see `custody.where.*`.
  'landing.ladder.title': 'Where your tokens sit.',
  'landing.ladder.sub': 'An offer is only as strong as what backs it.',
  'landing.ladder.wallet': 'wallet',
  'landing.ladder.contract': 'contract',
  'landing.ladder.spend': 'you spend',
  'landing.ladder.off': 'off switch',
  'landing.ladder.where.escrow': 'in escrow',
  'landing.ladder.where.fill': 'funded at fill',
  'landing.ladder.where.wallet': 'in wallet',
  'landing.ladder.rung.auth': 'authorization',
  'landing.ladder.rung.escrow': 'escrow',
  'landing.ladder.rung.permit2': 'permit2',
  'landing.ladder.rung.permit': 'permit',
  'landing.ladder.rung.approval': 'approval',

  // What the connector says the tokens do, per rung.
  'landing.ladder.path.auth': 'moves at fill',
  'landing.ladder.path.escrow': 'deposited',
  'landing.ladder.path.permit2': 'moves at fill',
  'landing.ladder.path.permit': 'allowance · at fill',
  'landing.ladder.path.approval': 'allowance · at fill',

  // How the offer ends. `validBefore` is a field name in the EIP-3009 signature and stays as it
  // is; `withdraw` and `cancel` are the contract's own functions.
  //
  // These two rows said `≤ 1 h` until `a7c5d7f`, and the comment here called it "a real bound,
  // not a rule of thumb". It was, and the settlement deleted it: a stale wallet signature costs
  // the maker who signed it and nobody else, so refusing a window they chose was never the
  // contract's call. What survives is the reason the rule existed, and it is worse than a clock —
  // on these two rungs `cancel` is the ONLY thing that ends an offer, because the revoke lives on
  // the token where the contract cannot see it.
  'landing.ladder.off.auth': 'validBefore',
  'landing.ladder.off.escrow': 'withdraw · 1 tx',
  // `deadline` is the field name in the Permit2 signature and stays as it is.
  'landing.ladder.off.permit2': 'deadline',
  'landing.ladder.off.permit': 'cancel · 1 tx',
  'landing.ladder.off.approval': 'cancel · 1 tx',
  // These five are hovers. Mechanism is allowed here, because the reader asked for it by
  // hovering, but it is still said in their words.
  'landing.ladder.offTip.auth':
    'Your signature moves the tokens at the moment of the fill, and it is tied to this one offer. Its expiry is part of the signature. A cancel on chain ends it at once.',
  // The last two sentences are a disclosure, not a flourish. `AUDIT-SCOPE` 6.11 asks this page
  // to say it wherever it says anything about ending an escrow offer, and until parked capital
  // landed the honest summary really was "withdraw ends it". An offer that was never funded is
  // the case that changed, and it is the case a maker is least likely to be thinking about.
  'landing.ladder.offTip.escrow':
    'One withdraw returns your money and ends the offer. No cooldown, no unlock step, no window to miss. An offer you never funded is different: somebody else can fund it from money already parked in your name. Cancel the ones you do not want.',
  'landing.ladder.offTip.permit2':
    'A Permit2 transfer works once and expires with the offer. No standing allowance to us survives it. Your one approval goes to Permit2 itself, at an address we cannot move. A cancel on chain ends the offer at once.',
  'landing.ladder.offTip.permit':
    'A permit is an allowance set by a signature, so it costs no transaction. It is still an allowance. Revoking it does not end the offer, because your signed permit sets it again at the next fill. Cancel is the off switch. A stranger who spends your permit first cannot stop the fill.',
  'landing.ladder.offTip.approval':
    'Revoking the approval happens on the token, where the contract cannot see it. It stops a fill but does not cancel the offer. Approve that token again later and the offer comes back to life. Only cancel ends it, and it costs one transaction.',

  // The diagram, spoken. A screen reader gets these instead of the drawing, so each has to carry
  // the whole claim the picture makes — including the one that ends "and then the fill fails".
  'landing.ladder.sr.auth':
    'The tokens stay in your wallet. Your signed authorization moves them into the contract at the moment of the fill.',
  'landing.ladder.sr.escrow':
    'The tokens sit in the contract, committed to this one offer, until you withdraw them.',
  'landing.ladder.sr.permit2':
    'The tokens stay in your wallet. Your signed Permit2 transfer moves them into the contract at the moment of the fill, once and once only.',
  'landing.ladder.sr.permit':
    'The tokens stay in your wallet under an allowance. A second signature sets that allowance, so you send no transaction. You can still spend the tokens before the fill, and then the fill fails.',
  'landing.ladder.sr.approval':
    'The tokens stay in your wallet under an allowance. You can spend them before the fill, and then the fill fails.',

  // The legend under the ladder. It defines the three badges a board row can wear, in the app's
  // own words — the label halves are `landing.ladder.where.*` above and only the gloss is new.
  'landing.ladder.legend.escrow': 'the contract holds them',
  'landing.ladder.legend.fill': 'signed for this offer only',
  'landing.ladder.legend.wallet': 'spendable elsewhere',
  'landing.ladder.cancel': 'cancelling',
  'landing.ladder.cancel.tip':
    'A cancel is one transaction. It cannot undo a fill that landed in an earlier block. Deleting the post is not a cancel: the signature outlives the post.',

  // What it costs. Every figure on this table is measured gas, so the prose must not soften into
  // "cheap" — the number is the argument.
  'landing.costs.title': 'The whole bill.',
  'landing.costs.body':
    'Measured gas, not estimates. Posting is free. Whoever fills your offer pays the rest.',
  // "a fraction of a cent", not "hundredths of a cent". At the console's own snapshot a warm
  // allowance fill is 124,975 gas × 783k gwei ≈ $0.001, which is a tenth of a cent. The looser
  // phrase is the one that stays true across the gas band.
  'landing.costs.note':
    'On mainnet a warm fill costs a fraction of a cent. The executor pays it, and keeps whatever the market gives above the number you signed.',
  'landing.costs.toggle': 'price the first touch or the warm case',
  'landing.costs.post.title': 'Post an offer',
  'landing.costs.post.label': 'sign it and put it on the board',
  'landing.costs.post.note': 'proof of work',
  'landing.costs.arm.title': 'Fund it with escrow',
  'landing.costs.arm.label': 'deposit, so the offer is funded',
  'landing.costs.arm.note': 'first touch',
  'landing.costs.fill.title': 'Fill one offer',
  'landing.costs.fill.allowance': 'from your allowance',
  'landing.costs.fill.escrow': 'from escrow',
  'landing.costs.fill.callback': 'with a callback',
  'landing.costs.batch.title': 'Fill twenty at once',
  'landing.costs.batch.onePair': 'one pair, per offer',
  'landing.costs.batch.mixed': 'mixed pairs, per offer',
  'landing.costs.batch.next': 'the twenty-first offer',
  'landing.costs.batch.marginal': 'marginal',
  'landing.costs.batch.callbacks': 'with callbacks, per offer',
  'landing.costs.batch.warm': 'warm',

  // The two prices every row can carry, and what each means. This is where "warm" and "first
  // touch" are taught; the console's chips lean on it.
  'landing.costs.mode.warm': 'warm',
  'landing.costs.mode.warm.hint': 'The usual case. The receiving balance already holds some of the token.',
  'landing.costs.mode.cold': 'first touch',
  'landing.costs.mode.cold.hint': 'The first transfer into an empty balance pays extra, once.',

  // Who pays for each group of rows.
  'landing.costs.actor.you': 'you',
  'landing.costs.actor.executor': 'an executor',

  // What each figure is, one hover away from the bar it belongs to.
  'landing.costs.tip.post':
    'The board asks your browser for a moment of work instead of money. No gas, no transaction, no sign-up.',
  'landing.costs.tip.arm':
    'Funding an empty escrow is always a first touch, so it has no warm price. It is optional: an allowance costs nothing up front.',
  'landing.costs.tip.callback':
    'The executor borrows your tokens, sells them elsewhere, and repays inside the same call. They need no money of their own.',
  'landing.costs.tip.next':
    'What one more offer adds to a batch already running. This number decides whether a thin margin is worth taking.',
  'landing.costs.tip.callbacks':
    'Borrowing inside a batch costs a little extra on every offer. The figure is the difference: one more offer with a callback, less one more without. It is too small to see on these bars.',
  // `{gas}` is a figure, already formatted for the reader. `credit` is the premium's name.
  'landing.costs.note.credit': '+{gas} credit',
  // The hover a row gets when it has no note of its own to hang the tip on.
  'landing.costs.why': 'why',

  // ── Who pays your gas ─────────────────────────────────────────────────────────────────────
  //
  // The solver's side of the trade. Every gas figure here is generated from `Gas.t.sol`, and the
  // `{gas}` and `{fill}` placeholders arrive already formatted for the reader.
  'landing.solver.title': 'A stranger pays your gas. Here is what they get for it.',
  // This is where "maker" and "solver" are taught.
  'landing.solver.body':
    'Nobody pays a stranger’s gas out of kindness. You are the maker. Whoever fills your offer is the solver. They earn the gap between what the market pays and the number you signed. That is their whole income, and this is what it costs them to chase it.',

  'landing.solver.risk.heading': 'what they lose',
  // `{fill}` is the gas a leg costs when it DOES fill, so the reader can size the three failures
  // against it. It arrives formatted; do not add digits or a unit.
  'landing.solver.risk.body':
    'A solver pays gas for every offer they try, and learns afterwards which ones filled. A fill costs {fill} gas. These three cost the gas and pay nothing.',
  // "the offer expired", not "you were too late": on this page "you" is the maker, and the
  // solver is "they".
  'landing.solver.risk.expired.label': 'the offer expired',
  'landing.solver.risk.expired.body':
    'The offer expired between the moment they priced it and the moment the block landed. The contract refuses it before any token moves, so this is the cheap one.',
  'landing.solver.risk.taken.label': 'somebody else was faster',
  'landing.solver.risk.taken.body':
    'Another solver filled the same offer first. This is normal on an open board: two solvers reading it will overlap, and the slower one pays for the duplicate.',
  'landing.solver.risk.unarmed.label': 'the maker took it back',
  'landing.solver.risk.unarmed.body':
    'The offer was good when the solver checked it. Then the maker pulled the money out before the block landed. This is the only failure somebody can arrange on purpose, and each attempt costs the maker a transaction. An offer that was never good is caught before anything is sent, and costs nothing.',

  'landing.solver.earn.heading': 'what they earn',
  'landing.solver.earn.body':
    'What is left over, and nothing else. We charge them no fee and give them no rebate, no priority and no queue. They pay the gas. They pay the number you signed. They keep whatever is left. Your fee comes out of the number you signed, not out of the solver’s share. If nothing is left, they lose the gas.',

  'landing.solver.terms.heading': 'why that is safe for you',
  'landing.solver.term.floor.title': 'They cannot earn more by giving you less.',
  'landing.solver.term.floor.body':
    'Your price is in the signature. The contract charges the solver that number, whatever the market does. They can earn more only by finding a better price, never by passing you a worse one.',
  'landing.solver.term.open.title': 'Anyone can be one.',
  'landing.solver.term.open.body':
    'No allowlist, no bond, no registration, no stake. A solver is any address that sends the transaction. Nobody can be shut out, and nobody can be locked in.',
  'landing.solver.term.thin.title': 'Competition is what fills your offer.',
  'landing.solver.term.thin.body':
    'Solvers do not bid your price down. You set it. They compete on how thin a margin they will accept. The thinner it gets, the more offers fill at the rate their makers wanted.',

  // ── Where the money goes: the fill console ────────────────────────────────────────────────
  //
  // One signed offer, and where every unit of one fill's money goes. `docs/FEE-MODEL.md` is the
  // authority for every figure here, and the copy has to hold its two hardest facts:
  //
  //   1. The maker signs a GROSS and receives that gross less the fee. The fee comes out of the
  //      maker's own number, not out of the executor's pocket.
  //   2. The executor pays the gross whatever the rate says, so the rate does not appear in a
  //      solver's decision. It reaches the fill only because the app signs a bigger gross for a
  //      maker who typed the net they want.
  //
  // Nothing here may say a fee is "added on top" or "comes out of the solver's side". That was
  // the design this one replaced, and saying it now would be a false claim about money.
  //
  // "gross" is FEE-MODEL's word and never the reader's. On this page it is "the amount you sign".
  //
  // Every `{placeholder}` arrives already formatted for the reader.
  'landing.console.title': 'Where the money goes',
  'landing.console.controls': 'The offer’s terms',
  'landing.console.outputs': 'Where one fill’s money goes',
  'landing.console.expand': 'expand',
  'landing.console.close': 'close',

  // The two denominations, in a pair of chips about 5rem wide together.
  'landing.console.denom': 'Show amounts in',
  'landing.console.denom.tokens': 'tokens',
  'landing.console.denom.usd': '$',

  // ── The rail ──────────────────────────────────────────────────────────────────────────────
  //
  // Every label below sits in a 118px column, set at 10px in small caps with wide tracking. Two
  // short words fit; a third overflows into the figure beside it.
  'landing.console.pair.in': 'Token to sell',
  'landing.console.pair.out': 'Token wanted',
  'landing.console.pair.swap': 'Swap the two sides',
  // An exchange rate, laid out as an expression. `{rate}` is a figure, `{from}` and `{to}` are
  // token symbols and never translate.
  'landing.console.pair.rate': '1 {from} = {rate} {to}',
  'landing.console.pair.asOf': 'snapshot · {date}',
  'landing.console.pair.same': 'not a trade',
  'landing.console.venue': 'Where the solver sells',
  // These two fill `{depth}` at the end of `landing.console.tip.pair`, as a clause after a comma.
  'landing.console.depth.measured': 'we read the pair’s reserves, so the drawing includes the price impact of this trade',
  'landing.console.depth.none': 'we did not read the pair’s reserves, so the drawing shows no price impact',

  'landing.console.size': 'Trade size',
  'landing.console.size.range': '$0.01 – $100,000',

  'landing.console.floor': 'Your floor',
  'landing.console.floor.sub': 'below the pool price, and yours to keep',
  'landing.console.shape': 'Offer shape',
  'landing.console.shape.flat': 'flat',
  'landing.console.shape.dutch': 'falling',

  'landing.console.window': 'Window',
  'landing.console.window.opens': 'opens',
  'landing.console.window.expires': 'expires',
  // Where the tokens sit. Two chips, about 4rem each. "Custody" is the nav's own word for the
  // ladder section, so the reader has met it; "rung" they never have.
  'landing.console.rung': 'Custody',
  'landing.console.rung.allowance': 'allowance',
  'landing.console.rung.escrow': 'escrow',
  'landing.console.rung.cold': 'first touch',
  'landing.console.rung.touch': 'Warm balance or first touch',
  'landing.console.rung.off.allowance': 'Only cancel ends it.',
  'landing.console.rung.off.escrow':
    'Withdrawing your escrow ends it. Somebody else can fund an offer you never funded, so cancel that one.',
  'landing.console.rung.zombie':
    'This offer uses an allowance and stays open longer than an hour. Revoking the approval stops fills but cancels nothing. Approve that token again later and this signature comes back. Only cancel ends it.',

  'landing.console.fee': 'Fee rate',
  'landing.console.fee.sub': 'to your fee config’s destinations',

  // ── One word, one meaning: "fee" is the maker's, and nothing else's ───────────────────────
  //
  // English lets one word carry three charges on this page, and a translator has to pick a word
  // per sense with no way to see which sense they are in. So the English picks first:
  //
  //   fee        the rate the maker names, taken out of the gross they sign. `i.feeRate` and
  //              `i.feeConfig`. This is the only thing on the page called a fee.
  //   pool cut   PulseX's 0.29% on a swap. Never a fee here — the maker does not pay it, does not
  //              sign it, and cannot change it.
  //   gas price  what one unit of gas costs, in gwei. This was "base fee", which is the term of
  //              art and reads on this page as a third fee the maker might owe. They owe none of
  //              it: the solver pays gas.
  //
  // `i18n-vocabulary.test.ts` holds the line. Adding "fee" to a pool or gas string fails it.
  'landing.console.gwei': 'Gas price',
  'landing.console.gwei.range': '100k – 100B gwei, log scale',
  // `{range}` is one left-to-right run, built whole: a range around an en dash is an expression,
  // and the bidi algorithm reorders one dropped bare into an Arabic line.
  'landing.console.gwei.band': 'mainnet {range}, {date}',

  // ── The ribbon diagram ────────────────────────────────────────────────────────────────────
  //
  // Six steps, each a name over a figure in a 210px column. Keep a name to three words.
  'landing.console.flow.title': 'One fill',
  'landing.console.flow.hint': 'open a step for the arithmetic',
  'landing.console.who.take': 'You sell',
  'landing.console.who.pool': 'PulseX pool',
  'landing.console.who.poolKeeps': 'PulseX keeps',
  'landing.console.who.maker': 'You receive',
  'landing.console.who.fee': 'The fee config’s destinations',
  'landing.console.who.solver': 'The solver',
  'landing.console.who.gas': 'Gas',
  'landing.console.who.behind': 'behind by {amount}',
  'landing.console.burn.all': 'all of it',
  'landing.console.legend.person': 'settles to a person',
  'landing.console.legend.fee': 'a fee',
  'landing.console.legend.gas': 'gas, paid by the solver',
  'landing.console.legend.short': 'cannot profitably fill',
  // The gas sum, one line. Every figure is already formatted; the units do not translate.
  'landing.console.gas.line': '{units} gas × {gwei} gwei = {pls} ≈ {usd}',

  // ── The price chart ───────────────────────────────────────────────────────────────────────
  // ── executor and solver are two roles, not two words for one thing ────────────────────────
  //
  // The **executor** pays the gross, and only the gross — the role is about whose pocket the
  // outlay leaves, and the rate never touches it. The **solver** is the one whose take nobody
  // computes, a residual, and the one a generous market makes willing to fill sooner — that role
  // is about deciding, and about keeping what is left.
  //
  // The same party usually does both, which is why this reads like a slip and is not one. A chart
  // of what a fill costs says executor; a sentence about what is left over says solver.
  //
  // **`docs/FEE-MODEL.md` calls the first role "the filler".** That document is written for an
  // auditor and this page is written for a maker, and this page already had its own word:
  // `landing.step.execute.body` says "Whoever fills it is the executor. They pay the gas and the
  // number you signed". Two audiences, one role, and a reader here should meet the word the rest
  // of the page uses. Eleven of thirteen Romance and Germanic locales reached for their own
  // executor word here before anyone asked them to, which is the argument stated better than I
  // can state it.
  'landing.console.curve.title': 'What the executor pays, over the window',
  'landing.console.curve.market': '{hours} real hours of {pair}',
  'landing.console.curve.reshuffle': 'another week',
  'landing.console.curve.now': 'go to the open',
  'landing.console.curve.fill': 'go to the fill',
  'landing.console.curve.aria':
    'What an executor pays along the window. Drag the line, or use the arrow keys.',
  // The label on each line of the fan, in about 90px. `{rate}` is a percentage and `{time}` a
  // duration, both already formatted.
  'landing.console.curve.fan': '{rate} · {time}',
  'landing.console.curve.never': 'never',
  'landing.console.curve.net': 'you keep {amount}',
  'landing.console.curve.at': '{amount} · {time} in',

  // ── The verdict ───────────────────────────────────────────────────────────────────────────
  //
  // A state, a time and a short reason, in the same three slots whatever the answer, so nothing
  // below the bar moves when it changes. The state sits in a chip about 7em wide.
  'landing.console.verdict.profitable': 'profitable',
  'landing.console.verdict.notyet': 'not yet',
  'landing.console.verdict.never': 'not at this price',
  'landing.console.verdict.notrade': 'not a trade',
  'landing.console.verdict.solver': 'A solver keeps {amount} here, after {gas} of gas.',
  // `{time}` in the next three keys is a clock time, such as 14:32 — not an elapsed time.
  'landing.console.verdict.clock':
    'Your offer at {time} pays you {amount}, which is {above} above your floor.',
  'landing.console.verdict.atfloor': 'Your offer at {time} pays you {amount}: exactly your floor.',
  'landing.console.verdict.wait':
    'The offer asks {offer} and the market pays {market}. If the market holds, it fills at {time}.',
  'landing.console.verdict.behind': 'A solver loses {amount} by filling this now.',
  'landing.console.verdict.samepair': '{symbol} is on both sides.',
  'landing.console.first': 'fills',
  'landing.console.first.now': 'now',
  'landing.console.first.never': 'not at this price',
  'landing.console.be': 'break-even size',
  'landing.console.be.none': 'no size',

  // ── The spread bar ────────────────────────────────────────────────────────────────────────
  //
  // Three rows under one bar. The name column is 168px and the figure column 130px.
  'landing.console.spread': 'Spread',
  'landing.console.spread.pct': '{pct} of the trade',
  'landing.console.spread.none': 'no spread here',
  'landing.console.spread.nofill': 'no profitable fill',
  'landing.console.spread.row.fee': 'the fee config’s destinations',
  'landing.console.spread.row.solver': 'the solver',
  'landing.console.spread.row.gas': 'gas',
  'landing.console.spread.aftergas': 'after gas',
  'landing.console.spread.behind': 'behind by {amount}',
  'landing.console.who.pays':
    'You pay the fee, out of the amount you sign. A higher fee makes the offer fill later. That is all a fee costs you.',

  // ── The tips ──────────────────────────────────────────────────────────────────────────────
  //
  // One hover each, behind a dotted label. Each is a short paragraph, then the arithmetic with
  // this moment's own numbers in it. The figures arrive formatted; the sentence around them is
  // what a translator owns.
  'landing.console.tip.pair':
    'Four mainnet tokens, at dollar prices read on {date}. The curve runs in each token’s own raw units, exactly as the contract does. For {pair}, {depth}.',
  'landing.console.tip.size':
    'What you sell: {amount}, about {usd}. It is the amount you sign, and everything else here follows from it.',
  'landing.console.tip.floor':
    'The number you keep, however late the fill lands: {net}. With a fee of {rate}, the app signs {gross}, so that what is left after the fee still meets it.',
  'landing.console.tip.window':
    'When the offer opens and expires, counted from signing. It opens at {opens} and expires at {expires}, {span} later. More solvers see a longer window, and a moving market gets more chances to reach your price.',
  // Says "fee", and is declared as the maker's in `i18n-vocabulary.test.ts`. It used to dodge the
  // word with "a rate", under a label that says "Fee rate".
  'landing.console.tip.fee':
    'A share paid to the destinations of the fee config you sign, by weight. It comes out of the amount you sign, not out of the executor’s pocket. At {rate} it costs you {fee} of the {gross} you sign, and costs the solver nothing. It also costs you time: if the market holds, this offer fills {later} later than the same offer with no fee.',
  // Beside the fee-rate tip: the other side of break-even size — highest gas price that still
  // clears this fill. Lives next to Fee rate so the rail layout does not grow a third control.
  'landing.console.tip.clears':
    'The highest gas price at which this fill still pays for itself: {gwei} gwei. Below that a solver fills; above it gas eats the margin. The gas-price slider is at {now}. {state}',
  'landing.console.tip.clears.yes': 'This fill still clears after gas.',
  'landing.console.tip.clears.no': 'At this gas price, gas eats the margin.',
  'landing.console.tip.clears.none':
    'This fill has no margin before gas, so no gas price clears it. Raise the size, lower the floor, or wait for a cheaper gas price.',
  'landing.console.tip.gwei':
    'What a solver pays for gas. {median} gwei is the median of {blocks} mainnet blocks on {date}: a snapshot, not a live reading. The band on the track marks the lowest and highest gas price in those blocks. {line}',
  'landing.console.tip.take':
    'The solver pulls {amount} from your wallet, about {usd}. Your signature allows it. You send no transaction.',
  'landing.console.tip.pool':
    'The solver sells your tokens here. At the price on screen the swap is worth {spot}. The pool keeps 0.29%, and a trade this size moves the price by {impact}. So {proceeds} comes out, and the next four ribbons divide it.',
  'landing.console.tip.poolKeeps':
    'The pool’s 0.29%, plus what a trade this size leaves behind in the reserves. It is the solver’s cost of turning one token into another, and it touches nothing you signed. Of that cut, {burn} goes to the PulseX buy-and-burn and is destroyed as PLSX ({share}). We read that from the verified pair source and have not yet checked it against a mint on chain.',
  'landing.console.tip.maker':
    'What lands in your wallet: {amount}. It is the {gross} the offer asks at this moment, less your fee at {rate}. Nothing else comes out of it, and it is never below the number you typed.',
  'landing.console.tip.feeLeg':
    '{rate} of the {gross} you sign, which is {amount}. The contract reserves it under the hash of your fee config, and a separate claim, open to anyone, pays it to the config’s destinations by weight. Nobody calls a destination during a fill.',
  'landing.console.tip.solver':
    'What the solver walks away with: {amount}. It is the sale proceeds, less what they paid you, less gas. Nothing on chain computes it, and it is the one number that decides whether anyone fills at all.',
  // "the slider above", not "live": `tip.gwei` says the gas price is a snapshot, and this used to
  // say it was live. The slider is what moves it.
  'landing.console.tip.gas':
    'The solver pays it in PLS, a third asset. It does not grow with your trade, which is why there is a smallest trade worth filling. The gas count comes from the contract’s own tests. The gas price is the slider above, and the sum shows what it does to the margin. {line}',
  'landing.console.tip.curve':
    'The offer opens above what the pool pays today and falls until it closes: from {open} down to {floor} over {span}. Both are amounts you sign. Take the fee out of the closing number and you have the floor you typed. The dashed lines are the same offer with no fee and with a two per cent fee: one typed number, three signed amounts. Each dot is where that offer meets the market in the week drawn here, after gas. Another week puts the dots somewhere else.',
  'landing.console.tip.market':
    'Real hourly prices, not a simulation: {hours} hours of {pair}, from hour {hour} of the sampled week. The moves are real, but the pair is not the one you chose: none of the tokens on this page is in that series. Draw another week to see the shape change.',
  // `{sum}` is the whole subtraction, already laid out left to right. Handing a translator three
  // figures and two operators would ask them to place an expression their language reorders.
  'landing.console.tip.spread':
    'What the market pays, less what you receive: {sum}. It splits three ways and no further. Only your fee rate moves the first boundary. Only gas moves the second.',
  'landing.console.tip.first':
    'Arithmetic, not a term of the offer: the moment the curve falls below what the market pays now, less gas. The market pays {market}, so the offer has to reach {target}. That moment moves when the market or gas moves, and nobody knows the market will hold.',
  'landing.console.tip.be':
    'The smallest trade a solver still fills, at this moment and this market. Gas is fixed at {gas}, while the spread grows with the size. Below this size, gas eats the margin. It uses the same moment and market as the bar below, so the two agree.',

  // What nobody can do. Three promises, each with somewhere to go and check it. This is the
  // section that makes the rest credible, so nothing here may be softened into a reassurance.
  'landing.control.title': 'What nobody can do to you',
  'landing.control.body':
    'You signed. Three things nobody can do, and where to check each.',
  'landing.control.where': 'where to check',
  // The citation behind each claim. The identifiers — `_quote`, `_ceilDiv`,
  // `i.feeConfig`, `feeProceeds`, `feeOut`, `feeIn`, `_termsOk`, `FeeDefaults`, `claim` — are
  // names in the contract and never translate. Neither do the four the
  // fee citation says were deleted, nor the commit that deleted them: they were the protocol-fee
  // storage and its setters, and a reader checks the claim by looking for them.
  // The sentence around them does. These are hovers for a reader who wants to check, so the
  // contract's own words are the right words here.
  'landing.control.where.rate':
    '_quote rounds the gross up with _ceilDiv, rounds the fee down out of it, and pays you the rest.',
  'landing.control.where.fee':
    '_quote reserves feeProceeds, feeOut and feeIn under i.feeConfig, which _termsOk requires to be non-zero whenever a rate is. claim checks the config against that key and pays its destinations by weight. Commit 84e8895 deleted protocolShare, feePolicy, setFees and setFeePolicy.',
  'landing.control.where.pause':
    'The settlement has no owner and no owner-gated function. FeeDefaults has one owner, and holds only advice that an offer copies when you sign it.',

  // The audit paragraph. It carries no links. It used to link `{repo}` and `{deployment}`, but the
  // repository is private, so both links sent every visitor to a 404. Put them back only when a
  // stranger can open them.
  //
  // It used to say "Every finding is fixed, and each one has a test that fails if it comes back".
  // Both halves were false, and `docs/AUDIT-SCOPE.md` said so in 6.5 before this file did. The
  // security review's eight findings are all fixed; the economics review's F-5 is open by design,
  // and `test_F5_...` in `EconAudit.t.sol` asserts that the attack still works. Two of the eight
  // security regression tests also came out with the fee-sink registry, so "each one has a test" was wrong a
  // second way. The eleven accepted limits are sections 6.1 to 6.11 of that document.
  //
  // What this sentence may never do again: promise that nothing is open. Say what is fixed, say
  // what is not, and send the reader to the document that prices both.
  'landing.control.audit':
    
    'Two paid reviews (security, economics) tried to break the above. Security findings fixed. One economics finding open by design; its test asserts the attack still works. One of eleven measured, accepted, written limits.',
  'landing.control.rate.title': 'Nobody can change what you receive.',
  'landing.control.rate.body':
    
    'Your price is in the offer you sign. Payment is computed from it, your named fee comes out, you get the rest. Rounding favors you.',
  'landing.control.fee.title': 'There is no fee to us, and no switch to add one.',
  'landing.control.fee.body':
    'Fee is a config hash + three rates in your signed offer. No config, no rates: nothing charged. We take no share, add none. A config has one to eight destinations and their weights, fixed by its hash. Nothing later reaches a signed offer.',
  'landing.control.pause.title': 'There is no pause and no upgrade.',
  // "No owner function can spend an allowance you gave", not "the contract holds no allowance of
  // yours": the allowance rung IS an allowance to the contract, so the old line contradicted the
  // ladder. The claim that is true and checkable is about the two owner-gated functions.
  'landing.control.pause.body':
    'No switch reaches your money. The settlement has no owner and no admin function. The one owned contract holds the default fee, which an offer copies when you sign it; it cannot touch a signed offer or spend an allowance you gave.',

  // The last section: a way in that costs nothing. The privacy line is a promise about what the
  // lookup does and must stay exact.
  'landing.start.eyebrow': 'start with a token',
  'landing.start.title': 'Sign one and see.',
  'landing.start.body':
    'Give us an address and we mark the tokens it has already moved on this chain. Pick one and the app opens with it selected. You still set your price, and you see every cost before you sign anything.',
  'landing.start.address': 'Your address',
  'landing.start.lookup': 'Look it up',
  'landing.start.looking': 'Looking…',
  'landing.start.wallet': 'Use my wallet',
  // The one sentence under the lookup, which always says something: an invitation before, the
  // answer after, and an honest refusal when the index is down.
  //
  // `here` and `recently` are separate keys rather than one sentence with a hole, because a hole
  // holding an adverb is a hole a translator cannot inflect — the same trap `{tx}` was.
  // `recently` is used when the read hit its cap: we saw a slice of the history and must not
  // describe that slice as the whole of it.
  'landing.verdict.idle': 'Or start with any of these.',
  'landing.verdict.unreachable':
    'The lookup did not answer for that address. Pick any of these instead.',
  'landing.verdict.new': 'This address is new to the testnet. Start with any of these.',
  'landing.verdict.held': 'You have moved {tokens} here already. Start with one.',
  'landing.verdict.others.one': '1 other token is not listed yet.',
  'landing.verdict.others.other': '{count} other tokens are not listed yet.',
  'landing.verdict.moved.here.one':
    'The one token you have moved here is not listed yet. Start with any of these.',
  'landing.verdict.moved.here.other':
    'None of the {count} tokens you have moved here are listed yet. Start with any of these.',
  'landing.verdict.moved.recently.one':
    'The one token you have moved recently is not listed yet. Start with any of these.',
  'landing.verdict.moved.recently.other':
    'None of the {count} tokens you have moved recently are listed yet. Start with any of these.',

  // What the wallet button says when it cannot help.
  'landing.start.noWallet': 'No wallet answered. Type an address instead.',
  'landing.start.refused': 'The wallet refused. Type an address instead.',

  // The fear this answers is "are you tracking me". The answer names what leaves the browser
  // (the address, to a server we run), what we read (public history), and what never leaves
  // (the key). It may not claim that nothing leaves: the lookup is a request to a server of ours.
  'landing.start.privacy':
    'No email, no sign-up, no account. A lookup sends the address to a server we run and reads its public history. It asks for no signature, and your key never leaves your wallet.',

  // The price chip's spoken twin. `≤1 tx` is shorthand a screen reader cannot say, so the chip is
  // `aria-hidden` and these are what it hears instead. `{value}` is a figure and `{unit}` a noun
  // phrase already agreed with it — see `lib/i18n-shapes.test.ts`.
  'landing.cost.label': 'Costs',
  'landing.cost.and': 'and',
  'landing.cost.atMost': 'at most {value}',
  'landing.cost.atLeast': 'at least {value}',
  'landing.cost.range': '{from} to {to}',
  'landing.cost.unit.tx.one': 'transaction',
  'landing.cost.unit.tx.other': 'transactions',
  'landing.cost.unit.signature.one': 'signature',
  'landing.cost.unit.signature.other': 'signatures',
  'landing.cost.unit.min.one': 'minute',
  'landing.cost.unit.min.other': 'minutes',

  // ── Exclusive quotes ────────────────────────────────────────────────────────
  //
  // A maker names a price for ONE counterparty. That counterparty accepts with a signature and
  // sends no transaction, and anybody may then submit the pair and keep the spread. The words
  // that matter and must not drift between languages:
  //
  //   quote        the price the maker names. Not an estimate — it is firm and it is signed.
  //   counterparty the one address that may take it.
  //   binding      the maker's second signature, which is what makes the price theirs alone.
  //   mirror       the counterparty's own signed intent, the other half of the trade.
  //   pair         the two together, on their way to whoever pays the gas.
  //   spread       what the submitter keeps for sending it.
  //
  // The fault sentences below are the SDK's `QuoteFault` values in words. Each one says what is
  // wrong and, where it helps, what it means for the reader. Keep them refusals: a reader who
  // sees one must not sign.
  'rfq.title': 'Exclusive quotes',
  'rfq.intro':
    'A price named for one address. They accept with a signature and no transaction, and anybody can submit the pair and keep the spread.',
  'rfq.tab.group': 'Exclusive quote steps',
  'rfq.tab.make': 'Make',
  'rfq.tab.inbox': 'For you',
  'rfq.tab.settle': 'Submit',
  'rfq.venue.missing': 'Exclusive quotes are not available on {network}.',
  // The symbol of a token this browser could not read. Not a name — a refusal to guess one.
  'rfq.token.unknown': 'unknown token',
  'rfq.phase.binding': 'Waiting for the binding signature…',

  // Making one.
  'rfq.make.title': 'Name a price for one address',
  'rfq.make.to': 'reserved for',
  'rfq.make.to.hint': 'The one address that may take this price.',
  'rfq.make.to.invalid': 'That is not an address.',
  'rfq.make.to.self': 'You cannot quote yourself.',
  'rfq.make.seal.on': 'They have published a key, so the terms travel encrypted.',
  'rfq.make.seal.off':
    'They have published no key, so the terms travel in the clear. Anybody reading the board sees the price.',
  'rfq.make.size': 'You give, exactly',
  'rfq.make.price': 'You want, exactly',
  'rfq.make.firm': 'firm for',
  'rfq.make.firm.group': 'How long the quote stays firm',
  'rfq.make.firm.label': 'Firm for {duration}',
  'rfq.make.firm.note':
    'One price for the whole window, and the window is the deadline for submitting it as well as for accepting it.',
  'rfq.make.more.label': 'Custody and fee. Change them.',
  'rfq.make.rate': 'charging',
  'rfq.make.rate.note':
    'This is the exclusivity fee. It comes out of your price and is paid to the destinations of the fee config you sign. You sign a number big enough to cover it, so you still receive the number above.',
  'rfq.make.need.to': 'Name a counterparty',
  'rfq.make.go': 'Sign the quote and the binding',
  'rfq.make.done': 'quote · {hash} · firm for {duration}',
  'rfq.make.done.spoken': 'Your quote is on the board.',
  'rfq.make.pair.spoken': 'You give {in} and receive {out}.',

  // Reading one that names you.
  'rfq.inbox.title': 'Quotes named for you',
  'rfq.inbox.connect': 'Connect a wallet to see the quotes named for it.',
  'rfq.inbox.empty': 'No quote on the board names this address.',
  'rfq.inbox.loading': 'Reading the board…',
  'rfq.inbox.refresh': 'Refresh',
  'rfq.inbox.locked.one': '{count} quote is sealed to you and this tab cannot read it yet.',
  'rfq.inbox.locked.other': '{count} quotes are sealed to you and this tab cannot read them yet.',
  // The one above asks the reader to unlock. This one must not: they have unlocked, and the
  // quote still will not open. Either the maker sealed it to a key this wallet does not derive,
  // or the bytes changed on the way to the board.
  'rfq.inbox.unreadable.one': '{count} quote is sealed to you and your key does not open it.',
  'rfq.inbox.unreadable.other':
    '{count} quotes are sealed to you and your key does not open them.',

  // The encryption key. It is derived from a signature, held for this tab only, and never stored.
  'rfq.key.none': 'Publish a key and a maker can seal a quote so that only you can read it.',
  'rfq.key.publishedElsewhere':
    'You have published a key. Unlock it to read the quotes sealed to it.',
  'rfq.key.unlocked': 'Unlocked for this tab. Nothing is stored, so a reload asks again.',
  'rfq.key.unlock': 'Unlock sealed quotes',
  'rfq.key.publish': 'Publish your key',
  'rfq.key.done': 'Key published',
  'rfq.key.working': 'Waiting for signature…',

  // One quote, as a card.
  'rfq.quote.pair.spoken': 'They give {in} and want {out}.',
  'rfq.quote.sealed': 'sealed',
  'rfq.quote.expired': 'expired',
  'rfq.quote.firmFor': 'firm for {seconds}s',
  'rfq.quote.theyPay': 'they give',
  'rfq.quote.youPay': 'you give',
  // What the maker banks, which stopped being the same as what the counterparty pays. It sits
  // between the two so the subtraction reads in the order the money moves.
  'rfq.quote.theyGet': 'the maker keeps',
  'rfq.quote.fee': 'fee',
  'rfq.quote.maker': 'maker',
  'rfq.check.running': 'Checking both signatures…',
  'rfq.check.clean': 'Checked. This price is reserved for you and can settle nowhere else.',
  'rfq.check.faults': 'Do not sign this quote.',
  'rfq.fault.badIntentSignature': 'The maker did not sign these terms.',
  'rfq.fault.badBindingSignature': 'The maker did not sign the binding that reserves this price.',
  'rfq.fault.notExclusiveToThisVenue':
    'The quote does not name this venue, so anybody could fill it.',
  'rfq.fault.bindingNamesAnotherIntent': 'The binding is for a different quote.',
  'rfq.fault.reservedForSomebodyElse': 'This price is reserved for another address.',
  'rfq.fault.expired': 'The quote is no longer firm.',
  'rfq.fault.takeExceedsTheQuote': 'The binding releases more than the quote holds.',
  'rfq.fault.partialNotAllowed': 'The quote is all or nothing and the binding takes a part of it.',

  // Accepting one.
  'rfq.accept.open': 'Accept this quote',
  'rfq.accept.wants': 'You receive at least, in {symbol}',
  'rfq.accept.overAsking': 'The quote holds {max} {symbol}. Ask for that or less.',
  'rfq.accept.spread': 'Leaves {amount} {symbol} for whoever submits the pair.',
  'rfq.accept.spread.none': 'This leaves nothing for a submitter, so you will have to submit it.',
  // Not a count. It used to read "you send no transaction on the top three rungs", and the ladder
  // says otherwise: escrow costs one or two transactions and Permit2 costs at most one, and they
  // are rungs two and three. The two rungs that always cost nothing to send are the first and the
  // fourth, so no "top N" sentence can be true. The row already prices itself, so this points at
  // the row rather than repeating it.
  'rfq.accept.note':
    'Each rung shows your whole side of it: the signatures you make, and any transaction you send.',
  'rfq.accept.go': 'Sign the acceptance',
  'rfq.accept.done': 'Signed. The pair below is ready for whoever submits it.',
  'rfq.accept.done.spoken': 'The pair is signed and ready to submit.',
  'rfq.accept.ticket': 'The signed pair',
  'rfq.accept.copy': 'Copy the pair',
  'rfq.accept.copied': 'Copied',
  'rfq.accept.submitYourself': 'Submit it yourself',
  'rfq.accept.handover':
    'Give this to anybody. It carries both signatures and nothing else, and it is worthless after the quote expires.',

  // Submitting one.
  'rfq.settle.title': 'Submit a signed pair',
  'rfq.settle.paste': 'the signed pair',
  'rfq.settle.invalid': 'That is not a signed pair.',
  'rfq.settle.clear': 'Clear',
  'rfq.settle.need': 'Paste a signed pair',
  'rfq.settle.go': 'Submit the pair',
  'rfq.settle.sending': 'Waiting for the wallet…',
  'rfq.settle.mining': 'Waiting for the block…',
  'rfq.settle.done': 'settled · {hash}',
  'rfq.settle.done.spoken': 'The pair settled.',
  'rfq.settle.pair': 'pair',
  'rfq.settle.size': 'size',
  'rfq.settle.rate': 'rate you accept',
  'rfq.settle.keeps': 'you keep',
  'rfq.settle.deadline': 'deadline',

  // The wallet picker.
  //
  // Added at the END of this object on purpose. `docs/AUDIT-SCOPE.md` cites `en.ts:1463` twice
  // by line, and every key inserted above that line moves it. Keep new keys down here unless a
  // reader would be lost without them beside their neighbours, and re-aim the citation if you
  // ever must.
  //
  // `wallet.wc.*` is the WalletConnect half and `wallet.pick.*` is the dialog around it. Two
  // prefixes because the dialog outlives the protocol: the extension list is drawn whether or
  // not this build carries a project id.
  'wallet.pick.title': 'Connect a wallet',
  'wallet.pick.here': 'In this browser',
  'wallet.pick.none': 'No wallet extension answered in this browser.',
  'wallet.pick.phone': 'On a phone',
  'wallet.pick.scan': 'Scan a code with a phone',
  'wallet.pick.disconnect': 'Disconnect this wallet',
  // The chain is named before the choice, not after it. A wallet that has never heard of
  // PulseChain asks to add a network, and that prompt is alarming when it arrives unannounced.
  'wallet.pick.network': 'This connects for {network}. Your wallet may ask to add the network.',
  'wallet.chain.other': 'The wallet is on another chain. Switch it to {network} and try again.',
  'wallet.wc.opening': 'Opening the connection…',
  'wallet.wc.qr': 'A code to scan with a wallet on a phone',
  'wallet.wc.hint': 'Open your wallet and scan this code.',
  'wallet.wc.copy': 'Copy the link',
  'wallet.wc.copied': 'Copied',
  'wallet.wc.unreachable': 'Could not reach the WalletConnect relay. Try again.',
}

/** The full key set, and the type every other dictionary is a subset of. */
export type Dict = typeof en
export type Key = keyof Dict

/**
 * A key whose plural forms this dictionary carries: `<base>.one` and `<base>.other`.
 *
 * English needs exactly two forms, so those two are what `en` declares. Every other language
 * names its own set — Czech has a distinct class for 2 to 4, Arabic has six including a dual —
 * and CLDR is what decides which. `tCount` asks `Intl.PluralRules`, never a comparison.
 *
 * `BaseOf` looks removable and is not. A conditional type distributes over a union only when the
 * checked type is a naked type PARAMETER, and `Key` is a concrete union — written inline, the
 * check runs once against the whole union, fails, and quietly evaluates to `never`. Every extra
 * plural form is then a type error with nothing to say about why.
 */
type BaseOf<K> = K extends `${infer B}.other` ? B : never
type PluralBase = BaseOf<Key>

/**
 * A plural form a language needs and English has no word for.
 *
 * Only a base that already declares `.other` admits one, so this cannot be used to smuggle a key
 * English does not have into a locale file — `header.skip.few` is still a type error. `one` is in
 * here too: English needs no separate singular for every count noun, and Hebrew needs one for
 * some it does not.
 */
export type ExtraPlural = `${PluralBase}.${Exclude<Intl.LDMLPluralRule, 'other'>}`

/**
 * What a locale file is.
 *
 * Partial, because an untranslated key falls through to English rather than showing a reader a
 * key. Plus the plural forms above, because how many forms a noun has is a fact about the
 * language and not about the dictionary's shape.
 */
export type LocaleDict = Partial<Dict> & Partial<Record<ExtraPlural, string>>

export default en
