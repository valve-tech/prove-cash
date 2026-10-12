import { describe, expect, it } from 'vitest'
import { SECURITY_CONTACT } from './security'
// `?raw` rather than `node:fs`: the app's tsconfig carries no node types. See i18n-placeholders.test.ts.
import securityTxt from '../../public/.well-known/security.txt?raw'
import securityMd from '../../../SECURITY.md?raw'

describe('the security contact', () => {
  it('is a reusable SimpleX contact address, not a one-time invitation', () => {
    const { hostname, pathname } = new URL(SECURITY_CONTACT)
    expect(hostname).toMatch(/(^|\.)simplex\.(im|chat)$/)
    expect(pathname).toMatch(/^\/(a|contact)$/)
  })

  it('is the address in security.txt and SECURITY.md', () => {
    expect(securityTxt).toContain(`Contact: ${SECURITY_CONTACT}\n`)
    expect(securityMd).toContain(SECURITY_CONTACT)
  })

  // RFC 9116 makes Expires required, and a reader must ignore an expired file. So this fails the
  // build a month before the date, which is the reminder to push it out another year.
  it('has a security.txt that is not about to expire', () => {
    const expires = securityTxt.match(/^Expires: (.+)$/m)?.[1]
    expect(expires).toBeDefined()
    const monthAhead = Date.now() + 30 * 24 * 3600 * 1000
    expect(new Date(expires ?? '').getTime()).toBeGreaterThan(monthAhead)
  })
})
