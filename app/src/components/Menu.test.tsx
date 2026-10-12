import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { Menu } from './Menu'

/**
 * The network menu holds still while an offer is in flight. A disabled menu renders a disabled
 * button, so the list cannot open and no other chain can be picked.
 */
const options = [
  { value: '369', label: 'PulseChain' },
  { value: '943', label: 'PulseChain testnet' },
] as const

describe('a held menu', () => {
  test('renders a disabled button when disabled', () => {
    const html = renderToStaticMarkup(
      <Menu label="Network" value="369" options={options} onChange={() => {}} disabled />,
    )
    expect(html).toMatch(/<button[^>]*disabled=""/)
  })

  test('renders an enabled button by default', () => {
    const html = renderToStaticMarkup(
      <Menu label="Network" value="369" options={options} onChange={() => {}} />,
    )
    expect(html).not.toContain('disabled')
  })
})
