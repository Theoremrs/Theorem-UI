/** Exercise the installed Base UI Select through its trigger and portal. */
export async function chooseOption(page, scope, label, option) {
  await scope.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

/**
 * Appearance keeps materials, layout and motion out of the visible controls.
 * Reach them the way a user would: through the settings' own JSON editor.
 */
export async function applyOverrides(page, scope, overrides) {
  const editor = scope.getByRole('textbox', {
    name: 'Custom appearance JSON',
    exact: true,
  })
  if (!(await editor.isVisible())) {
    await scope.getByText('Custom appearance', { exact: true }).click()
    await editor.waitFor()
  }
  const document = JSON.parse(await editor.inputValue())
  const merge = (target, source) => {
    for (const [key, value] of Object.entries(source)) {
      target[key] =
        value && typeof value === 'object' && !Array.isArray(value)
          ? merge({ ...(target[key] ?? {}) }, value)
          : value
    }
    return target
  }
  document.overrides = merge({ ...(document.overrides ?? {}) }, overrides)
  await editor.fill(JSON.stringify(document, null, 2))
  await scope
    .getByRole('button', { name: 'Apply custom appearance', exact: true })
    .click()
  await scope.getByText('Appearance settings applied.', { exact: true }).waitFor()
}
