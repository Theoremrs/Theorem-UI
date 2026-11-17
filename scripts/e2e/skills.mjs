// A skill picked from the composer's + menu reaches the model, as the test
// account: the Skills submenu lists what Theorem serves, a pick writes the
// skill's directive into the draft, the sent message shows it as a chip, and
// the run that answers calls skill_get with that skill's id. The send API has
// no skills field, so the model reading the directive is the whole path.
// Start the stack first (bun run e2e:stack).
import { join } from 'node:path'
import { SHOTS, check, finish, log, open } from './lib.mjs'
import { turns } from './turns.mjs'

const session = await open('/')
const { page } = session
const { ended, json } = turns(session)
const composer = page.locator('[data-slot="aui_composer-shell"]')
const shot = (name) => page.screenshot({ path: join(SHOTS, `skills-${name}.png`) })

const { skills = [] } = await json('/skills')
check('Theorem serves skills to the account', skills.length > 0, `${skills.length} skills`)
const skill = skills.find((each) => each.id === 'prototype-theorem') ?? skills[0]

await composer.getByRole('button', { name: 'More options' }).click()
await page.getByRole('menuitem', { name: 'Skills' }).click()
await page.keyboard.press('ArrowRight')
const listed = page.getByRole('menuitem', { name: skill.name, exact: false }).first()
await listed.waitFor()
await shot('menu')
check(`the Skills submenu lists ${skill.name}`, await listed.isVisible())
await listed.click()

const box = composer.getByRole('textbox', { name: 'Message input' })
const directive = `:skill[${skill.name}]{name=${skill.id}}`
await page.waitForFunction(
  (text) => document.querySelector('.theorem-composer')?.textContent?.includes(text),
  directive,
)
check('the pick writes the skill directive into the draft', true, directive)
check(
  'focus is back in the draft after the pick',
  await box.evaluate((node) => node === document.activeElement || node.contains(document.activeElement)),
)

await page.keyboard.type('Load that skill, then tell me in one sentence what its first step is.')
await page.keyboard.press('Control+Enter')
await page.waitForURL((url) => url.pathname.startsWith('/c/'), { timeout: 60_000 })
log('sent; waiting for the run')

const chip = page.locator(`[data-directive-id="${skill.id}"]`).first()
await chip.waitFor({ timeout: 60_000 })
check('the sent message shows the skill as a chip by its title', (await chip.innerText()).includes(skill.name))

const run = await ended()
check('the run completed', run?.outcome === 'completed', run?.outcome)
const events = JSON.stringify(run?.runId ? await json(`/runs/${encodeURIComponent(run.runId)}`) : {})
const loaded = events.includes('skill_get') && events.includes(skill.id)
check(`the run called skill_get for ${skill.id}`, loaded)
await shot('reply')

await finish(session)
