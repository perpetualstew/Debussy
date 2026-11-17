from pathlib import Path
from playwright.sync_api import sync_playwright
import json,base64,time
root = Path(__file__).resolve().parents[1]
piece='christmas-time-is-here'
manifest=json.loads((root/'ReferenceMusic'/piece/'manifest.json').read_text())
payload={'slug':piece,'title':'Christmas Time Is Here','sourceStatus':'complete', 'systems':[]}
for s in manifest['systems']:
    payload['systems'].append({'id':s['id'],'first':s['first'],'last':s['last'],'xml':(root/'ReferenceMusic'/piece/s['score']).read_text()})
catalog=json.loads((root/'Resources/collection.json').read_text())['pieces']
with sync_playwright() as p:
    b=p.chromium.launch(headless=True, executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=b.new_page(viewport={'width':1510,'height':945}, device_scale_factor=1)
    warnings=[]
    page.on('pageerror', lambda e: warnings.append('JS '+str(e)))
    source=(root/'UI/index.html').read_text()
    # Browser environment blocks filesystem/loopback navigation; load HTML as document and scripts by path.
    source=source.replace('<script src="verovio-toolkit-wasm.js"></script>', '').replace('<script src="studio.js"></script>', '')
    page.set_content(source)
    page.add_script_tag(path=str(root/'UI/verovio-toolkit-wasm.js'))
    page.add_script_tag(path=str(root/'UI/studio.js'))
    page.evaluate('''(catalog)=>window.Debussy.bootstrap({pieces:catalog,state:{layouts:{}}})''',catalog)
    page.evaluate('''(payload)=>window.Debussy.receivePiece(payload)''',payload)
    page.wait_for_function('''() => document.querySelector('#notice').classList.contains('success') && document.querySelectorAll('canvas.score').length===2''',timeout=100000)
    results={'catalog':len(page.locator('.piece').all()),'systems':len(payload['systems']),
             'portrait':page.evaluate('''()=>({pages:document.querySelector('#pagination').textContent,canvas:[...document.querySelectorAll('canvas.score')].map(c=>[c.width,c.height]),publishDisabled:document.querySelector('#publish').disabled,notice:document.querySelector('#notice').textContent})''')}
    page.screenshot(path=str(root/'QA/portrait-preview.png'),full_page=True)
    page.select_option('#orientation','landscape')
    page.wait_for_timeout(500)
    results['landscape']=page.evaluate('''()=>({pages:document.querySelector('#pagination').textContent,canvas:[...document.querySelectorAll('canvas.score')].map(c=>[c.width,c.height]),publishDisabled:document.querySelector('#publish').disabled,notice:document.querySelector('#notice').textContent})''')
    page.screenshot(path=str(root/'QA/landscape-preview.png'),full_page=True)
    page.select_option('#screens','1')
    page.select_option('#orientation','portrait')
    page.wait_for_timeout(300)
    results['single']=page.evaluate('''()=>({canvas:[...document.querySelectorAll('canvas.score')].map(c=>[c.width,c.height]),png:document.querySelector('canvas.score').toDataURL('image/png').slice(0,50),publishDisabled:document.querySelector('#publish').disabled})''')
    results['warnings']=warnings
    print(json.dumps(results,indent=2))
    (root/'QA/browser-test.json').write_text(json.dumps(results,indent=2)+'\n')
    assert results['catalog']==15
    assert results['portrait']['canvas']==[[1080,1920],[1080,1920]]
    assert results['single']['canvas']==[[1080,1920]]
    assert results['single']['png'].startswith('data:image/png;base64,iVBORw0KGgo')
    assert results['portrait']['publishDisabled'] is False, 'Portrait default must fit'
    assert results['landscape']['canvas']==[[1920,1080],[1920,1080]]
    assert results['landscape']['publishDisabled'] is False, 'Landscape default must fit'
    assert not warnings
    b.close()
