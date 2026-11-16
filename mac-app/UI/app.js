/* App orchestration only. Practice, route planning and engraving are independent. */
'use strict';
window.Library = (()=> {
  const $=id=>document.getElementById(id), root='../';
  let collection,manifests= {
  },catalog=[],routes,state= {
  },sourceEvidenceCorrections= {
  },practice,mode='transcribe',pieceIndex=0,systemIndex=0,generation=0,spreadIndex=0,performancePages=[],pageMode='scan',editorReady=false,currentPayload=null,toolkit=null;
  const runtime=window.PianoRuntime||{modes:['transcribe','practice','perform'],defaultMode:'perform',defaultDisplayProfile:'monitor-16-9'};
  const allowedModes=runtime.modes.filter(m=>['transcribe','practice','perform'].includes(m));
  let displayProfile='sidetrak',displaySettings={},lastViewport='',resizeRequest=null,retainedRouteCursor=null;
  const display=()=>PianoPerformanceDisplay.profiles[displayProfile];
  const columns=()=>display().columns;
  const editor=$('editor');
  let practiceEditor=null;
  let finishedPieces=new Set(),finishedScores={};
  let rendererHashes={},reflowPageCounts=[],reflowTimer=null;
  let scanMatchCorrections= {
    schema:1,systems: {
    }
  };
  const activeEditor=()=>mode==='practice'&&practiceEditor?practiceEditor:editor;
  const message=(text,error=false)=> {
    $('message').textContent=text;
    $('message').classList.toggle('error',error);
  };
  const bridge=data=> {
    if(window.webkit?.messageHandlers?.library)window.webkit.messageHandlers.library.postMessage(data);
    else if(data.type==='saveState') {
      localStorage.setItem('piano-library.rebuilt',JSON.stringify(data.state));
      didSave(true);
    } else if(data.type==='export') {
      const a=document.createElement('a');
      a.href=URL.createObjectURL(new Blob([data.text], {
        type:'application/json'
      }));
      a.download='PianoLibrary-progress.json';
      a.click();
    } else if(data.type==='copy')navigator.clipboard?.writeText(data.text);
  };
  const fetchJSON=async path=> {
    const response=await fetch(path);
    if(!response.ok&&response.status!==0)throw Error('Cannot read '+path);
    return response.json();
  };
  const fetchText=async path=> {
    const response=await fetch(path);
    if(!response.ok&&response.status!==0)throw Error('Cannot read '+path);
    return response.text();
  };
  function persist() {
    displaySettings[displayProfile]={...(displaySettings[displayProfile]||{}),size:Number($('size').value)};
    state.displayProfiles={schema:1,active:displayProfile,profiles:displaySettings};
    state.view= {
      mode,pieceIndex,systemIndex,spreadIndex,displayProfile,routeOffset:currentRouteCursor(),source:$('source').value,size:$('size').value
    };
    $('saved').textContent='Saving…';
    bridge( {
      type:'saveState',state
    });
  }
  function didSave(ok) {
    $('saved').textContent=ok?'Saved locally':'Save failed';
    $('saved').classList.toggle('error',!ok);
  }
  const storage= {
    getItem:key=>state[key]||null,setItem:(key,value)=> {
      state[key]=value;
      persist();
    }
  };
  function piece() {
    return collection.pieces[pieceIndex];
  }
  function system() {
    return manifests[piece().slug].systems[systemIndex];
  }
  function updateSystemPicker() {
    const systems=manifests[piece().slug].systems;
    $('system').replaceChildren(...systems.map((s,i)=>new Option(`${i+1} · m${s.first+1}–${s.last+1}`,String(i))));
    systemIndex=Math.min(systemIndex,systems.length-1);
    $('system').value=String(systemIndex);
  }
  function updatePieceOptions(){
    const allowed=collection.pieces.map((p,i)=>({p,i})).filter(({p})=>mode==='perform'?finishedPieces.has(p.slug):mode==='transcribe'?($('review-finished').checked||!finishedPieces.has(p.slug)):true);
    if(!allowed.some(({i})=>i===pieceIndex)&&allowed.length){pieceIndex=allowed[0].i;systemIndex=0;}
    $('piece').replaceChildren(...allowed.map(({p,i})=>new Option(p.title,String(i))));
    $('piece').value=String(pieceIndex);$('piece').disabled=!allowed.length;
  }
  function setMode(next) {
    if(!allowedModes.includes(next))return;
    editor.contentWindow?.PianoReviewPen?.flush?.();
    mode=next;
    for(const id of ['transcribe','practice','perform'])$(id).hidden=id!==mode;
    document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
    $('snapshot-control').hidden=mode!=='transcribe';
    if($('view-evidence'))$('view-evidence').hidden=mode!=='transcribe';
    $('source-control').hidden=true;
    $('source').value='engraving';
    updatePieceOptions();
    if(mode==='transcribe')updateSystemPicker();
    $('size-control').hidden=mode!=='perform';
    $('display-control').hidden=mode!=='perform';
    $('review-finished-control').hidden=mode!=='transcribe';
    $('system').hidden=mode!=='transcribe';
    $('previous').hidden=$('next').hidden=mode==='perform'||(mode==='practice'&&!practice);
    $('piece').hidden=mode==='practice';
    if(mode==='practice')showPractice();
    else if(mode==='perform')preparePerformance();
    else showTranscription();
    persist();
  }
  async function systemPayload(p,s) {
    if(location.protocol==='pianolibrary:')return withSourceEvidence(p,s,await fetchJSON(`/api/system?piece=${encodeURIComponent(p.slug)}&system=${s.id}&historical=${mode==='transcribe'&&$('snapshot').checked?1:0}`));
    const m=manifests[p.slug];
    return withSourceEvidence(p,s, {
      ...s,xml:await fetchText(root+p.directory+'/'+s.score),fullScoreXML:await fetchText(root+p.directory+'/source.musicxml'),pieceTitle:p.title,pieceSlug:p.slug,scan:p.directory+'/'+s.scan,reviewMode:m.reviewMode||'aligned',allSystemBarlines:m.systems.map(s=>( {
        first:s.first,barlines:s.barlines||[]
      })),atlas: {
      },reviews: {
      },reviewMarks:[],positionOffsets: {
      }
    });
  }
  async function sha256(bytes) {
    const hash=await crypto.subtle.digest('SHA-256',bytes);
    return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  async function withSourceEvidence(p,s,data) {
    const payload= {
      ...data,...(sourceEvidenceCorrections.pieces?.[p.slug]?.[s.id]|| {
      })
    };
    return payload;
  }

  async function reloadCorrections() {
    const path=location.protocol==='pianolibrary:'?'/api/corrections':'scan-match-corrections.json';
    const value=await fetchJSON(path+'?v='+Date.now());
    if(value.schema!==1||!value.systems||typeof value.systems!=='object')throw Error('The offline comparison results could not be read.');
    if(location.protocol!=='pianolibrary:'&&crypto?.subtle){
      const names=[...new Set(Object.values(value.systems).flatMap(row=>Object.keys(row.evidence?.rendererFiles||{})))];
      const allowed=new Set(['render.js','engraving-semantics.js','engraving-layout.js','engraving-ties.js','engraving-rules.js','render-input.js']);
      rendererHashes=Object.fromEntries(await Promise.all(names.filter(name=>allowed.has(name)).map(async name=>{const response=await fetch(name+'?v='+Date.now());if(!response.ok)throw Error('Cannot verify '+name);return[name,await sha256(await response.arrayBuffer())];})));
    }
    scanMatchCorrections=value;
    return value;
  }
  async function offlineStatus(text,done=true,success=false) {
    if(typeof text==='boolean') {
      success=text;
      done=true;
      text=success?'Offline comparison finished.':'Offline comparison failed.';if(!success){try{const p=await fetchJSON('/api/review-progress');text+=' '+p.latest;}catch(_){}}
    }
    const button=$('offline-review');
    if(button)button.disabled=!done;
    if(done)reviewWasRunning=false;
    if(done&&success) {
      try {
        await reloadCorrections();
        if(mode==='transcribe')await showTranscription();
        else if(mode==='practice'&&$('source').value==='engraving')await showPractice();
      } catch(error) {
        message('Comparison finished, but results could not be loaded: '+error.message,true);
        return;
      }
    }
    message(text,done&&!success);
  }
  function applyReviewState(data) {
    state.transcription??={};
    const saved=state.transcription[data.pieceSlug]??={marks:Object.fromEntries((data.reviewMarks||[]).map(m=>[m.id,m])),offsets:{}};
    data.reviewMarks=Object.values(saved.marks||{});
    data.positionOffsets={...data.positionOffsets,...saved.offsets};
    if(!$('snapshot').checked) {
      delete data.lockedSnapshot;
      delete data.lockedSnapshotError;
    }return data;
  }
  async function waitEditor(frame=editor) {
    if(frame===editor&&!editor.getAttribute('src'))editor.src=editor.dataset.src;
    for(let i=0;
    i<500;
    i++) {
      if(frame.contentWindow?.showSystem)return;
      await new Promise(r=>setTimeout(r,50));
    }throw Error('The local engraver did not start.');
  }
  async function showTranscription() {
    if(!allowedModes.includes('transcribe'))return;
    const empty=!$('piece').options.length;
    $('transcribe-empty').hidden=!empty;editor.hidden=empty;
    if(empty){++generation;$('location').textContent='';message('All pieces are finished. Include finished pieces to review their transcriptions.');return;}
    editor.contentWindow?.PianoReviewPen?.flush?.();
    const token=++generation,p=piece(),s=system();
    $('location').textContent=`${p.title} · m${s.first+1}–${s.last+1}`;
    $('issues').replaceChildren();
    message('Loading comparison…');
    try {
      const data=applyReviewState(await systemPayload(p,s));
      if(token!==generation||mode!=='transcribe')return;
      currentPayload=data;
      await waitEditor();
      if(token!==generation)return;
      editor.hidden=false;
      editor.contentWindow.document.body.classList.remove('single-engraving');
      editor.contentWindow.showSystem(data);
      const note=document.createElement('p');
      note.textContent=$('snapshot').checked?'Historical approval: a preserved image, not evidence that the current transcription is exact.':'Live result: original scan is authoritative. Local matching tools record candidate improvements without certifying the whole system.';
      $('issues').append(note);
      if(data.visualMatchEvidence) {
        const evidence=document.createElement('p');
        evidence.textContent=data.visualMatchEvidence.applied===false?'Saved visual adjustments ignored: '+data.visualMatchEvidence.reason:`Offline comparison: ${Object.keys(data.visualXOverrides||{}).length} measured position adjustments. These machine matches remain provisional.`;
        $('issues').append(evidence);
      }
      $('issues').replaceChildren();
      persist();
    } catch(e) {
      message(e.message,true);
    }
  }
  function showReviewIssues(slug,s) {
    const rows=(window.reviewLedger?.reportedIssues||[]).filter(x=>x.piece===slug&&x.system===s.id);
    for(const row of rows) {
      const p=document.createElement('p');
      p.textContent=row.report||row.note||row.description||JSON.stringify(row);
      $('issues').append(p);
    }
  }
  function editorMessage(body,source) {
    if(body.pieceSlug&&(!collection?.pieces.some(p=>p.slug===body.pieceSlug)||!manifests[body.pieceSlug]?.systems.some(s=>s.first===body.systemFirst)))return;
    if((body.type==='rendered'||body.type==='error')&&body.pieceSlug&&body.pieceSlug!==currentPayload?.pieceSlug)return;
    if(body.type==='rendered'||body.type==='error') {
      message(`${currentPayload?.pieceTitle||''} · m${Number(currentPayload?.first)+1}–${Number(currentPayload?.last)+1}`+(body.type==='error'?' · '+body.message:''),body.type==='error');
      editorReady=true;
      return;
    }
    if(body.type==='copyRendererSVG'||body.type==='copyReviewNotes') {
      bridge( {
        type:'copy',text:body.svg||body.text
      });
      activeEditor().contentWindow.pianoRendererSVGCopyDidFinish?.(true);
      return;
    }
    if(!currentPayload)return;
    const slug=body.pieceSlug||currentPayload.pieceSlug;
    state.transcription??= {
    };
    const saved=state.transcription[slug]??= {
      marks:Object.fromEntries((slug===currentPayload.pieceSlug?currentPayload.reviewMarks||[]:[]).map(m=>[m.id,m])),offsets: {
      }
    };
    if(body.type==='saveReviewMark') {
      saved.marks[body.mark.id]=body.mark;
      persist();
    }
    if(body.type==='deleteReviewMark') {
      delete saved.marks[body.id];
      persist();
    }
    if(body.type==='savePositionOffset'&&body.pieceSlug===slug) {
      saved.offsets[body.id]= {
        x:body.x,y:body.y
      };
      persist();
    }
    if(body.type==='selectEvent')activeEditor().contentWindow.showSelection?.(body.id);
  }
  function nav(delta) {
    if(mode==='practice') {
      if(!practice)return;
      practice.next(delta);
      showPractice();
    } else {
      systemIndex=(systemIndex+delta+manifests[piece().slug].systems.length)%manifests[piece().slug].systems.length;
      $('system').value=systemIndex;
      showTranscription();
    }
  }
  async function showPractice() {
    if(!practice){
      ++generation;$('location').textContent='';$('practice-stats').textContent='No finished pieces yet.';
      $('practice-score').textContent='Pieces will appear here once we finish them.';
      $('practice').querySelector('.practice-actions').hidden=true;$('practice').querySelector('.grading').hidden=true;
      message('Practice is empty until a piece is finished.');return;
    }
    $('practice').querySelector('.practice-actions').hidden=false;$('practice').querySelector('.grading').hidden=false;
    $('source').value='engraving';
    const token=++generation,item=practice.current(),stats=practice.stats();
    $('location').textContent=`${item.title} · m${item.first+1}–${item.last+1}`;
    $('practice-stats').textContent=`${stats.rated} / ${stats.total} rated · ${stats.mode==='floor'?`Lowest group: ${stats.queueSize} systems · ${stats.floorMastered} at 8 or above`:'All unique systems'} · ${stats.position} / ${stats.queueSize}`;
    $('practice-feedback').textContent=stats.floorComplete?'This group is at 8 or above. Reassess to select the next lowest group.':stats.persistenceError||'Use keys 1–9 to rate and move on.';
    const target=$('practice-score');
    target.replaceChildren();
    const label=document.createElement('div');
    label.className='score-label';
    label.textContent=`${item.title} · system ${item.id.slice(1)} · m${item.first+1}–${item.last+1} · ${item.rating===null?'Unrated':`Comfort ${item.rating}/9`}`;
    target.append(label);
    $('grades').querySelectorAll('button').forEach(b=>b.classList.toggle('chosen',Number(b.textContent)===item.rating));
    const score=finishedScores[item.piece];
    if(score){
      for(const slice of item.slices)appendFinishedSlice(target,slice,item.piece);
      message('Finished engraving · rate your comfort from 1–9.');
    }
    persist();
  }
  function grade(n) {
    if(!practice)return;
    const old=practice.current();
    practice.grade(n);
    showPractice();
    $('practice-feedback').textContent=`Saved ${n}/9 for ${old.title}, ${old.id}.`;
  }
  function focusLowest() {
    if(!practice)return;
    const result=practice.focusLowest(.1,8);
    if(!result.ready) {
      practice.remainingUnrated();
      showPractice();
      $('practice-feedback').textContent=result.message;
      return;
    }showPractice();
  }
  async function prepareReflow(token,routeCursor){
    const slug=piece().slug,record=routes.pieces[slug],fixes=sourceEvidenceCorrections.pieces?.[slug]||{};
    let xml=await fetchText(root+piece().directory+'/source.musicxml');
    // A lean SideTrak bundle does not carry source scores. Its approved spread
    // remains usable; reflow is offered only where the required tools exist.
    if(!window.PianoMusicXMLInput)throw Error('Reflow requires the complete local app.');
    const overrides=Object.assign({},...Object.values(fixes).map(f=>f.sourceEngravingOverrides||{}));
    xml=PianoMusicXMLInput.applyScanEngraving(xml,0,overrides,Object.assign({},...Object.values(fixes).map(f=>f.sourceWordCorrections||{})));
    const doc=new DOMParser().parseFromString(xml,'application/xml'),measures=[...doc.querySelectorAll('part > measure')];
    // Restore scan-backed directions absent from the canonical MusicXML.
    const extra={ 'white-christmas':[[3,'rit.',2]],'silver-bells':[[28,'Swing 8ths',2],[66,'Swing 8ths',2]],'the-most-wonderful-time-of-the-year':[[42,'cresc.',0]] };
    for(const [mi,text,beat] of extra[slug]||[]){const m=measures[mi];if(!m||[...m.querySelectorAll('words')].some(n=>n.textContent===text))continue;const d=doc.createElement('direction');d.setAttribute('placement',/8ths/.test(text)?'above':'below');d.innerHTML='<direction-type><words font-style="italic">'+text+'</words></direction-type><offset>'+beat*Number(measures[0].querySelector('divisions')?.textContent||6)+'</offset><staff>1</staff>';const first=m.querySelector('note');m.insertBefore(d,first);}
    const tieRepairs={'there-s-no-place-like-home-for-the-holidays':[[4,8,5,0]],'it-s-beginning-to-look-a-lot-like-christmas':[[7,9,7,13],[71,9,71,13]],'the-most-wonderful-time-of-the-year':[[14,4,14,9],[14,5,14,10],[39,3,39,6],[39,4,39,7]]};
    for(const [ma,na,mb,nb] of tieRepairs[slug]||[])for(const [mi,ni,type] of [[ma,na,'start'],[mb,nb,'stop']]){const n=measures[mi]?.querySelectorAll('note')[ni];if(!n)continue;if(!n.querySelector('tie[type="'+type+'"]')){const t=doc.createElement('tie');t.setAttribute('type',type);n.insertBefore(t,n.querySelector('voice'));}let notation=n.querySelector('notations');if(!notation){notation=doc.createElement('notations');n.append(notation);}if(!notation.querySelector('tied[type="'+type+'"]')){const t=doc.createElement('tied');t.setAttribute('type',type);notation.append(t);}}
    const flat=PianoPerformanceEngraving.flattenMusicXML(new XMLSerializer().serializeToString(doc),record,{printedOctaveOverrides:Object.assign({},...Object.values(fixes).map(f=>f.printedOctaveOverrides||{}))});
    if(!window.verovio?.toolkit&&!document.querySelector('script[data-performance-engraver]')){const script=document.createElement('script');script.src='verovio-toolkit-wasm.js';script.dataset.performanceEngraver='true';document.head.append(script);}
    for(let i=0;i<500&&!window.verovio?.toolkit;i++)await new Promise(r=>setTimeout(r,40));
    if(token!==generation||mode!=='perform')return;
    if(!window.verovio?.toolkit)throw Error('Performance engraver could not start.');
    if(!toolkit){for(let i=0;i<150;i++){try{const candidate=new verovio.toolkit();candidate.getVersion();toolkit=candidate;break;}catch(e){await new Promise(r=>setTimeout(r,100));}}}
    if(!toolkit)throw Error('Performance engraver is not ready.');
    if(token!==generation||mode!=='perform')return;
    const box=performanceViewport(),scale=Math.round(70*Number($('size').value)/45);
    toolkit.setOptions({pageWidth:Math.round(box.width*100/scale),pageHeight:Math.round(box.height*100/scale),scale,adjustPageHeight:false,adjustPageWidth:false,breaks:'auto',header:'none',footer:'none',pageMarginTop:15,pageMarginBottom:15,pageMarginLeft:40,pageMarginRight:25,spacingStaff:10,spacingSystem:8,justifyVertically:true});
    if(!toolkit.loadData(flat))throw Error('Cannot reflow this score.');
    performancePages=[];reflowPageCounts=[];
    for(let n=1;n<=toolkit.getPageCount();n++){const svg=toolkit.renderToSVG(n);performancePages.push(svg);const d=new DOMParser().parseFromString(svg,'image/svg+xml');reflowPageCounts.push(d.querySelectorAll('g.measure').length);}
    pageMode='engraving';retainedRouteCursor=routeCursor;spreadIndex=routeCursor===null?Math.min(spreadIndex,Math.ceil(performancePages.length/columns())-1):screenForRoute(routeCursor);
    $('performance-title').textContent=piece().title;$('route-status').textContent=record.performedMeasureCount+' played measures · reflowed spread';
    showSpread();message('Reflowed for this screen · consistent staff size · repeats written out.');
  }
  async function preparePerformance(preserveLocation=false) {
    const routeCursor=preserveLocation===true?currentRouteCursor():retainedRouteCursor;
    $('source').value='engraving';
    if(!finishedPieces.size){++generation;performancePages=[];$('location').textContent='';$('spread').textContent='No finished pieces yet. Pieces will appear here once we finish them.';$('performance-title').textContent='Performance';$('route-status').textContent='';$('page-label').textContent='';$('page-back').disabled=$('page-next').disabled=true;message('Performance is empty until a piece is finished.');return;}
    if(!finishedPieces.has(piece().slug))throw Error('This piece is not finished.');
    const token=++generation;
    performancePages=[];
    $('page-back').disabled=$('page-next').disabled=true;
    $('page-label').textContent='Preparing pages…';
    $('location').textContent=piece().title;
    message('Preparing the explicit performance route…');
    $('spread').replaceChildren();
    try {
      const approved=finishedScores[piece().slug];
      if(approved&&display().reflow){
        await prepareReflow(token,routeCursor);return;
      }
      if(approved){
        $('performance-title').textContent=piece().title;
        $('route-status').textContent=`${approved.performance.reduce((n,s)=>n+s.last-s.first+1,0)} played measures · repeats written out`;
        performancePages=PianoPerformanceDisplay.paginate(approved,displayProfile,performanceViewport(),$('size').value);
        pageMode='finished';spreadIndex=routeCursor===null?Math.min(spreadIndex,Math.max(0,Math.ceil(performancePages.length/columns())-1)):screenForRoute(routeCursor);
        retainedRouteCursor=routeCursor;showSpread();message('Finished engraving · original spacing · repeats written out.');return;
      }
      const record=routes.pieces[piece().slug];
      if(!record||record.error)throw Error(record?.error||'This piece has no validated navigation route.');
      $('performance-title').textContent=piece().title;
      $('route-status').textContent=`${record.performedMeasureCount} played measures · repeats and jumps written out`;
      if($('source').value==='engraving') {
        const xml=await fetchText(root+piece().directory+'/source.musicxml');
        if(token!==generation)return;
        const overrides=Object.assign( {
        },...Object.values(sourceEvidenceCorrections.pieces?.[piece().slug]|| {
        }).map(value=>value.printedOctaveOverrides|| {
        }));
        const flat=PianoPerformanceEngraving.flattenMusicXML(xml,record, {
          printedOctaveOverrides:overrides
        });
        if(!window.verovio?.toolkit&&!document.querySelector('script[data-performance-engraver]')){const script=document.createElement('script');script.src='verovio-toolkit-wasm.js';script.dataset.performanceEngraver='true';document.head.append(script);}
        for(let i=0;
        i<400&&!window.verovio?.toolkit;
        i++)await new Promise(r=>setTimeout(r,50));
        if(token!==generation||mode!=='perform')return;
        if(!window.verovio?.toolkit)throw Error('The local performance engraver did not start.');
        if(!toolkit)toolkit=new verovio.toolkit();
        const size=Number($('size').value),pageFactor=45/size;
        // Changing only SVG scale is canceled by fitting the page to the display.
        // Change the musical page dimensions so the score truly reflows.
        toolkit.setOptions( {
          pageWidth:Math.round(1500*pageFactor),pageHeight:Math.round(2100*pageFactor),scale:45,adjustPageHeight:false,breaks:'auto',header:'none',footer:'none',spacingStaff:12,spacingSystem:8
        });
        if(!toolkit.loadData(typeof flat==='string'?flat:flat.xml))throw Error('The performance score could not be engraved.');
        performancePages=[];
        for(let n=1;
        n<=toolkit.getPageCount();
        n++)performancePages.push(toolkit.renderToSVG(n));
        pageMode='engraving';
      } else {
        const slices=PianoPerformance.sliceRoute(record,manifests[piece().slug]);
        const rows=Math.max(2,Math.min(7,Math.round(225/Number($('size').value))));
        performancePages=PianoPerformance.pages(slices,rows);
        pageMode='scan';
      }
      if(token!==generation)return;
      spreadIndex=Math.min(spreadIndex,Math.max(0,Math.ceil(performancePages.length/columns())-1));
      showSpread();
      message(pageMode==='scan'?'Original scans · repeated visits shown explicitly · partial systems cropped at measure boundaries.':'Reflowable digital performance score · repeats flattened · engraving remains provisional.');
    } catch(e) {
      message(e.message,true);
      $('route-status').textContent='Cannot prepare this route';
    }
  }
  function pageWeight(page,index){return Array.isArray(page)?page.reduce((n,r)=>n+r.last-r.first+1,0):(reflowPageCounts[index]||0);}
  function currentRouteCursor(){
    const start=performancePages.slice(0,spreadIndex*columns()).reduce((n,p,i)=>n+pageWeight(p,i),0),end=start+performancePages.slice(spreadIndex*columns(),(spreadIndex+1)*columns()).reduce((n,p,i)=>n+pageWeight(p,spreadIndex*columns()+i),0);
    return Number.isInteger(retainedRouteCursor)&&retainedRouteCursor>=start&&retainedRouteCursor<end?retainedRouteCursor:start;
  }
  function screenForRoute(offset){let sum=0;for(let i=0;i<performancePages.length;i++){sum+=pageWeight(performancePages[i],i);if(offset<sum)return Math.floor(i/columns());}return Math.max(0,Math.ceil(performancePages.length/columns())-1);}
  function showSpread() {
    const spread=$('spread');
    spread.replaceChildren();
    for(let n=spreadIndex*columns();
    n<spreadIndex*columns()+columns();
    n++) {
      const page=document.createElement('article');
      page.className='page';
      if(performancePages[n]) {
        const title=document.createElement('h2');
        title.textContent=piece().title;
        const count=document.createElement('h3');
        count.textContent=`Page ${n+1} · ${pageMode==='scan'?'Source scan':'Digital engraving'}`;
        page.append(title,count);
        const content=document.createElement('div');content.className='page-content';
        const sheet=document.createElement('div');sheet.className='page-score-sheet';content.append(sheet);page.append(content);
        if(pageMode==='engraving') {
          const score=document.createElement('div');
          score.className='digital-page';
          score.innerHTML=performancePages[n];
          namespaceSVG(score,`page-${n}-`);
          sheet.append(score);
        } else if(pageMode==='finished')for(const slice of performancePages[n])appendFinishedSlice(sheet,slice,piece().slug);
        else for(const slice of performancePages[n])appendSlice(sheet,slice);
      }if(performancePages[n]||columns()===2)spread.append(page);
    }const firstPage=spreadIndex*columns()+1,lastPage=Math.min(firstPage+columns()-1,performancePages.length);
    $('page-label').textContent=columns()===1?`Screen ${firstPage} of ${performancePages.length}`:`Pages ${firstPage}–${lastPage} of ${performancePages.length}`;
    $('page-back').textContent=columns()===1?'← Previous screen':'← Previous spread';$('page-next').textContent=columns()===1?'Next screen →':'Next spread →';
    $('page-back').disabled=spreadIndex===0;
    $('page-next').disabled=(spreadIndex+1)*columns()>=performancePages.length;
    spread.scrollTop=0;
    requestAnimationFrame(fitPages);
    persist();
  }
  function performanceViewport(){
    const spread=$('spread'),style=getComputedStyle(spread),wide=display().adaptive;
    return {width:Math.max(200,(spread.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-(wide?1:22))/columns()-(wide?20:32)),height:Math.max(120,spread.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom)-(wide?16:92))};
  }
  function fitPages(){
    const spread=$('spread');if(mode!=='perform'||!spread.clientHeight)return;
    const style=getComputedStyle(spread),height=spread.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
    for(const page of spread.querySelectorAll('.page')){
      page.style.height=height+'px';const content=page.querySelector('.page-content'),sheet=page.querySelector('.page-score-sheet');if(!content||!sheet)continue;
      sheet.style.transform='none';sheet.style.height='';sheet.style.minHeight='';sheet.style.top='0';
      if(display().reflow&&pageMode==='engraving'){sheet.style.width=content.clientWidth+'px';sheet.style.height=content.clientHeight+'px';sheet.style.left='0';continue;}
      const wide=display().adaptive,fraction=wide?Math.min(1,.62+Number($('size').value)/120):1;
      sheet.style.width=content.clientWidth*fraction+'px';
      if(pageMode==='finished'&&!wide){const score=finishedScores[piece().slug],ratio=Math.max(...performancePages.map(rows=>rows.reduce((n,r)=>n+score.systems[r.systemId].height/score.systems[r.systemId].width,0)+rows.length*.018));sheet.style.minHeight=(content.clientWidth*ratio)+'px';}
      sheet.style.left='0';const width=Math.max(content.clientWidth*fraction,sheet.scrollWidth),naturalHeight=sheet.scrollHeight;if(!naturalHeight)continue;
      const scale=Math.min(1,content.clientWidth/width,content.clientHeight/naturalHeight);sheet.style.transform=`scale(${scale})`;sheet.style.left=Math.max(0,(content.clientWidth-width*scale)/2)+'px';
      if(wide)sheet.style.top=Math.max(0,(content.clientHeight-naturalHeight*scale)/2)+'px';
    }
  }
  function refreshDisplay(){
    if(mode!=='perform')return;
    const v=performanceViewport(),key=displayProfile+':'+Math.round(v.width)+':'+Math.round(v.height);
    if(key===lastViewport){fitPages();return;}lastViewport=key;
    if(display().reflow&&performancePages.length){clearTimeout(reflowTimer);reflowTimer=setTimeout(()=>preparePerformance(true),120);}else if(display().adaptive&&pageMode==='finished'&&performancePages.length)preparePerformance(true);else fitPages();
  }
  function requestDisplayFit(){if(resizeRequest)cancelAnimationFrame(resizeRequest);resizeRequest=requestAnimationFrame(refreshDisplay);}
  window.addEventListener('resize',requestDisplayFit);
  new ResizeObserver(requestDisplayFit).observe($('spread'));
  function chooseDisplay(){
    const cursor=currentRouteCursor();retainedRouteCursor=cursor;
    displaySettings[displayProfile]={...(displaySettings[displayProfile]||{}),size:Number($('size').value)};
    displayProfile=$('display-profile').value;document.body.dataset.displayProfile=displayProfile;
    $('size').value=String(displaySettings[displayProfile]?.size||display().defaultSize);
    const score=finishedScores[piece().slug];
    if(display().reflow||pageMode==='engraving'){preparePerformance(true);lastViewport='';persist();return;}
    if(score){performancePages=PianoPerformanceDisplay.paginate(score,displayProfile,performanceViewport(),$('size').value);spreadIndex=screenForRoute(cursor);showSpread();}
    else preparePerformance();lastViewport='';persist();requestDisplayFit();
  }
  function namespaceSVG(container,prefix) {
    const ids=new Map();
    for(const node of container.querySelectorAll('[id]')) {
      const prior=node.id;
      node.id=prefix+prior;
      ids.set(prior,node.id);
    }for(const style of container.querySelectorAll('style'))style.textContent=style.textContent.replace(/#([A-Za-z_][\w:.-]*)/g,(all,id)=>ids.has(id)?'#'+ids.get(id):all);
    for(const node of container.querySelectorAll('*'))for(const attr of [...node.attributes]) {
      if(attr.name==='id')continue;
      let value=attr.value;
      if((attr.localName==='href')&&value.startsWith('#')&&ids.has(value.slice(1)))value='#'+ids.get(value.slice(1));
      value=value.replace(/url\(\s*#([^\s)]+)\s*\)/g,(all,id)=>ids.has(id)?`url(#${ids.get(id)})`:all);
      if(value!==attr.value)node.setAttributeNS(attr.namespaceURI,attr.name,value);
    }
  }
  function appendFinishedSlice(target,slice,slug){
    const score=finishedScores[slug],system=score.systems[slice.systemId];
    const row=document.createElement('div');row.className='finished-system';
    row.dataset.system=slice.systemId;row.dataset.first=slice.first;row.dataset.last=slice.last;
    row.innerHTML=system.svg;namespaceSVG(row,`finished-${slug}-${slice.systemId}-${Math.random().toString(36).slice(2)}-`);
    const svg=row.querySelector('svg');
    const left=slice.first===system.first?0:system.barlines[slice.first-system.first];
    const right=slice.last===system.last?system.width:system.barlines[slice.last-system.first+1];
    // Preserve overflowing ledger notes and stems inside the original glyph SVGs.
    for(const nested of svg.querySelectorAll('svg'))nested.style.overflow='visible';
    if(slice.first!==system.first||slice.last!==system.last){
      const ns='http://www.w3.org/2000/svg',defs=document.createElementNS(ns,'defs'),clip=document.createElementNS(ns,'clipPath'),rect=document.createElementNS(ns,'rect'),group=document.createElementNS(ns,'g');
      const id='cut-'+Math.random().toString(36).slice(2);clip.id=id;clip.setAttribute('clipPathUnits','userSpaceOnUse');
      rect.setAttribute('x',left-.8);rect.setAttribute('y','-20');rect.setAttribute('width',right-left+1.6);rect.setAttribute('height',system.height+40);
      clip.append(rect);defs.append(clip);group.setAttribute('clip-path',`url(#${id})`);
      while(svg.firstChild)group.append(svg.firstChild);svg.append(defs,group);
    }
    // Navigation has already been spelled out in the row sequence.
    for(const node of row.querySelectorAll('g.dir,g.repeatMark,g.segno,g.coda'))if(/d\s*\.\s*s\s*\.|to\s*coda|segno|coda/i.test(node.textContent+' '+node.getAttribute('class'))||node.querySelector('g.segno,g.coda'))node.remove();
    target.append(row);
  }
  function appendSlice(page,slice) {
    const s=manifests[piece().slug].systems.find(s=>s.id===slice.systemId),label=document.createElement('div');
    label.className='slice-label';
    label.textContent=`m${slice.first+1}–${slice.last+1} · visit ${slice.routeFirst+1}`;
    page.append(label);
    const count=s.last-s.first+1,calibration=window.PianoScanCalibration?.[piece().slug]?.[s.first];
    let lines=Array.isArray(s.barlines)&&s.barlines.length===count+1?s.barlines:null;
    if(calibration?.barlines_px?.length===count+1&&Number(calibration.width)>0)lines=calibration.barlines_px.map(x=>x/calibration.width);
    if(!lines&&(slice.first!==s.first||slice.last!==s.last))throw Error('Measured scan boundaries are missing for '+piece().title+', '+s.id+'. Use the digital performance view.');
    lines??=[0,1];
    let left=slice.first===s.first?0:lines[slice.first-s.first],right=slice.last===s.last?1:lines[slice.last-s.first+1];
    if(!Number.isFinite(left)||!Number.isFinite(right)||right<=left)throw Error('Missing measure boundaries for '+s.id);
    const wrapper=document.createElement('div');
    wrapper.className='system-slice';
    wrapper.style.aspectRatio=String((s.scanWidthPx||2300)*(right-left)/(s.scanHeightPx||550));
    const img=new Image();
    img.alt=`${piece().title}, measures ${slice.first+1}–${slice.last+1}`;
    img.src=root+piece().directory+'/'+s.scan;
    img.style.width=(100/(right-left))+'%';
    img.style.marginLeft=(-100*left/(right-left))+'%';
    img.onload=()=>requestAnimationFrame(fitPages);
    wrapper.append(img);
    page.append(wrapper);
  }
  function turn(delta) {
    retainedRouteCursor=null;
    if(!performancePages.length)return;
    const max=Math.ceil(performancePages.length/columns())-1;
    spreadIndex=Math.min(max,Math.max(0,spreadIndex+delta));
    showSpread();
  }
  async function init() {
    try {
      collection=await fetchJSON(root+'collection.json');
      const loaded=await Promise.all(collection.pieces.map(async p=>[p.slug,await fetchJSON(root+p.directory+'/manifest.json')]));
      manifests=Object.fromEntries(loaded);
      const finished=await fetchJSON('finished-pieces.json');finishedPieces=new Set(finished.pieces||[]);
      for(const slug of finishedPieces)finishedScores[slug]=await fetchJSON(root+'finished/'+slug+'.json');
      catalog=[];
      if(allowedModes.includes('practice'))for(const p of collection.pieces.filter(p=>finishedPieces.has(p.slug))){
        const score=finishedScores[p.slug];
        for(const [i,slices] of score.practice.entries())catalog.push({key:p.slug+':group-'+i,piece:p.slug,title:p.title,id:slices.map(s=>s.systemId).join('+'),first:slices[0].first,last:slices.at(-1).last,slices});
      }
      routes=await fetchJSON('performance-routes.json');
      if(allowedModes.includes('transcribe')||runtime.reflow){window.reviewLedger=await fetchJSON('review-ledger.json');sourceEvidenceCorrections=await fetchJSON('source-evidence-corrections.json');}
      try {
        state=location.protocol==='pianolibrary:'?await fetchJSON('/api/state'):JSON.parse(localStorage.getItem('piano-library.rebuilt')||'{}');
      } catch {
        state= {
        };
      }if(!state||typeof state!=='object'||Array.isArray(state))state= {
      };
      const v=state.view|| {
      };
      pieceIndex=Number.isInteger(v.pieceIndex)?Math.max(0,Math.min(collection.pieces.length-1,v.pieceIndex)):0;
      systemIndex=Number.isInteger(v.systemIndex)?Math.max(0,v.systemIndex):0;
      spreadIndex=Number.isInteger(v.spreadIndex)?Math.max(0,v.spreadIndex):0;
      retainedRouteCursor=Number.isInteger(v.routeOffset)?Math.max(0,v.routeOffset):null;
      $('source').value='engraving';
      const savedDisplays=state.displayProfiles?.profiles;
      displaySettings=savedDisplays&&typeof savedDisplays==='object'&&!Array.isArray(savedDisplays)?savedDisplays:{};
      // Migrate the old size into SideTrak without overwriting it with monitor settings.
      displaySettings.sidetrak??={size:PianoPerformanceDisplay.size(v.size)};
      const requested=state.displayProfiles?.active||v.displayProfile||(v.size?'sidetrak':runtime.defaultDisplayProfile);
      displayProfile=PianoPerformanceDisplay.profiles[requested]?requested:'monitor-16-9';
      if(!runtime.reflow){$('display-profile').querySelector('[value="monitor-16-9"]')?.remove();displayProfile='sidetrak';}
      document.body.dataset.displayProfile=displayProfile;$('display-profile').value=displayProfile;
      $('size').value=String(PianoPerformanceDisplay.size(displaySettings[displayProfile]?.size||display().defaultSize));
      for(const button of document.querySelectorAll('[data-mode]'))button.hidden=!allowedModes.includes(button.dataset.mode);

      practice=catalog.length?PianoPractice.createSession(catalog,{storage,key:'piano-library.finished-practice.v1'}):null;
      $('piece').replaceChildren(...collection.pieces.map((p,i)=>new Option(p.title,String(i))));
      $('piece').value=String(pieceIndex);
      updateSystemPicker();
      for(let i=1;
      i<=9;
      i++) {
        const b=document.createElement('button');
        b.textContent=i;
        b.onclick=()=>grade(i);
        $('grades').append(b);
      }setMode(allowedModes.includes(v.mode)?v.mode:(allowedModes.includes(runtime.defaultMode)?runtime.defaultMode:allowedModes[0]));
    } catch(e) {
      message(e.stack||e.message,true);
    }
  }
  document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=> {
    setMode(b.dataset.mode);
  });
  $('piece').onchange=()=> {
    pieceIndex=Number($('piece').value);
    retainedRouteCursor=null;
    systemIndex=0;
    spreadIndex=0;
    updateSystemPicker();
    mode==='perform'?preparePerformance():showTranscription();
  };
  $('system').onchange=()=> {
    systemIndex=Number($('system').value);
    showTranscription();
  };
  $('snapshot').onchange=showTranscription;
  $('previous').onclick=()=>nav(-1);
  $('next').onclick=()=>nav(1);
  $('all').onclick=()=> {
    if(!practice)return;
    practice.all();
    practice.shuffle();
    showPractice();
  };
  $('floor').onclick=$('round').onclick=focusLowest;
  $('source').onchange=()=>mode==='practice'?showPractice():preparePerformance();
  $('size').onchange=()=>preparePerformance(true);
  $('display-profile').onchange=chooseDisplay;
  $('review-finished').onchange=()=>{systemIndex=0;updatePieceOptions();updateSystemPicker();showTranscription();};
  $('review-finished-button').onclick=()=>{$('review-finished').checked=true;$('review-finished').onchange();};
  $('page-back').onclick=()=>turn(-1);
  $('page-next').onclick=()=>turn(1);
  function performanceFocus(on){document.body.classList.toggle('performance-focus',on);document.body.classList.toggle('fullscreen',on);$('exit-performance-focus').hidden=!on;if(window.webkit?.messageHandlers?.library)bridge({type:'performanceFullscreen',enabled:on});else if(on)document.documentElement.requestFullscreen?.().catch(()=>{});else if(document.fullscreenElement)document.exitFullscreen?.();requestDisplayFit();}
  $('fullscreen').onclick=()=>performanceFocus(!document.body.classList.contains('performance-focus'));
  $('exit-performance-focus').onclick=()=>performanceFocus(false);
  document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&!window.webkit?.messageHandlers?.library){document.body.classList.remove('performance-focus','fullscreen');$('exit-performance-focus').hidden=true;requestDisplayFit();}});
  $('export').onclick=()=>bridge( {
    type:'export',text:JSON.stringify( {
      schema:1,exportedAt:new Date().toISOString(),state
    },null,2)
  });
  $('import').onchange=async e=> {
    try {
      const doc=JSON.parse(await e.target.files[0].text());
      if(doc.schema!==1||!doc.state||typeof doc.state!=='object'||Array.isArray(doc.state))throw Error('Choose a Piano Library progress export.');
      const candidate=doc.state;
      const savedPractice=candidate['piano-library.practice.v1'];
      if(savedPractice&&practice)practice.importJSON(savedPractice);
      state= {
        ...candidate,...(practice?{'piano-library.finished-practice.v1':practice.exportJSON()}:{})
      };
      persist();
      if(mode==='practice')showPractice();
      else if(mode==='perform')preparePerformance();
      else showTranscription();
      message('Progress imported.');
    } catch(error) {
      message(error.message,true);
    }e.target.value='';
  };
  document.addEventListener('keydown',e=> {
    if(e.key==='Escape'&&document.body.classList.contains('performance-focus')){e.preventDefault();performanceFocus(false);return;}
    if(e.repeat||e.altKey||e.metaKey||e.ctrlKey||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;
    if(mode==='practice'&&/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      grade(Number(e.key));
    } else if(mode==='perform'&&['ArrowRight',' ','PageDown','ArrowLeft','PageUp'].includes(e.key)) {
      e.preventDefault();
      turn(['ArrowLeft','PageUp'].includes(e.key)?-1:1);
    } else if(['ArrowLeft','ArrowRight'].includes(e.key)) {
      e.preventDefault();
      nav(e.key==='ArrowRight'?1:-1);
    }
  });
  if($('offline-review'))$('offline-review').onclick=()=> {
    if(!window.webkit?.messageHandlers?.library) {
      message('Run offline comparison from the Piano Library Mac app.',true);
      return;
    }$('offline-review').disabled=true;
    message('Offline comparison is running. You can keep practicing.');
    bridge( {
      type:'runOfflineReview'
    });
  };
  if($('view-evidence')){
    const button=$('view-evidence');
    if(!window.webkit?.messageHandlers?.library){button.disabled=true;button.title='Open comparison evidence in the Piano Library Mac app.';}
    button.onclick=()=>{if(window.webkit?.messageHandlers?.library)bridge({type:'openEvidence'});else message('Open comparison evidence in the Piano Library Mac app.');};
  }
  let reviewWasRunning=false;
  init();
  return {
    editorMessage,didSave,offlineStatus,reloadCorrections,
    practiceKey:key=>{if(mode!=='practice')return false;if(/^[1-9]$/.test(key)){grade(Number(key));return true;}if(['ArrowLeft','ArrowRight'].includes(key)){nav(key==='ArrowRight'?1:-1);return true;}return false;},
    flushEditor:()=>{editor.contentWindow?.PianoReviewPen?.flush?.();persist();return JSON.stringify(state);},
    getState:()=>state,getMode:()=>mode
  };
})();
