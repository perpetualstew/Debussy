from pathlib import Path
from playwright.sync_api import sync_playwright
import json,base64,io
from PIL import Image
root=Path(__file__).resolve().parents[1]
slug='christmas-time-is-here'
manifest=json.loads((root/'ReferenceMusic'/slug/'manifest.json').read_text())
payload={'slug':slug,'title':'Christmas Time Is Here','sourceStatus':'complete','systems':[{'id':s['id'],'first':s['first'],'last':s['last'],'xml':(root/'ReferenceMusic'/slug/s['score']).read_text()} for s in manifest['systems']]}
catalog=json.loads((root/'Resources/collection.json').read_text())['pieces']
with sync_playwright() as p:
 b=p.chromium.launch(headless=True, executable_path='/usr/bin/chromium',args=['--no-sandbox']);page=b.new_page(viewport={'width':1510,'height':945})
 html=(root/'UI/index.html').read_text().replace('<script src="verovio-toolkit-wasm.js"></script>','').replace('<script src="studio.js"></script>','')
 page.set_content(html);page.add_script_tag(path=str(root/'UI/verovio-toolkit-wasm.js'));page.add_script_tag(path=str(root/'UI/studio.js'))
 page.evaluate('''()=>{window.testExport={pages:[],begin:null,complete:false};window.webkit={messageHandlers:{debussy:{postMessage(m){if(m.type==='beginExport'){window.testExport.begin=m;setTimeout(()=>Debussy.exportStarted(),0);}else if(m.type==='exportPage'){window.testExport.pages.push({index:m.index,data:m.png});setTimeout(()=>Debussy.pageSaved({index:m.index}),0);}else if(m.type==='finishExport'){window.testExport.complete=true;setTimeout(()=>Debussy.exportFinished({pages:window.testExport.pages.length,folder:'/mock/Generated'}),0);}}}}}}''')
 page.evaluate('''(c)=>Debussy.bootstrap({pieces:c,state:{layouts:{}}})''',catalog)
 page.evaluate('''(d)=>Debussy.receivePiece(d)''',payload)
 page.wait_for_function('''()=>document.querySelector('#publish').disabled === false''',timeout=100000)
 # Changing a profile should preserve original portrait scale independently.
 page.locator('#staffScale').fill('96')
 page.select_option('#orientation','landscape')
 landscapeScale=page.locator('#staffScale').input_value()
 page.select_option('#orientation','portrait')
 portraitScale=page.locator('#staffScale').input_value()
 assert portraitScale=='96' and landscapeScale=='75',(portraitScale,landscapeScale)
 page.click('#publish')
 page.wait_for_function('''()=>window.testExport.complete && document.querySelector('#notice').classList.contains('success')''',timeout=100000)
 meta=page.evaluate('''()=>({begin:window.testExport.begin,pages:window.testExport.pages.map(x=>({index:x.index,bytes:x.data.length}))})''')
 png=page.evaluate('''()=>window.testExport.pages[0].data''')
 raw=base64.b64decode(png.split(',')[1]); im=Image.open(io.BytesIO(raw))
 assert im.size==(1080,1920),im.size
 assert len(meta['pages'])==5,meta
 assert [p['index'] for p in meta['pages']]==list(range(5))
 assert meta['begin']['profile']=='s2-portrait-large-m0'
 print(json.dumps({'profiles_independent':True,'source_systems':17,'png_pages':len(meta['pages']),'png_size':im.size,'first_png_bytes':len(raw),'profile':meta['begin']['profile']},indent=2))
 (root/'QA/export-test.json').write_text(json.dumps({'profiles_independent':True,'png_pages':len(meta['pages']),'png_dimensions':list(im.size),'first_png_bytes':len(raw)},indent=2)+'\n')
 im.save(root/'QA/exported-page-1.png')
 b.close()
