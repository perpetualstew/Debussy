'use strict';
/* Piano Library 32 — nondestructive per-piece freehand review marks.
   Mark coordinates are fractions of the scan or notation pane; they remain
   aligned during resizing, scroll, re-engraving and system navigation.
   macOS persists completed marks and owns Copy Notes' pasteboard operation. */
(function() {
  const ns='http://www.w3.org/2000/svg';
  const $=id=>document.getElementById(id);
  const overlays={scan:$('ink-scan'),notation:$('ink-notation')};
  const btn=$('pen-toggle'),copyButton=$('copy-notes'),feedback=$('copy-notes-feedback');
  const dialog=$('review-editor'),field=$('review-editor-text');
  const deleteButton=$('review-editor-delete');
  const measureChoice=$('review-editor-measure'),staffChoice=$('review-editor-staff');
  let active=false,system=null,marks=[],stroke=null,draft=null,allSystemBarlines=[];
  let focusedID=null;
  let feedbackTimer=null;
  const post=obj=>{try {(window.PianoHostPost||((m)=>window.webkit?.messageHandlers?.piano?.postMessage(m)))({...obj,pieceSlug:system?.pieceSlug,systemFirst:Number(system?.first)});}catch(e){console.warn('Review pen bridge:',e);}};
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  const validPoint=p=>Array.isArray(p)&&p.length===2&&p.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1);
  const validMark=m=>m&&typeof m.id==='string'&&['scan','notation'].includes(m.pane)&&Array.isArray(m.points)&&m.points.length>=2&&m.points.every(validPoint);
  const cleanText=t=>String(t||'').trim().slice(0,2000);
  const newID=()=>`ink-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  const currentFirst=()=>Number(system?.first)||0;
  function pointsPath(points) {
    return points.map((p,i)=>`${i?'L':'M'}${(p[0]*1000).toFixed(2)} ${(p[1]*1000).toFixed(2)}`).join(' ');
  }
  function addPath(svg,cls,points,id) {
    const p=document.createElementNS(ns,'path');
    p.setAttribute('class',cls);
    p.setAttribute('d',pointsPath(points));
    if(id)p.dataset.markId=id;
    svg.appendChild(p);
    return p;
  }
  function display() {
    Object.values(overlays).forEach(svg=>svg.replaceChildren());
    const here=marks.filter(m=>m.systemFirst===currentFirst());
    for(const m of here){
      if(!validMark(m))continue;
      const svg=overlays[m.pane];
      addPath(svg,m.id===focusedID?'ink-stroke ink-focused':'ink-stroke',m.points);
      addPath(svg,'ink-hit',m.points,m.id);
    }
    if(stroke && stroke.points.length>1)addPath(overlays[stroke.pane],'ink-stroke',stroke.points);
    if(draft && !draft.existing)addPath(overlays[draft.pane],'ink-stroke',draft.points);
    copyButton.textContent=`Copy Notes (${marks.length})`;
  }
  function feedbackText(t) {
    feedback.textContent=t;
    if(feedbackTimer)clearTimeout(feedbackTimer);
    feedbackTimer=setTimeout(()=>{feedback.textContent='';feedbackTimer=null;},2200);
  }
  function inkPoint(pane,ev) {
    const r=overlays[pane].getBoundingClientRect();
    return [clamp((ev.clientX-r.left)/Math.max(1,r.width),0,1),clamp((ev.clientY-r.top)/Math.max(1,r.height),0,1)];
  }
  function positionDialog(x,y){
    dialog.classList.add('visible');
    const w=dialog.offsetWidth,h=dialog.offsetHeight;
    dialog.style.left=`${clamp(x+13,9,Math.max(9,window.innerWidth-w-9))}px`;
    dialog.style.top=`${clamp(y+12,9,Math.max(9,window.innerHeight-h-9))}px`;
  }
  function openEditor(mark,x,y,existing=false) {
    if(draft)resolveDraft(false);
    draft={...mark,existing};
    field.value=mark.note||'';
    if(system?.reviewMode==='draft'){
      measureChoice.replaceChildren();
      const first=Number(system?.first)||0,last=Number(system?.last)||first;
      for(let m=first+1;m<=last+1;m++){
        const option=document.createElement('option');option.value=String(m);option.textContent=`m${m}`;
        measureChoice.appendChild(option);
      }
      const unknown=document.createElement('option');unknown.value='';unknown.textContent='Unknown';
      measureChoice.prepend(unknown);
      measureChoice.value=mark.measure===null||mark.measure===undefined?'':String(mark.measure);
      staffChoice.value=mark.staff||'';
    }
    deleteButton.hidden=!existing;
    positionDialog(x,y);
    display();
    field.focus();field.select();
  }
  function resolveDraft(save,erase=false){
    const old=draft;
    if(!old)return;
    draft=null;dialog.classList.remove('visible');
    const note=save&&!erase?cleanText(field.value):'';
    if(erase){marks=marks.filter(m=>m.id!==old.id);post({type:'deleteReviewMark',id:old.id});}
    else if(note){
      const manual=system?.reviewMode==='draft';
      const m={id:old.id,systemFirst:old.systemFirst,pane:old.pane,points:old.points,note,
        measure:manual?(Number(measureChoice.value)||null):markMeasure(old),
        staff:manual?(staffChoice.value||null):old.staff};
      if(validMark(m)){
        const i=marks.findIndex(v=>v.id===m.id);
        if(i>=0)marks[i]=m;else marks.push(m);
        post({type:'saveReviewMark',mark:m});
      }
    } else if(old.existing){
      // Blank notes are not valid saved annotations; editing to blank deletes.
      if(save){marks=marks.filter(m=>m.id!==old.id);post({type:'deleteReviewMark',id:old.id});}
    }
    display();
  }
  // Ink and barlines are both normalized fractions, never pixel coordinates.
  // V32 erroneously multiplied normalized ink x by the scan width, which made
  // nearly every reported mark look like the system's final measure.
  function measureAtX(first,x){
    const item=allSystemBarlines.find(s=>s.first===first);
    const bars=item?.barlines||(first===currentFirst()?system?.barlines:[]);
    if(!bars||bars.length<2||!Number.isFinite(x))return null;
    for(let i=0;i<bars.length-1;i++)if(x<bars[i+1])return first+i+1;
    return first+bars.length-1;
  }
  function markMeasure(mark){
    if(!mark?.points?.length)return mark.measure??null;
    const x=mark.points.reduce((a,p)=>a+p[0]/mark.points.length,0);
    return measureAtX(mark.systemFirst,x)??mark.measure??null;
  }
  function inferLocation(pane,points){
    const center=points.reduce((s,p)=>[s[0]+p[0]/points.length,s[1]+p[1]/points.length],[0,0]);
    // The engraving and scan share horizontal barlines. The precise scan
    // reference always wins when available; uncertain position stays blank.
    const measure=measureAtX(currentFirst(),center[0]);
    // Render y is pane-relative, not scan-relative. Only a scan mark's
    // vertical position can be mapped to the original source staff labels.
    let staff=null;
    if(pane==='scan'){
      const py=center[1]*Number(system.scanHeightPx||$('scan').naturalHeight||1);
      const top=Number(system.scanUpperStaffTopPx),lower=Number(system.scanLowerStaffTopPx);
      const space=Number(system.scanStaffSpacePx)||17;
      if(Number.isFinite(top)&&Number.isFinite(lower)){
        const upperMiddle=top+2*space,lowerMiddle=lower+2*space;
        staff=Math.abs(py-upperMiddle)<=Math.abs(py-lowerMiddle)?'RH':'LH';
      }
    }
    return {measure,staff};
  }
  function down(pane,ev,markTarget=ev.target){
    if(ev.button!==0)return;
    const hit=markTarget?.closest?.('[data-mark-id]');
    // Shift-click removes an existing mark immediately, even outside Pen mode.
    // Normal clicking still opens the editor and preserves all existing notes.
    if(ev.shiftKey && hit){
      const id=hit.dataset.markId;
      if(marks.some(m=>m.id===id)){
        ev.preventDefault();ev.stopPropagation();
        if(draft)resolveDraft(true);
        marks=marks.filter(m=>m.id!==id);
        post({type:'deleteReviewMark',id});display();
      }
      return;
    }
    if(!active&&!ev.shiftKey&&!hit)return;
    if(draft)resolveDraft(true);
    if(hit){
      const m=marks.find(m=>m.id===hit.dataset.markId);
      if(m){ev.preventDefault();ev.stopPropagation();openEditor(m,ev.clientX,ev.clientY,true);return;}
    }
    const overlay=overlays[pane];
    ev.preventDefault();
    stroke={pane,points:[inkPoint(pane,ev)],pointerId:ev.pointerId,clientX:ev.clientX,clientY:ev.clientY};
    overlay.setPointerCapture(ev.pointerId);
  }
  function move(pane,ev){
    if(!stroke||stroke.pane!==pane||stroke.pointerId!==ev.pointerId)return;
    const p=inkPoint(pane,ev);
    const last=stroke.points[stroke.points.length-1];
    const r=overlays[pane].getBoundingClientRect();
    if(Math.hypot((p[0]-last[0])*r.width,(p[1]-last[1])*r.height)<1.8)return;
    stroke.points.push(p);
    stroke.clientX=ev.clientX;stroke.clientY=ev.clientY;
    display();
  }
  function up(pane,ev){
    if(!stroke||stroke.pane!==pane||stroke.pointerId!==ev.pointerId)return;
    const completed=stroke;stroke=null;
    const bounds=overlays[pane].getBoundingClientRect();
    const pts=completed.points;
    const dist=pts.reduce((s,p,i)=>i?s+Math.hypot((p[0]-pts[i-1][0])*bounds.width,(p[1]-pts[i-1][1])*bounds.height):0,0);
    display();
    if(pts.length<3||dist<10)return;
    const where=inferLocation(pane,pts);
    openEditor({id:newID(),systemFirst:currentFirst(),pane,points:pts,
      note:'',measure:where.measure,staff:where.staff},completed.clientX,completed.clientY);
  }
  function setActive(value){
    if(draft)resolveDraft(true);
    stroke=null;active=!!value;
    document.body.classList.toggle('pen-active',active);
    btn.setAttribute('aria-pressed',String(active));
    btn.textContent=active?'Pen ✓':'Pen';display();
  }
  Object.entries(overlays).forEach(([pane,svg])=>{
    svg.addEventListener('pointerdown',e=>down(pane,e));
    svg.addEventListener('pointermove',e=>move(pane,e));
    svg.addEventListener('pointerup',e=>up(pane,e));
    svg.addEventListener('pointercancel',e=>{if(stroke?.pointerId===e.pointerId){stroke=null;display();}});
  });
  // Normal clicks edit saved marks; Shift temporarily enables drawing or deletion.
  const markShift=event=>document.body.classList.toggle('review-shift-held',!!event.shiftKey);
  document.addEventListener('keydown',markShift);
  document.addEventListener('keyup',markShift);
  document.addEventListener('pointermove',markShift);
  // A modifier can arrive from the host frame without a local keydown.
  // Route the initial Shift press before a symbol hitbox can consume it.
  document.addEventListener('pointerdown',event=>{
    markShift(event);
    if(!event.shiftKey||event.button!==0||dialog.contains(event.target))return;
    const container=event.target.closest?.('#scan-pane,#notation-pane');
    if(!container)return;
    const pane=container.id==='scan-pane'?'scan':'notation';
    const target=document.elementFromPoint(event.clientX,event.clientY);
    down(pane,event,target);event.stopPropagation();
  },true);

  window.addEventListener('blur',()=>document.body.classList.remove('review-shift-held'));
  btn.addEventListener('click',()=>setActive(!active));
  $('review-editor-save').addEventListener('click',()=>resolveDraft(true));
  $('review-editor-cancel').addEventListener('click',()=>resolveDraft(false));
  deleteButton.addEventListener('click',()=>resolveDraft(false,true));
  document.addEventListener('pointerdown',e=>{
    if(draft&&!dialog.contains(e.target))resolveDraft(true);
  },true);
  for(const control of [field,measureChoice,staffChoice]){
    control.addEventListener('focus',()=>post({type:'reviewFieldFocus',focused:true}));
    control.addEventListener('blur',()=>queueMicrotask(()=>post({type:'reviewFieldFocus',
      focused:[field,measureChoice,staffChoice].includes(document.activeElement)})));
  }
  field.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();resolveDraft(false);}
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();e.stopPropagation();resolveDraft(true);}
  });
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&draft){e.preventDefault();resolveDraft(false);}
    else if(e.key==='Escape'&&active){e.preventDefault();setActive(false);}
  });
  function reportText(){
    const title=system?.pieceTitle||'Piano Library';
    const lines=[`Piano Library — annotated review: ${title}`,`Notes: ${marks.length}`,`Locations are relative to the scanned system or rendered notation; circles are stored in the application.`, ''];
    const ordered=[...marks].sort((a,b)=>a.systemFirst-b.systemFirst||(markMeasure(a)??0)-(markMeasure(b)??0));
    ordered.forEach((m,i)=>{
      const pts=m.points||[];
      const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
      const bounds=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)].map(v=>(v*100).toFixed(1));
      const midX=(Number(bounds[0])+Number(bounds[2]))/2,midY=(Number(bounds[1])+Number(bounds[3]))/2;
      const corrected=markMeasure(m);
      const loc=corrected?`m${corrected}`:`system starting m${m.systemFirst+1}`;
      const hand=m.staff?` · ${m.staff}`:'';
      lines.push(`${i+1}. ${loc}${hand} · ${m.pane==='scan'?'scan':'rendered notation'}`);
      lines.push(`   Mark: center ${midX.toFixed(1)}% across / ${midY.toFixed(1)}% down, bounds x ${bounds[0]}–${bounds[2]}%, y ${bounds[1]}–${bounds[3]}%`);
      lines.push('   '+m.note.trim().replace(/\n/g,'\n   '),'');
    });
    return lines.join('\n').trim()+'\n';
  }
  copyButton.addEventListener('click',()=>{
    if(draft)resolveDraft(true);
    if(!marks.length){feedbackText('No saved notes');return;}
    copyButton.disabled=true;feedbackText('Copying…');
    post({type:'copyReviewNotes',text:reportText()});
  });
  window.pianoReviewNotesCopyDidFinish=ok=>{copyButton.disabled=false;feedbackText(ok?'Copied ✓':'Copy failed');};
  window.PianoReviewPen={flush:()=>{if(draft)resolveDraft(true);},onSystem(data){
    if(draft)resolveDraft(true);
    stroke=null;system=data;
    focusedID=null;
    if(Array.isArray(data.allSystemBarlines))allSystemBarlines=data.allSystemBarlines;
    if(Array.isArray(data.reviewMarks))marks=data.reviewMarks.filter(validMark);
    display();
  },focusMark(id){
    if(draft)resolveDraft(true);
    const m=marks.find(mark=>mark.id===id && mark.systemFirst===currentFirst());
    if(!m)return false;
    focusedID=id;display();
    const svg=overlays[m.pane];
    const x=m.points.reduce((sum,p)=>sum+p[0],0)/m.points.length;
    const y=m.points.reduce((sum,p)=>sum+p[1],0)/m.points.length;
    const rect=svg.getBoundingClientRect();
    const targetY=rect.top+rect.height*y;
    const scroll=$('score-scroll');
    if(scroll)scroll.scrollTop+=targetY-(scroll.getBoundingClientRect().top+scroll.clientHeight*.48);
    const suffix=m.measure?`m${m.measure}`:`system m${m.systemFirst+1}`;
    feedback.textContent=`${suffix} · ${m.note.slice(0,110)}`;
    return true;
  },getMarks:()=>marks.slice(),setActive};
  display();
})();
