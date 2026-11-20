from pathlib import Path
from playwright.sync_api import sync_playwright
import json
root=Path(__file__).parent
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    page=b.new_page(viewport={'width':1536,'height':1080},device_scale_factor=2)
    page.set_content((root/'index.html').read_text(),wait_until='load')
    page.wait_for_function('window.prototypeReady === true')
    page.screenshot(path=str(root/'expressive-workspace.png'))
    page.locator('#cabinet').screenshot(path=str(root/'pixel-cabinet.png'))
    page.locator('button[data-preset="calm"]').click()
    page.screenshot(path=str(root/'calm-workspace.png'))
    page.locator('#palette-select').select_option('paper')
    page.locator('#cabinet').screenshot(path=str(root/'calm-paper-cabinet.png'))
    page.locator('button[data-preset="expressive"]').click()
    page.locator('#palette-select').select_option('neutral')
    page.locator('[data-artifact="coast"]').click()
    page.screenshot(path=str(root/'opened-original.png'))
    page.keyboard.press('Escape')
    page.locator('#expand-cabinet').click()
    page.locator('#cabinet').screenshot(path=str(root/'expanded-cabinet.png'))
    audit={}
    for preset in ['expressive','calm']:
        page.locator(f'button[data-preset="{preset}"]').click()
        for theme in ['neutral','paper','slate','forest']:
            page.locator('#palette-select').select_option(theme)
            audit[preset+'-'+theme]=page.evaluate('window.cabinetAudit()')
    (root/'palette-checks.json').write_text(json.dumps(audit,indent=2))
    page.locator('#expand-cabinet').click()
    page.locator('button[data-preset="expressive"]').click()
    page.locator('#palette-select').select_option('neutral')
    page.set_viewport_size({'width':390,'height':844})
    page.screenshot(path=str(root/'mobile-cabinet.png'))
    b.close()
print('Screenshots written.')
