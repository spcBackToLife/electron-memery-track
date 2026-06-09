/**
 * 将 scenario JSON 中的 locator 转为 Playwright Locator
 */

/**
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} locator
 */
export function resolveLocator(page, locator) {
  if (!locator || typeof locator !== 'object') {
    throw new Error('click 步骤需要 locator 对象')
  }

  const kind = locator.kind ?? locator.type ?? 'css'
  const value = locator.value ?? locator.selector

  switch (kind) {
    case 'testId':
    case 'data-testid':
      return page.getByTestId(String(locator.value ?? value))
    case 'role': {
      const role = String(locator.role ?? 'button')
      const name = locator.name != null ? String(locator.name) : undefined
      return name != null ? page.getByRole(role, { name }) : page.getByRole(role)
    }
    case 'text':
      return page.getByText(String(value), { exact: locator.exact === true })
    case 'label':
      return page.getByLabel(String(value))
    case 'placeholder':
      return page.getByPlaceholder(String(value))
    case 'css':
    default: {
      let loc = page.locator(String(value))
      const filter = locator.filter
      if (filter && typeof filter === 'object') {
        const hasText = filter.hasText ?? filter.text
        if (hasText != null) {
          const pattern = filter.regex === true ? new RegExp(String(hasText)) : String(hasText)
          loc = loc.filter({ hasText: pattern })
        }
      }
      const nth = locator.nth
      if (nth != null && Number.isFinite(Number(nth))) {
        loc = loc.nth(Number(nth))
      }
      return loc
    }
  }
}
