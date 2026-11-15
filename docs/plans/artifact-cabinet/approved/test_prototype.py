"""Interaction checks for the standalone cabinet design study (no backend claims)."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent

def verify():
    assert (ROOT / 'index.html').exists(), 'Prototype HTML is not present yet'
    results=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':1536,'height':1000},device_scale_factor=1)
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_content((ROOT/'index.html').read_text(), wait_until='load')
        page.wait_for_function('window.prototypeReady === true')
        assert page.locator('.artifact-card').count()==6
        results.append('Six sample artifacts render')
        assert page.locator('body').get_attribute('data-preview')=='pixel'
        results.append('Expressive defaults to pixel previews')
        page.locator('#draft').fill('Preserve this draft while changing appearance.')
        page.locator('[data-preset="calm"]').click()
        assert page.locator('body').get_attribute('data-preview')=='original'
        assert page.locator('#draft').input_value()=='Preserve this draft while changing appearance.'
        results.append('Calm defaults to original; draft survives')
        page.locator('#preview-select').select_option('pixel')
        page.locator('[data-preset="expressive"]').click()
        page.locator('[data-preset="calm"]').click()
        assert page.locator('body').get_attribute('data-preview')=='pixel'
        results.append('Explicit preview preference survives preset changes')
        page.locator('#preview-select').select_option('auto')
        page.locator('[data-preset="expressive"]').click()
        page.locator('#palette-select').select_option('slate')
        assert page.locator('body').get_attribute('data-palette')=='slate'
        assert page.locator('#draft').input_value()=='Preserve this draft while changing appearance.'
        results.append('Palette change preserves draft and preview setting')
        page.locator('#cabinet-search').fill('coast')
        assert page.locator('.artifact-card:visible').count()==1
        page.locator('#cabinet-search').fill('no matching artifact')
        assert page.locator('#empty-state').is_visible()
        page.locator('#cabinet-search').fill('')
        results.append('Search and empty state work')
        page.locator('[data-filter="document"]').click()
        assert page.locator('.artifact-card:visible').count()==1
        page.locator('[data-filter="all"]').click()
        results.append('Type filter works')
        page.locator('[data-artifact="coast"]').click()
        assert page.locator('#artifact-dialog').is_visible()
        assert page.locator('#dialog-title').inner_text()=='Quiet coast'
        assert page.locator('#dialog-stage .original-image').count()==1
        page.keyboard.press('Escape')
        assert not page.locator('#artifact-dialog').is_visible()
        results.append('Pixel card opens original and Escape restores gallery')
        page.locator('[data-artifact="brief"]').focus()
        page.keyboard.press('ArrowRight')
        assert page.evaluate('document.activeElement.dataset.artifact')=='coast'
        page.keyboard.press('Enter')
        assert page.locator('#artifact-dialog').is_visible()
        page.keyboard.press('Escape')
        results.append('Arrow navigation and Enter opening work')
        page.locator('#expand-cabinet').click()
        assert page.locator('body').get_attribute('data-expanded')=='true'
        page.locator('#expand-cabinet').click()
        results.append('Cabinet expands and returns without losing state')
        page.locator('[data-artifact="maze"]').click()
        page.locator('#play-maze').click()
        assert page.locator('#game-status').inner_text().startswith('Collect')
        page.keyboard.press('ArrowRight')
        page.keyboard.press('Escape')
        results.append('Game opens and accepts keyboard input')
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        results.append('Narrow layout has no horizontal page overflow')
        assert not errors, errors
        results.append('No JavaScript page errors')
        browser.close()
    (ROOT/'verification.json').write_text(json.dumps({'scope':'standalone mockup only; sample data; no Rust/WASM or backend integration','checks':results,'count':len(results)},indent=2))
    print(json.dumps(results,indent=2))

if __name__=='__main__':
    verify()
