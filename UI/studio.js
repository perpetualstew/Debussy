'use strict';
(function () {
  const el = id => document.getElementById(id);
  const native = payload => {
    try { window.webkit?.messageHandlers?.debussy?.postMessage(payload); }
    catch (error) { console.error('Native message failed', error); }
  };
  const settings = ['staffScale','systemsPerPage','margin','spacing','titleHeight','horizontal','vertical'];
  const config = {
    staffScale: [50, 145], systemsPerPage: [1, 7], margin: [12, 150],
    spacing: [0, 160], titleHeight: [0, 180], horizontal: [-180, 180], vertical: [-180, 180]
  };
  let catalog = [], saved = {layouts: {}}, piece = null, selectedSlug = '', rendered = [], loadingGeneration = 0;
  let spread = 0, engine = null, exporting = false, exporter = null, pageFits = true;
  let saveTimer = null, lastPreview = null;
  function message(text, type = '') { el('notice').textContent = text; el('notice').className = type; }
  function fail(error) { console.error(error); message(String(error?.message || error), 'error'); }
  function clamp(n, key) {
    const [min,max] = config[key]; return Math.max(min, Math.min(max, Math.round(Number(n) || 0)));
  }
  function currentProfile() {
    return {screens: Number(el('screens').value), mirror: el('mirror').checked && Number(el('screens').value) === 2,
      orientation: el('orientation').value, size: el('size').value};
  }
  function profileKey() {
    const p = currentProfile(); return `s${p.screens}-${p.orientation}-${p.size}-m${Number(p.mirror)}`;
  }
  function defaults() {
    const p = currentProfile(); return {
      staffScale: p.orientation === 'portrait' ? (p.size === 'large' ? 105 : 86) : (p.size === 'large' ? 75 : 55),
      systemsPerPage: p.orientation === 'portrait' ? (p.size === 'large' ? 4 : 5) : (p.size === 'large' ? 2 : 3),
      margin: 46, spacing: p.orientation === 'portrait' ? 30 : 18,
      titleHeight: 80, horizontal: 0, vertical: 0, distribute: true
    };
  }
  function layout() {
    const raw = saved.layouts?.[selectedSlug + '|' + profileKey()] || {};
    return {...Object.fromEntries(settings.map(k => [k, clamp(raw[k] ?? defaults()[k], k)])), distribute: raw.distribute !== false};
  }
  function saveLayout(l) {
    if (!selectedSlug) return;
    saved.layouts ||= {};
    saved.layouts[selectedSlug + '|' + profileKey()] = l;
    saved.lastPiece = selectedSlug;
    saved.lastProfile = currentProfile();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => native({type: 'save', value: saved}), 250);
  }
  function dimensions() {
    return currentProfile().orientation === 'portrait' ? [1080,1920] : [1920,1080];
  }
  function pagesCount() { return Math.max(1, Math.ceil(rendered.length / layout().systemsPerPage)); }
  function firstPageIndex() {
    const p = currentProfile(); return spread * (p.screens === 2 && !p.mirror ? 2 : 1);
  }
  function spreadsCount() {
    const p = currentProfile(); const per = p.screens === 2 && !p.mirror ? 2 : 1;
    return Math.max(1, Math.ceil(pagesCount()/per));
  }
  function populateControlValues() {
    const l = layout();
    el('distribute').checked=!!l.distribute;
    for (const k of settings) {
      el(k).value = l[k];
      el(k+'Value').textContent = l[k] + ({staffScale:'%', margin:'px',spacing:'px',titleHeight:'px',horizontal:'px',vertical:'px'}[k] || '');
    }
  }
  function titleFor(slug) { return catalog.find(x=>x.slug===slug)?.title || slug; }
  function catalogUI() {
    el('pieces').replaceChildren();
    for (const [i,item] of catalog.entries()) {
      const button = document.createElement('button'); button.type='button'; button.className='piece';
      if (item.slug === selectedSlug) button.classList.add('active');
      const number = document.createElement('span'); number.className='n'; number.textContent=String(i+1).padStart(2,'0');
      const text = document.createElement('span'); text.className='label'; text.textContent=item.title;
      button.append(number,text); button.addEventListener('click',()=>selectPiece(item.slug));
      el('pieces').append(button);
    }
    el('catalog-count').textContent = `${catalog.length} arrangements · source music included`;
  }
  function selectPiece(slug) {
    if (!catalog.some(x=>x.slug===slug)) return;
    loadingGeneration++;
    selectedSlug=slug; piece=null; rendered=[]; spread=0; lastPreview=null;
    catalogUI(); populateControlValues(); updateProfileUI();
    el('piece-title').textContent=titleFor(slug);
    el('piece-meta').textContent='Opening source MusicXML…';
    el('pages').replaceChildren();
    el('publish').disabled=true;
    saved.lastPiece=slug; saveLayout(layout());
    message('Loading engraved music for ' + titleFor(slug) + '…');
    native({type:'loadPiece',slug});
  }
  function updateProfileUI() {
    const p = currentProfile();
    el('mirror').disabled = p.screens !== 2;
    el('profile-name').textContent = `${p.screens} screen${p.screens === 2 ? 's' : ''} · ${p.orientation} · ${p.size}${p.mirror ? ' · mirrored' : ''}`;
    el('pages').classList.toggle('landscape-dual',p.screens === 2 && p.orientation === 'landscape');
  }
  function profileChanged() {
    if (el('screens').value === '1') el('mirror').checked=false;
    spread = 0; updateProfileUI(); populateControlValues();
    if (selectedSlug) saveLayout(layout());
    preview();
  }
  function getEngine() {
    if (engine) return engine;
    if (!window.verovio?.toolkit) throw Error('The bundled Verovio engine was not loaded');
    engine = new window.verovio.toolkit(); return engine;
  }
  async function imageFromSVG(source) {
    const blob = new Blob([source],{type:'image/svg+xml;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise((resolve,reject)=>{
        image.onload=resolve;
        image.onerror=()=>reject(Error('Failed to convert engraved notation to an image'));
        image.src=url;
      });
      if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) throw Error('Empty engraved system');
      return image;
    } finally { URL.revokeObjectURL(url); }
  }
  async function engrave(payload) {
    const generation = ++loadingGeneration;
    piece = payload; rendered=[];
    el('piece-title').textContent=payload.title;
    el('piece-meta').textContent=`${payload.systems.length} source systems · ${payload.sourceStatus} · MusicXML engraving`;
    el('source-status').textContent=payload.sourceStatus === 'complete' ? 'Source: complete' : 'Source: needs review';
    const tk = getEngine();
    const batch=[];
    try {
      for (let i=0;i<payload.systems.length;i++) {
        if (generation !== loadingGeneration || selectedSlug !== payload.slug) return;
        const s=payload.systems[i];
        message(`Engraving ${payload.title}: system ${i+1} of ${payload.systems.length}…`);
        tk.resetOptions();
        tk.setOptions({header:'none',footer:'none',pageWidth:3200,pageHeight:1100,scale:45,
          breaks:'none',adjustPageHeight:1,showTitle:false,showComposer:false});
        if (!tk.loadData(s.xml)) throw Error(`Verovio rejected ${s.id} MusicXML`);
        const svg=tk.renderToSVG(1,{});
        if (!svg.includes('<svg') || !svg.includes('class="note"') && !svg.includes('class="rest"'))
          throw Error(`Engraving for ${s.id} did not contain recognizable notation`);
        const img=await imageFromSVG(svg);
        batch.push({id:s.id,first:s.first,last:s.last,img});
        // Let the macOS interface repaint while many systems are being engraved.
        if (i % 2 === 1) await new Promise(resolve=>setTimeout(resolve,0));
      }
      if (generation !== loadingGeneration) return;
      rendered=batch;
      spread=0;
      preview();
      message(`Engraved ${batch.length} systems from MusicXML. Adjust the appearance, then export a PNG profile. Source review is still required.`,'success');
    } catch (error) { if(generation===loadingGeneration)fail(error); }
  }
  function pageGeometry(index) {
    const [W,H]=dimensions(), l=layout();
    const systems=rendered.slice(index*l.systemsPerPage,(index+1)*l.systemsPerPage);
    const width=(W-2*l.margin)*l.staffScale/100;
    const heights=systems.map(system=>width*system.img.naturalHeight/system.img.naturalWidth);
    const firstY=l.margin+l.titleHeight;
    const totalHeight=heights.reduce((a,b)=>a+b,0);
    const extra=H-l.margin-firstY-totalHeight;
    const gap=l.distribute && systems.length>1 ? Math.max(l.spacing,extra/(systems.length-1)) : l.spacing;
    let y=firstY+l.vertical;
    const placements=systems.map((system,i)=>{
      const p={image:system.img,x:(W-width)/2+l.horizontal,y,width,height:heights[i]};
      y+=heights[i]+gap;return p;
    });
    const valid=placements.every(p=>p.x>=l.margin*.15 && p.x+p.width<=W-l.margin*.15 && p.y>=0 && p.y+p.height<=H-l.margin*.4);
    return {W,H,l,placements,valid};
  }
  function makePage(pageIndex) {
    const {W,H,l,placements,valid}=pageGeometry(pageIndex);
    const c=document.createElement('canvas');c.width=W;c.height=H;
    const ctx=c.getContext('2d',{alpha:false});
    ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
    ctx.fillStyle='#171c24';ctx.textAlign='center';ctx.textBaseline='middle';
    const title=piece?.title || titleFor(selectedSlug);
    if (l.titleHeight > 0) {
      const size=title.length > 39 ? 24 : title.length > 25 ? 29 : 37;
      ctx.font=`600 ${size}px Georgia,serif`;
      ctx.fillText(title,W/2,l.margin + Math.min(l.titleHeight*.52,70),W-l.margin*2);
    }
    for (const p of placements) ctx.drawImage(p.image,p.x,p.y,p.width,p.height);
    return {canvas:c,valid};
  }
  function fitsPage(index) { return pageGeometry(index).valid; }
  function paintPreview() {
    if (!piece || !rendered.length) return;
    const profile=currentProfile(),W=dimensions()[0],H=dimensions()[1];
    const area=el('pages'); area.replaceChildren();
    const scrollerWidth=el('canvas-scroller').clientWidth - 58;
    const wideTwo=profile.screens===2 && profile.orientation==='portrait';
    const maxImageWidth=profile.orientation==='portrait' ? 480 : 670;
    const width=Math.max(150,Math.min(maxImageWidth,(wideTwo ? (scrollerWidth-40)/2 : scrollerWidth-30)));
    pageFits=Array.from({length:pagesCount()},(_,i)=>fitsPage(i)).every(Boolean);
    for(let screen=0;screen<profile.screens;screen++) {
      const pageIndex=firstPageIndex()+(profile.mirror ? 0 : screen);
      const wrapper=document.createElement('div');wrapper.className='screen';
      const label=document.createElement('div');label.className='screen-label';
      label.textContent=screen===0?'PRIMARY DISPLAY':profile.mirror?'SECONDARY · MIRRORED':'SECONDARY DISPLAY';
      const result=makePage(pageIndex);
      const c=result.canvas;c.className='score';c.style.width=width+'px';c.style.height=Math.round(width*H/W)+'px';
      if (pageIndex >= pagesCount()) {
        const ctx=c.getContext('2d');ctx.font='28px -apple-system,sans-serif';ctx.fillStyle='#9ca6b4';
        ctx.textAlign='center';ctx.fillText('No more pages',W/2,H/2);
      }
      wrapper.append(c,label);area.append(wrapper);
    }
    const count=spreadsCount();
    el('pagination').textContent=`Spread ${Math.min(spread+1,count)} of ${count} · ${pagesCount()} pages`;
    el('prev').disabled=spread<=0;
    el('next').disabled=spread>=count-1;
    el('publish').disabled=exporting || !rendered.length || !pageFits;
    if(!pageFits)message('Some music extends beyond the screen edges. Reduce music scale or systems per screen before exporting.','error');
    else if(el('notice').className==='error' && el('notice').textContent.startsWith('Some music'))message('Layout fits the preview. PNG export is ready.');
    lastPreview={profile:profileKey(),pageIndex:firstPageIndex(),valid:pageFits};
  }
  function preview() { try {updateProfileUI();paintPreview();}catch(error){fail(error);} }
  function pageChange(delta) { spread=Math.max(0,Math.min(spreadsCount()-1,spread+delta));preview(); }
  function getExportMetadata() {
    return {layout:layout(),screens:currentProfile().screens,mirrored:currentProfile().mirror,
      orientation:currentProfile().orientation,size:currentProfile().size,
      systemCount:rendered.length,systemsPerPage:layout().systemsPerPage,
      pageSystems:Array.from({length:pagesCount()},(_,i)=>rendered.slice(i*layout().systemsPerPage,(i+1)*layout().systemsPerPage).map(s=>({id:s.id,first:s.first,last:s.last})))};
  }
  function startExport() {
    if(exporting || !piece || !rendered.length || !pageFits) return;
    const count=pagesCount(), [width,height]=dimensions();
    for(let i=0;i<count;i++) {
      const result=makePage(i);
      if (!result.valid) {message(`Page ${i+1} extends beyond the screen. Adjust scale or spacing before export.`,'error');return;}
    }
    exporting=true; el('publish').disabled=true;
    for(const element of document.querySelectorAll('#pieces button, .toolbar input, .toolbar select, #inspector input, #reset, #prev, #next'))element.disabled=true;
    exporter={index:0,total:count,slug:selectedSlug,profile:profileKey()};
    message(`Preparing ${count} PNG pages…`);
    native({type:'beginExport',slug:exporter.slug,profile:exporter.profile,
      total:count,width,height,metadata:getExportMetadata()});
  }
  function endExport() {
    exporter=null;exporting=false;
    for(const element of document.querySelectorAll('#pieces button, .toolbar input, .toolbar select, #inspector input, #reset, #prev, #next'))element.disabled=false;
    updateProfileUI();preview();
  }
  function nextExportPage() {
    if(!exporter) return;
    try {
      const i=exporter.index;
      if (i>=exporter.total) {native({type:'finishExport'});return;}
      const result=makePage(i);
      if(!result.valid)throw Error(`Page ${i+1} overflowed while exporting`);
      message(`Writing PNG page ${i+1} of ${exporter.total}…`);
      native({type:'exportPage',index:i,png:result.canvas.toDataURL('image/png')});
    } catch (error) {native({type:'cancelExport'});endExport();fail(error);}
  }
  window.Debussy={
    bootstrap(payload){
      catalog=payload.pieces || [];saved=payload.state && typeof payload.state==='object' ? payload.state : {layouts:{}};
      saved.layouts ||= {};
      const p=saved.lastProfile||{};
      if ([1,2].includes(p.screens))el('screens').value=String(p.screens);
      if (['portrait','landscape'].includes(p.orientation))el('orientation').value=p.orientation;
      if (['large','small'].includes(p.size))el('size').value=p.size;
      el('mirror').checked=!!p.mirror;
      const slug=catalog.some(x=>x.slug===saved.lastPiece) ? saved.lastPiece : 'christmas-time-is-here';
      updateProfileUI();selectPiece(slug);
    },
    receivePiece(payload){if(payload.slug===selectedSlug)engrave(payload);},
    nativeError(payload){endExport();fail(payload.message || 'Native application error');},
    exportStarted(){nextExportPage();},
    pageSaved(payload){
      if (!exporter || payload.index!==exporter.index)return;
      exporter.index++;
      setTimeout(nextExportPage,0);
    },
    exportFinished(payload){endExport();message(`${payload.pages} new PNG pages exported successfully to: ${payload.folder}`,'success');}
  };
  for (const k of settings) el(k).addEventListener('input',()=>{
    const l=layout();l[k]=clamp(el(k).value,k);saveLayout(l);populateControlValues();preview();
  });
  el('distribute').addEventListener('change',()=>{const l=layout();l.distribute=el('distribute').checked;saveLayout(l);preview();});
  for (const k of ['screens','mirror','orientation','size']) el(k).addEventListener('change',profileChanged);
  el('prev').addEventListener('click',()=>pageChange(-1));el('next').addEventListener('click',()=>pageChange(1));
  el('reset').addEventListener('click',()=>{saveLayout(defaults());populateControlValues();preview();});
  el('publish').addEventListener('click',startExport);
  el('open-source').addEventListener('click',()=>native({type:'openSources'}));
  el('open-output').addEventListener('click',()=>native({type:'openPublished'}));
  document.addEventListener('keydown',event=>{
    if(event.target.closest('input,select,button') || event.metaKey || event.ctrlKey || event.altKey)return;
    if(event.key==='ArrowRight'){pageChange(1);event.preventDefault();}
    if(event.key==='ArrowLeft'){pageChange(-1);event.preventDefault();}
  });
  native({type:'ready'});
})();
