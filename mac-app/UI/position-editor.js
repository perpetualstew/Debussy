'use strict';
/* Nondestructive engraving-position editor. Never changes the MusicXML or note/beat mapping.
   User overrides are measured in scan staff-spaces, saved by the macOS host, and
   reapplied only AFTER the usual v52 scan-alignment and optical passes finish. */
(function(){
  const pane=document.getElementById('notation-pane');
  const notation=document.getElementById('notation');
  const overlay=document.getElementById('position-hitboxes');
  const reset=document.getElementById('position-reset');
  const undoButton=document.getElementById('position-undo');
  const redoButton=document.getElementById('position-redo');
  const message=document.getElementById('position-message');
  const editorTypes=['fermata','artic','dynam','dir','tempo','repeatMark','tupletNum','trill','ornament'];
  const selector=editorTypes.map(x=>'g.'+x).join(',');
  const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
  let system=null,entries=new Map(),offsets={},chosen=null,drag=null,history=[],future=[];
  let currentSpace=12;
  const post=payload=>{try{(window.PianoHostPost||((m)=>window.webkit?.messageHandlers?.piano?.postMessage(m)))({...payload,pieceSlug:system?.pieceSlug,systemFirst:Number(system?.first)});}catch(e){console.warn('Position editor host:',e);}};
  const point=v=>Number.isFinite(v)?Math.round(clamp(v,-25,25)*10000)/10000:0;
  const positionKey=(first,mi,kind,index)=>`s${first}-${kind}-m${mi}-i${index}`;
  const setMessage=text=>{message.textContent=text||'';};
  function getSpace(){
    const img=document.getElementById('scan');
    const width=Number(system?.scanWidthPx)||img.naturalWidth;
    const space=Number(system?.scanStaffSpacePx)||18;
    const rect=img.getBoundingClientRect();
    const n=width>0 && rect.width>0 ? space*rect.width/width : 12;
    return Number.isFinite(n)&&n>0.8 ? n : 12;
  }
  function translateInScreenPixels(el,dx,dy){
    const m=el.getScreenCTM();
    if(!m)return;
    const det=m.a*m.d-m.b*m.c;
    if(!Number.isFinite(det)||Math.abs(det)<1e-11)return;
    const localX=(m.d*dx-m.c*dy)/det;
    const localY=(m.a*dy-m.b*dx)/det;
    const base=el.dataset.positionBaseTransform??'';
    el.setAttribute('transform',`${base} translate(${localX.toFixed(6)} ${localY.toFixed(6)})`.trim());
  }
  function updateEntry(entry,x,y){
    const {node}=entry;
    // Restore the immutable native alignment transform before every application.
    // An already adjusted SVG is NEVER used as the base for a second offset.
    const initial=node.dataset.positionBaseTransform??'';
    if(initial)node.setAttribute('transform',initial);else node.removeAttribute('transform');
    entry.x=point(x);entry.y=point(y);
    if(entry.x||entry.y)node.dataset.positionOverride='true';else delete node.dataset.positionOverride;
    if(entry.x||entry.y)translateInScreenPixels(node,entry.x*currentSpace,entry.y*currentSpace);
    placeHitbox(entry);
  }
  function placeHitbox(entry){
    if(!entry.hit)return;
    const b=entry.node.getBoundingClientRect(),p=pane.getBoundingClientRect();
    if(!b.width&&!b.height)return;
    const line=entry.node.localName==='line';
    const inset=line?2:5;
    const w=Math.max(line?6:20,b.width+inset*2),h=Math.max(line?6:20,b.height+inset*2);
    entry.hit.style.left=`${b.left-p.left-inset-(w-(b.width+inset*2))/2}px`;
    entry.hit.style.top=`${b.top-p.top-inset-(h-(b.height+inset*2))/2}px`;
    entry.hit.style.width=w+'px';entry.hit.style.height=h+'px';
  }
  function refresh(){
    currentSpace=getSpace();
    for(const e of entries.values()){
      const o=offsets[e.key]||{x:0,y:0};
      updateEntry(e,o.x,o.y);
    }
    updateSelection();
  }
  function collect(){
    const svg=notation.querySelector('svg');
    entries.clear();overlay.replaceChildren();chosen=null;
    if(!svg)return;
    currentSpace=getSpace();
    const owned=new Set();
    const fixedRuling=node=>!!node.closest('g.ledgerLines')||
      (node.localName==='line'&&node.closest('#staff-rules')&&node.getAttribute('y1')===node.getAttribute('y2'));
    function register(node,key,kind){
      if(fixedRuling(node)||node.closest('defs,g.notehead')||node.querySelector('g.notehead'))return;
      const box=node.getBoundingClientRect();
      if(!box.width&&!box.height)return;
      const entry={key,node,kind,hit:null,x:0,y:0};
      if(!Object.prototype.hasOwnProperty.call(node.dataset,'positionBaseTransform'))
        node.dataset.positionBaseTransform=node.getAttribute('transform')||'';
      entries.set(key,entry);owned.add(node);
      node.dataset.positionKey=key;
      const hit=document.createElement('div');hit.className='position-hitbox';hit.title=kind+' · drag to move · Shift-drag to annotate';
      hit.dataset.positionKey=key;entry.hit=hit;
      hit.addEventListener('pointerdown',ev=>begin(ev,entry));overlay.appendChild(hit);
      const value=offsets[key]||{x:0,y:0};updateEntry(entry,value.x,value.y);
    }
    const measures=[...svg.querySelectorAll('g.measure')];
    // Preserve existing keys so all previously saved edits still apply.
    measures.forEach((measure,mi)=>{
      for(const kind of editorTypes){
        const matches=[...measure.querySelectorAll('g.'+kind)].filter(el=>{
          if(!el.getBoundingClientRect().width||!el.getBoundingClientRect().height)return false;
          return ![...el.parentElement?.closest('g.measure')?.querySelectorAll('g.'+kind)||[]].some(parent=>parent!==el&&parent.contains(el));
        });
        matches.forEach((node,i)=>register(node,positionKey(Number(system?.first)||0,mi,kind,i),kind));
      }
    });
    const covered=node=>[...owned].some(parent=>parent===node||parent.contains(node));
    const counts=new Map();
    function extra(node,kind){
      if(covered(node)||node.closest('defs,g.notehead,.pl-selection-halo')||node.querySelector('g.notehead'))return;
      const mi=measures.indexOf(node.closest('g.measure'));
      const family=mi+':'+kind,i=counts.get(family)||0;counts.set(family,i+1);
      register(node,positionKey(Number(system?.first)||0,mi,'object-'+kind,i),kind);
    }
    // Musical groups remain one movable object, including accidentals,
    // stems, rests, signatures, spans and arpeggios. Never move a note owner.
    const kinds=['accid','stem','flag','rest','mRest','clef','keySig','meterSig','arpeg','tie','slur','hairpin','pedal','octave','octaveShift','ottava','beam','mNum'];
    for(const kind of kinds)for(const node of svg.querySelectorAll('g.'+kind))extra(node,kind);
    // Generated scan-backed labels/spans may live outside measure groups.
    // Collect their text and remaining graphic primitives as well.
    for(const root of [document.getElementById('staff-rules'),svg]){
      for(const node of root.querySelectorAll('text,use,path,line,polyline,polygon,circle,ellipse,rect'))extra(node,node.localName);
    }
    // Large line hit areas must stay behind small symbols and labels.
    [...entries.values()].sort((a,b)=>{
      const x=a.node.getBoundingClientRect(),y=b.node.getBoundingClientRect();return Math.max(8,y.width)*Math.max(8,y.height)-Math.max(8,x.width)*Math.max(8,x.height);
    }).forEach(e=>overlay.appendChild(e.hit));
    updateSelection();
  }
  function persist(entry){
    const x=point(entry.x),y=point(entry.y);
    if(x===0&&y===0)delete offsets[entry.key];else offsets[entry.key]={x,y};
    post({type:'savePositionOffset',pieceSlug:system?.pieceSlug,systemFirst:Number(system?.first),id:entry.key,x,y});
  }
  function commit(entry,before,after){
    if(!entry)return;
    if(Math.abs(before.x-after.x)<0.0001&&Math.abs(before.y-after.y)<0.0001)return;
    history.push({key:entry.key,before,after});if(history.length>120)history.shift();
    future=[];persist(entry);updateSelection();
  }
  function begin(ev,entry){
    if(ev.button!==0||ev.shiftKey||document.body.classList.contains('pen-active'))return;
    ev.preventDefault();ev.stopPropagation();
    chosen=entry.key;
    const before={x:entry.x,y:entry.y};
    drag={entry,before,clientX:ev.clientX,clientY:ev.clientY,pointerId:ev.pointerId};
    entry.hit.setPointerCapture(ev.pointerId);
    entry.hit.addEventListener('pointermove',move);
    entry.hit.addEventListener('pointerup',finish);
    entry.hit.addEventListener('pointercancel',cancel);
    updateSelection();
  }
  function move(ev){
    if(!drag||ev.pointerId!==drag.pointerId)return;
    const {entry,before,clientX,clientY}=drag;
    const x=point(before.x+(ev.clientX-clientX)/currentSpace);
    const y=point(before.y+(ev.clientY-clientY)/currentSpace);
    updateEntry(entry,x,y);
  }
  function stop(ev,revert){
    if(!drag||ev.pointerId!==drag.pointerId)return;
    const {entry,before}=drag;
    entry.hit.removeEventListener('pointermove',move);
    entry.hit.removeEventListener('pointerup',finish);
    entry.hit.removeEventListener('pointercancel',cancel);
    if(entry.hit.hasPointerCapture(ev.pointerId))entry.hit.releasePointerCapture(ev.pointerId);
    if(revert)updateEntry(entry,before.x,before.y);
    else commit(entry,before,{x:entry.x,y:entry.y});
    drag=null;
  }
  function finish(ev){stop(ev,false);}
  function cancel(ev){stop(ev,true);}
  function updateSelection(){
    for(const e of entries.values())e.hit?.classList.toggle('selected',e.key===chosen);
    // The host uses this ONLY for the explicit symbol Undo/Redo shortcut.
    post({type:'positionEditingState',active:!!chosen});
    const has=chosen&&entries.has(chosen);
    reset.disabled=!has;undoButton.disabled=!history.length;redoButton.disabled=!future.length;
    if(!has)setMessage('Drag any symbol or text · Shift-drag to annotate · Option + arrows to nudge');
    if(has){
      const e=entries.get(chosen);
      setMessage(`${e.kind} · X ${e.x.toFixed(2)} / Y ${e.y.toFixed(2)} staff spaces · arrows nudge · Shift = larger steps`);
    }
  }
  function selectedChange(x,y){
    const e=entries.get(chosen);if(!e)return false;
    const before={x:e.x,y:e.y};updateEntry(e,x,y);commit(e,before,{x:e.x,y:e.y});return true;
  }
  function nudge(direction,coarse=false){
    if(!chosen)return false;
    const e=entries.get(chosen);if(!e)return false;
    const d=coarse?0.5:0.1;
    return selectedChange(e.x+(direction==='left'?-d:direction==='right'?d:0),e.y+(direction==='up'?-d:direction==='down'?d:0));
  }
  function travel(forward){
    const src=forward?history:future,dst=forward?future:history;
    const action=src.pop();if(!action){updateSelection();return false;}
    const value=forward?action.before:action.after;
    const e=entries.get(action.key);if(e){chosen=e.key;updateEntry(e,value.x,value.y);persist(e);}
    dst.push(action);updateSelection();return true;
  }
  function onSystem(data){
    system=data;
    offsets={...data.positionOffsets};
    history=[];future=[];chosen=null;drag=null;
    overlay.replaceChildren();entries.clear();
    updateSelection();
  }
  document.getElementById('pen-toggle').addEventListener('click',()=>{
    // Selecting Pen must not move any symbol. It only releases keyboard focus.
    if(document.body.classList.contains('pen-active')){chosen=null;updateSelection();}
  });
  // Called after ALL native scan-coordinate and optical correction passes.
  // Always apply stored offsets, even while the pen is in use.
  function onRendered(){collect();}
  reset.addEventListener('click',()=>{if(!chosen)return;selectedChange(0,0);});
  undoButton.addEventListener('click',()=>travel(true));
  redoButton.addEventListener('click',()=>travel(false));
  document.getElementById('score-scroll').addEventListener('scroll',()=>{
    requestAnimationFrame(()=>{for(const e of entries.values())placeHitbox(e);});
  },{passive:true});
  window.addEventListener('keydown',ev=>{
    if(ev.key==='Escape'&&chosen){chosen=null;updateSelection();return;}
    // Ordinary arrow keys must continue traversing notes. Nudges require
    // Option so direct dragging never takes over the musical keyboard.
    if(!chosen||ev.metaKey||ev.ctrlKey||!ev.altKey)return;
    const d=ev.key.replace('Arrow','').toLowerCase();
    if(['left','right','up','down'].includes(d)){
      if(nudge(d,ev.shiftKey)){ev.preventDefault();ev.stopImmediatePropagation();}
    }
  },true);
  window.PianoPositionEditor={onSystem,onRendered,nudge,undo:()=>travel(true),redo:()=>travel(false),
    isActive:()=>false,hasSelection:()=>!!chosen,
    // Exposed for regression testing and diagnostics only.
    snapshot:()=>({active:true,entryCount:entries.size,selected:chosen,positions:{...offsets}}),
    select:key=>{if(!entries.has(key))return false;chosen=key;updateSelection();return true;},
    clearSelection:()=>{chosen=null;updateSelection();},
    toggle:()=>{} // backwards-compatible inert API for the old pen interface
  };
  setMessage('');
})();
