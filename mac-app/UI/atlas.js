'use strict';
/* Beat Atlas 08 — nondestructive beat inspection and review.
   MusicXML is provisional; neither selecting nor reviewing a beat changes the score.
   Every event uses exact rational quarter-note times provided by ScoreCore.
   Scan crops are registered to original barline and MusicXML x coordinates. */
(function() {
  const panel=document.getElementById('atlas-panel');
  const toggle=document.getElementById('atlas-toggle');
  const grid=document.getElementById('atlas-grid');
  const scan=document.getElementById('scan');
  const band=document.getElementById('atlas-scan-band');
  const noteField=document.getElementById('atlas-note');
  const $=id=>document.getElementById(id);
  let data=null, beats=[], reviews={}, staff=1, active=null;
  let mapped=new Set(), mappingReceived=false, sourceEventCount=0, mappingProblems=[], uncertainLayout=new Set();
  let auditText='';
  const post=(obj)=>{try {window.webkit?.messageHandlers?.piano?.postMessage(obj);}catch(e){console.warn(e);}};
  const h=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const val=t=>t.numerator/t.denominator;
  const rational=t=>t.denominator===1?String(t.numerator):`${t.numerator}/${t.denominator}`;
  const state=id=>reviews[id]?.status||'unreviewed';
  const displayStaff=s=>s===1?'RH':'LH';
  const sameMeasure=b=>beats.filter(a=>a.measure===b.measure);
  const beatForEvent=id=>beats.find(b=>b.events.some(e=>e.id===id));
  const selected=()=>beats.find(b=>b.id===active);
  function inUse(note){return !!note && !note.isRest && !note.tieContinuation;}
  function beatNames(b){
    const attacks=b.events.filter(inUse);
    if(attacks.length) return attacks.slice(0,3).map(n=>n.pitch).join(' ')+(attacks.length>3?'…':'');
    if(b.events.some(n=>n.isRest))return 'Rest';
    return b.incoming.length?'Held':'—';
  }
  function show(open) {
    document.body.classList.toggle('atlas-open',open);
    panel.setAttribute('aria-hidden',String(!open));
    toggle.setAttribute('aria-expanded',String(open));
    if(open) {render(); requestAnimationFrame(paintScan);}
  }
  function setStaff(next){
    staff=next;
    $('atlas-rh').classList.toggle('active',staff===1);
    $('atlas-lh').classList.toggle('active',staff===2);
    if(!selected()||selected().staff!==staff) active=beats.find(b=>b.staff===staff)?.id||null;
    render();
  }
  function renderGrid(){
    const choice=beats.filter(b=>b.staff===staff);
    const byMeasure=[...new Set(choice.map(b=>b.measure))];
    grid.innerHTML=byMeasure.map(measure=>{
      const tiles=choice.filter(b=>b.measure===measure);
      return `<div class="atlas-group">Measure ${h(tiles[0]?.printedMeasure??measure+1)} · ${displayStaff(staff)}</div>`+
      `<div class="atlas-beat-grid">${tiles.map(b=>{
        const st=state(b.id);
        return `<button class="atlas-beat ${active===b.id?'selected':''} ${st==='verified'?'reviewed':''} ${st==='needs-review'?'flagged':''}" data-beat="${h(b.id)}" type="button" aria-pressed="${active===b.id}">Beat ${b.beat}<span class="small">${h(beatNames(b))}</span><canvas class="atlas-mini" width="100" height="48" data-mini="${h(b.id)}" aria-hidden="true"></canvas></button>`;
      }).join('')}</div>`;
    }).join('');
    grid.querySelectorAll('[data-beat]').forEach(button=>button.addEventListener('click',()=>choose(button.dataset.beat)));
    paintMinis();
  }
  function sourceCoordinate(b){
    if(!data?.barlines || data.barlines.length<2)return null;
    const mi=b.measure-data.first;
    const left=data.barlines[mi],right=data.barlines[mi+1];
    if(!Number.isFinite(left)||!Number.isFinite(right)||right<=left)return null;
    const same=sameMeasure(b);
    const width=Math.max(1,b.measureWidth);
    const known=[];
    for(let i=0;i<4;i++) {
      const n=same.filter(z=>z.beat===i+1).flatMap(z=>z.events)
        .filter(e=>e.sourceX!==null && Math.abs(val(e.offset))<1e-7)
        .map(e=>e.sourceX);
      if(n.length)known.push({i,x:Math.min(...n)});
    }
    // Interpolate only for VISUAL crop guidance; this NEVER determines timing.
    const interpolation=[{i:-1,x:0},...known,{i:4,x:width}];
    const pts=[];
    for(let i=0;i<4;i++){
      const exact=known.find(z=>z.i===i);
      if(exact){pts.push(exact.x);continue;}
      const prev=interpolation.filter(a=>a.i<i).at(-1)??interpolation[0];
      const next=interpolation.find(a=>a.i>i)??interpolation.at(-1);
      const f=prev.i===next.i?0:(i-prev.i)/(next.i-prev.i);
      pts.push(prev.x+(next.x-prev.x)*f);
    }
    const index=b.beat-1;
    const a=index===0?0:(pts[index-1]+pts[index])/2;
    const z=index===3?width:(pts[index]+pts[index+1])/2;
    const lo=left+(Math.max(0,a)/width)*(right-left);
    const hi=left+(Math.min(width,z)/width)*(right-left);
    return {lo,hi,regionWidth:hi-lo};
  }
  function drawCrop(ctx,canvas,b) {
    ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
    if(!b||!data||!scan.complete||!scan.naturalWidth)return null;
    const x=sourceCoordinate(b);if(!x)return null;
    const W=scan.naturalWidth,H=scan.naturalHeight;
    const upper=Number(data.scanUpperStaffTopPx)||130;
    const lower=Number(data.scanLowerStaffTopPx)||350;
    const ss=Number(data.scanStaffSpacePx)||17;
    const staffTop=b.staff===1?upper:lower;
    const y0=Math.max(0,staffTop-ss*3.2), y1=Math.min(H,staffTop+ss*7.3);
    const sx=Math.max(0,x.lo*W-ss*2), ex=Math.min(W,x.hi*W+ss*2);
    const sw=Math.max(1,ex-sx),sh=Math.max(1,y1-y0);
    const scale=Math.min(canvas.width/sw,canvas.height/sh);
    const dw=sw*scale,dh=sh*scale;
    ctx.drawImage(scan,sx,y0,sw,sh,(canvas.width-dw)/2,(canvas.height-dh)/2,dw,dh);
    return {x,y0,y1,H};
  }
  function paintMinis() {
    if(!scan.complete||!scan.naturalWidth)return;
    grid.querySelectorAll('canvas[data-mini]').forEach(c=>{
      const b=beats.find(z=>z.id===c.dataset.mini);
      if(b)drawCrop(c.getContext('2d'),c,b);
    });
  }
  function paintScan(){
    const b=selected();
    const canvas=$('atlas-crop');
    band.style.display='none';
    const result=drawCrop(canvas.getContext('2d'),canvas,b);
    if(!result)return;
    const {x,y0,y1,H}=result;
    const sh=y1-y0;
    const outer=scan.getBoundingClientRect();
    band.style.display='block';
    band.style.left=`${x.lo*100}%`;
    band.style.width=`${Math.max(0,x.regionWidth)*100}%`;
    band.style.top=`${(y0/H)*outer.height}px`;
    band.style.height=`${(sh/H)*outer.height}px`;
  }
  function checkMapped(b) {
    const ids=b.events.map(e=>e.id);
    const missing=mappingReceived?ids.filter(id=>!mapped.has(id)):[];
    const supplyProblems=mappingProblems.filter(p=>p.kind==='supply' && p.measure===b.measure+1 && p.staff===b.staff);
    const positionUnknown=ids.filter(id=>uncertainLayout.has(id));
    return {total:ids.length,missing,supplyProblems,positionUnknown,
      ready:mappingReceived && missing.length===0 && supplyProblems.length===0 && positionUnknown.length===0};
  }
  function category(title,inner){return `<div class="atlas-category"><strong>${h(title)}</strong>${inner}</div>`;}
  function rowTime(x){return x==='0'?'On beat':`+${x} quarter notes`;}
  function renderDetail(){
    const b=selected(); if(!b)return;
    $('atlas-title').textContent=`Measure ${b.printedMeasure} · ${displayStaff(b.staff)} · Beat ${b.beat}`;
    const incoming=b.incoming.length?b.incoming.map(e=>`<div class="atlas-event">${h(e.pitch)} · voice ${h(e.voice)} · held into beat</div>`).join(''):'<p>None</p>';
    const events=b.events.length?b.events.map(e=>{
      const kind=e.isRest?'Rest':e.tieContinuation?'Tied continuation':e.isGrace?'Grace note':'Attack';
      const art=e.articulation.length?` · ${h(e.articulation.join(', '))}`:'';
      return `<div class="atlas-event"><button class="atlas-event-select" data-event="${h(e.id)}" title="Select this event in notation" style="cursor:pointer;padding:0;background:none;border:0;text-align:left;font:inherit;color:inherit"><b>${h(kind)}</b> ${h(e.pitch)} · voice ${h(e.voice)} · ${h(rowTime(rational(e.offset)))} · duration ${h(rational(e.duration))}${art}</button></div>`;
    }).join(''):'<p>No attack or rest event begins in this beat</p>';
    const releases=b.releases.length?b.releases.map(e=>`<div class="atlas-event">${h(e.pitch)} · voice ${h(e.voice)} · release +${h(rational(e.offset))}</div>`).join(''):'<p>None</p>';
    $('atlas-categories').innerHTML=category('1 · Entering state',incoming)+category('2 · Events within beat',events)+category('3 · Releases',releases);
    $('atlas-categories').querySelectorAll('[data-event]').forEach(el=>el.addEventListener('click',()=>post({type:'selectEvent',id:el.dataset.event})));
    const check=checkMapped(b);
    const problems=mappingProblems.filter(p=>p.kind!=='supply' && p.measure===b.measure+1 && p.staff===b.staff && p.missing.some(id=>check.missing.includes(id)));
    const diagnosis=problems.map(p=>`<div style="margin-top:7px"><b>Voice ${h(p.voice)}:</b> ${p.total-p.missing.length}/${p.total} matched; SVG layer event counts: ${h(p.layerSizes.join(', ')||'none')}; staff SVG events: ${p.svgStaffEvents}; rhythmic groups: ${h((p.layerUnits||[]).join(', ')||'none')}; chord containers: ${h((p.layerChords||[]).join(', ')||'none')}. This is a voice/layer mapping diagnostic, not a transcription correction.</div>`).join('');
    const shortage=check.supplyProblems.map(p=>`<div class="atlas-events-warning"><b>Missing or extra SVG glyphs:</b> measure ${h(p.measure)}, staff ${h(p.staff)} has ${h(p.actual)} rendered note/rest glyphs but ${h(p.expected)} source events. Verification is blocked even if the event mapper claims success. This is an engraving-input problem, not evidence of incorrect notes.</div>`).join('');
    $('atlas-map-warning').innerHTML=(check.missing.length
      ? `<div class="atlas-events-warning">${check.missing.length}/${check.total} source events in this beat were not mapped to SVG glyphs. This is a rendering problem until proven otherwise. Verification is blocked. IDs: ${h(check.missing.join(', '))}${diagnosis}</div>`
      : !mappingReceived?'<div class="atlas-events-warning">Waiting for a complete engraving/mapping pass. Verification is unavailable.</div>'
      : '')+shortage+(check.positionUnknown.length
      ? `<div class="atlas-events-warning">${check.positionUnknown.length} event(s) have unresolved or provisional engraving positions. The note glyphs exist, but the scanned locations are not yet independently established, so verification is blocked. IDs: ${h(check.positionUnknown.join(', '))}</div>`
      : '');
    $('atlas-verify').disabled=!check.ready;
    noteField.value=reviews[b.id]?.note||'';
    $('atlas-audit').textContent=auditText;
    paintScan();
  }
  function choose(id){
    if(!beats.some(b=>b.id===id))return;
    persistNote();
    active=id; auditText='';
    renderGrid();renderDetail();
  }
  function render(){
    if(!data)return;
    $('atlas-summary').textContent=`Measures ${data.first+1}–${Math.max(...beats.map(b=>b.measure))+1} · ${beats.length} staff-beats · MusicXML provisional · ${Object.values(reviews).filter(v=>v.status==='verified').length} verified in piece`;
    renderGrid();renderDetail();
  }
  function persistNote(){
    const b=selected();if(!b)return;
    const current=reviews[b.id]?.note||'';
    if(noteField.value===current)return;
    const status=state(b.id);
    reviews[b.id]={status,note:noteField.value};
    post({type:'reviewBeat',id:b.id,status,note:noteField.value});
  }
  function mark(status){
    const b=selected();if(!b)return;
    if(status==='verified'&&!checkMapped(b).ready)return;
    const note=noteField.value;
    reviews[b.id]={status,note};
    post({type:'reviewBeat',id:b.id,status,note});
    auditText=status==='verified'?'Manually verified. No MusicXML content changed.':status==='needs-review'?'Flagged for review. No MusicXML content changed.':'Review status cleared.';
    render();
  }
  function retranscribe(){
    const b=selected();if(!b)return;
    const check=checkMapped(b);
    // Deliberately do not alter source.musicxml: missing SVG elements are not
    // evidence for a different note. Pixel-ranked inverse engraving is not yet implemented.
    const explanations=check.supplyProblems.length
      ? `Incomplete engraving: ${check.supplyProblems.map(p=>`measure ${p.measure} staff ${p.staff}: ${p.actual}/${p.expected} glyphs`).join('; ')}. Mapping alone cannot prove that the transcription has been rendered. Fix the engraving input before considering alternate notes.`
      : check.missing.length
      ? `Mapping failure: ${check.missing.length}/${check.total} note/rest glyphs missing. IDs: ${check.missing.join(', ')}. Fix event-to-glyph association before considering alternate notes.`
      : `All ${check.total} source events map to SVG glyphs. The scan crop is registered; no automatic pixel-ranked alternative candidate is available in this first atlas build.`;
    const detail=`Retranscribe preflight · measure ${b.printedMeasure}, ${displayStaff(b.staff)}, beat ${b.beat}\n${explanations}\nOriginal MusicXML unchanged. This beat has been flagged for review.`;
    mark('needs-review');
    auditText=detail;
    $('atlas-audit').textContent=auditText;
  }
  $('atlas-rh').addEventListener('click',()=>{persistNote();setStaff(1);});
  $('atlas-lh').addEventListener('click',()=>{persistNote();setStaff(2);});
  toggle.addEventListener('click',()=>show(!document.body.classList.contains('atlas-open')));
  $('atlas-close').addEventListener('click',()=>{persistNote();show(false);});
  $('atlas-export').addEventListener('click',()=>post({type:'exportAtlas'}));
  $('atlas-verify').addEventListener('click',()=>mark('verified'));
  $('atlas-flag').addEventListener('click',()=>mark('needs-review'));
  $('atlas-clear').addEventListener('click',()=>mark('unreviewed'));
  $('atlas-retranscribe').addEventListener('click',retranscribe);
  noteField.addEventListener('change',persistNote);
  scan.addEventListener('load',()=>requestAnimationFrame(()=>{paintMinis();paintScan();}));
  window.addEventListener('resize',()=>requestAnimationFrame(paintScan));
  window.PianoBeatAtlas={
    onSystem(next){
      persistNote();data=next;
      beats=Array.isArray(next.atlas)?next.atlas:[];
      reviews=next.reviews||{};
      mapped=new Set();mappingReceived=false;sourceEventCount=0;mappingProblems=[];uncertainLayout=new Set();
      const note=beatForEvent(next.selected);
      if(note) {staff=note.staff;active=note.id;}
      else if(!beats.find(b=>b.id===active))active=beats.find(b=>b.staff===staff)?.id||null;
      $('atlas-rh').classList.toggle('active',staff===1);
      $('atlas-lh').classList.toggle('active',staff===2);
      auditText='';render();
    },
    onSelection(id){
      if(!document.body.classList.contains('atlas-open'))return;
      const b=beatForEvent(id);
      if(!b || b.id===active)return;
      persistNote();staff=b.staff;active=b.id;
      $('atlas-rh').classList.toggle('active',staff===1);
      $('atlas-lh').classList.toggle('active',staff===2);
      auditText='';render();
    },
    onMapping(ids,count,problems=[],unplaced=[]){ mapped=ids;sourceEventCount=count;mappingProblems=problems;uncertainLayout=new Set(unplaced);mappingReceived=true;renderDetail(); },
    getCurrentBeat(){return selected();}
  };
})();
