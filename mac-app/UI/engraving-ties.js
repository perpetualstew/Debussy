'use strict';
/* Tie geometry is rebuilt from exact musical event identities after layout.
   Boundary scan evidence remains separate from fully paired internal ties. */
window.PianoTieEngine={create(context){
  function sourceTiePairs() {
    const {latest}=context;
    const events=window.PianoMusicSemantics.eventsFromXML(latest.xml,Number(latest.first));
    // Scan and user annotation confirm the omitted D4 tie from m5 to m6.
    // Repair only the semantic rendering copy; preserve original MusicXML.
    if(latest.pieceSlug==='there-s-no-place-like-home-for-the-holidays'&&Number(latest.first)===4){
      const start=events.find(e=>e.id==='p0-m4-n8'),end=events.find(e=>e.id==='p0-m5-n0');
      if(start?.pitch==='D:0:4'&&end?.pitch===start.pitch&&start.staff===end.staff&&Math.abs(start.end-end.onset)<1e-7){
        start.start=true;end.stop=true;start.orientation='under';
      }
    }
    if(latest.pieceSlug==='it-s-beginning-to-look-a-lot-like-christmas'){
      const pair=Number(latest.first)===4?['p0-m7-n9','p0-m7-n13','A:0:3']:
        Number(latest.first)===71?['p0-m71-n9','p0-m71-n13','B:0:3']:null;
      if(pair){
        const start=events.find(e=>e.id===pair[0]),end=events.find(e=>e.id===pair[1]);
        if(start?.pitch===pair[2]&&end?.pitch===pair[2]&&start.staff===end.staff&&Math.abs(start.end-end.onset)<1e-7){
          start.start=true;end.stop=true;start.orientation='over';
        }
      }
    }
    if(latest.pieceSlug==='the-most-wonderful-time-of-the-year'&&Number(latest.first)===12){
      for(const [a,b,pitch] of [['p0-m14-n4','p0-m14-n9','C:1:4'],['p0-m14-n5','p0-m14-n10','F:1:4']]){
        const start=events.find(e=>e.id===a),end=events.find(e=>e.id===b);
        if(start?.pitch===pitch&&end?.pitch===pitch&&start.staff===end.staff&&Math.abs(start.end-end.onset)<1e-7){start.start=true;end.stop=true;start.orientation='under';}
      }
    }
    if(latest.pieceSlug==='the-most-wonderful-time-of-the-year'&&Number(latest.first)===36){
      for(const [a,b,pitch] of [['p0-m39-n3','p0-m39-n6','F:0:3'],['p0-m39-n4','p0-m39-n7','A:0:3']]){
        const start=events.find(e=>e.id===a),end=events.find(e=>e.id===b);
        if(start?.pitch===pitch&&end?.pitch===pitch&&start.staff===end.staff&&Math.abs(start.end-end.onset)<1e-7){start.start=true;end.stop=true;start.orientation='under';}
      }
    }
    return window.PianoMusicSemantics.pairEvents(events).pairs;
  }
  function reflowTies(svg) {
    const {$, latest, mapped, image, staffSizeFactor, headRect, xmlMeasures, directChildren, localContent, preAlignmentHeadBoxes}=context;
    const pairs=sourceTiePairs(),originals=$(svg,'g.tie');
    window.PianoTieAudit={expected:pairs.length,drawn:0,recovered:0,records:[],unresolved:[]};
    if(!pairs.length){context.lastTieReport=originals.length?'existing ties unchanged':'no ties';return;}
    const valid=pairs.filter(p=>mapped.get(p.startID)?.isConnected && mapped.get(p.endID)?.isConnected);
    if(!valid.length){context.lastTieReport=`0/${pairs.length} ties available; originals preserved`;return;}
    const measureNodes=$(svg,'g.measure');
    const available=new Set(originals),assignments=[];
    for(const pair of valid){
      const start=headRect(mapped.get(pair.startID)),cy=(start.top+start.bottom)/2;
      const candidates=[...available].filter(t=>t.closest('g.measure')===measureNodes[pair.measure]);
      if(!candidates.length){assignments.push({pair,tie:null});continue;}
      const anchorScore=t=>{
        const r=t.getBoundingClientRect(),expect=.22*start.height;
        return Math.min(Math.abs(r.top-(cy+expect)),Math.abs(r.bottom-(cy-expect)));
      };
      const chosen=candidates.reduce((a,b)=>anchorScore(a)<=anchorScore(b)?a:b);
      // When a measure has EXACTLY one rendered curve for each tied source
      // note, assignment is structurally determined even if a fermata or
      // whole-note chord makes the SVG bounding box unusually tall. Do not
      // discard such a legitimate final-measure tie on a pixel threshold.
      // Keep the conservative threshold whenever counts differ.
      const sameMeasurePairs=valid.filter(p=>p.measure===pair.measure).length;
      const sameMeasureCurves=originals.filter(t=>t.closest('g.measure')===measureNodes[pair.measure]).length;
      const structurallyComplete=sameMeasurePairs===sameMeasureCurves;
      if(!structurallyComplete&&anchorScore(chosen)>Math.max(17,start.height*1.85)){assignments.push({pair,tie:null});continue;}
      assignments.push({pair,tie:chosen});available.delete(chosen);
    }
    const space=Number(latest.scanStaffSpacePx)*
      image.getBoundingClientRect().width/(image.naturalWidth||latest.scanWidthPx||2300)*staffSizeFactor;
    const drawing=svg.querySelector('svg.definition-scale')||svg;
    const screen=drawing.getScreenCTM();
    if(!screen||!Number.isFinite(space)||space<2){
      context.lastTieReport='tie scale unavailable; originals preserved';return;
    }
    const inverse=screen.inverse(),ns='http://www.w3.org/2000/svg';
    const layer=document.createElementNS(ns,'g');
    layer.setAttribute('class','pl-repositioned-ties');
    layer.setAttribute('fill','currentColor');layer.setAttribute('color','#151515');
    const pt=(x,y)=>new DOMPoint(x,y).matrixTransform(inverse);
    const fmt=p=>`${p.x.toFixed(3)} ${p.y.toFixed(3)}`;
    const repaired=[];
    for(const {pair,tie} of assignments){
      const a=headRect(mapped.get(pair.startID)),b=headRect(mapped.get(pair.endID));
      const x1=a.right+space*.14,x2=b.left-space*.14;
      if(!(x2-x1>space*.45)||!Number.isFinite(x1+x2))continue;
      const tieRect=tie?.getBoundingClientRect(),tieCy=tieRect?(tieRect.top+tieRect.bottom)/2:null;
      const headCy=(a.top+a.bottom)/2;
      const side=pair.orientation==='over'?-1:pair.orientation==='under'?1:
        (tieCy!==null?(tieCy<headCy-space*.20?-1:1):
          (pair.start.stem==='down'?-1:1));
      const y1=side===1?a.bottom-a.height*.17:a.top+a.height*.17;
      const y2=side===1?b.bottom-b.height*.17:b.top+b.height*.17;
      const width=x2-x1,curvature=Math.min(space*.95,Math.max(space*.56,width*.065));
      const thickness=Math.max(.65,space*.105),c1=x1+width*.32,c2=x2-width*.32;
      const p1=pt(x1,y1),q1=pt(c1,y1+side*curvature),q2=pt(c2,y2+side*curvature),p2=pt(x2,y2);
      const i2=pt(c2,y2+side*(curvature+thickness)),i1=pt(c1,y1+side*(curvature+thickness));
      const path=document.createElementNS(ns,'path');
      path.setAttribute('class','pl-tie-geometry');
      path.setAttribute('data-start-event',pair.startID);
      path.setAttribute('data-end-event',pair.endID);
      path.setAttribute('d',`M${fmt(p1)} C${fmt(q1)} ${fmt(q2)} ${fmt(p2)} C${fmt(i2)} ${fmt(i1)} ${fmt(p1)} Z`);
      path.setAttribute('data-native-tie',tie?'reflowed':'recovered-from-source');
      layer.appendChild(path);repaired.push({tie,pair});
    }
    if(repaired.length){
      drawing.appendChild(layer);
      repaired.forEach(({tie})=>{if(tie)tie.style.visibility='hidden';});
    }
    const recovered=repaired.filter(r=>!r.tie).length;
    const unresolved=pairs.filter(p=>!repaired.some(r=>r.pair===p)).map(p=>({start:p.startID,end:p.endID,reason:'note mapping or span unavailable'}));
    window.PianoTieAudit={expected:pairs.length,drawn:repaired.length,recovered,records:repaired.map(r=>({start:r.pair.startID,end:r.pair.endID})),unresolved};
    svg.dataset.sourceTiesExpected=String(pairs.length);
    svg.dataset.sourceTiesDrawn=String(repaired.length);
    svg.dataset.sourceTiesRecovered=String(recovered);
    context.lastTieReport=`${repaired.length}/${pairs.length} ties scan-positioned · ${recovered} missing native ties recovered`+
      (repaired.length<pairs.length?' · remaining originals preserved':'');
  }

  function reflowFullScoreBoundaryTies(svg){
    const {latest,mapped,image,staffSizeFactor,headRect,$,xmlMeasures,directChildren,localContent,preAlignmentHeadBoxes}=context;
    if(typeof latest.fullScoreXML!=='string')return false;
    const first=Number(latest.first),last=Number(latest.last);
    const full=window.PianoMusicSemantics.eventsFromXML(latest.fullScoreXML);
    const pairs=window.PianoMusicSemantics.pairEvents(full).pairs;
    const halves=[];
    for(const pair of pairs){
      const inStart=pair.start.measure>=first&&pair.start.measure<=last;
      const inEnd=pair.end.measure>=first&&pair.end.measure<=last;
      if(inStart===inEnd)continue;
      halves.push({event:inStart?pair.start:pair.end,pair,side:inStart?'outgoing':'incoming'});
    }
    const scan=image.getBoundingClientRect();
    const gap=Number(latest.scanStaffSpacePx)*scan.width/(image.naturalWidth||latest.scanWidthPx||2300)*staffSizeFactor;
    if(!(gap>2&&Array.isArray(latest.barlines)))return false;
    const drawing=svg.querySelector('svg.definition-scale')||svg,ctm=drawing.getScreenCTM();
    if(!ctm)return false;
    const inv=ctm.inverse(),point=(x,y)=>new DOMPoint(x,y).matrixTransform(inv),fmt=p=>`${p.x.toFixed(3)} ${p.y.toFixed(3)}`;
    const layer=document.createElementNS('http://www.w3.org/2000/svg','g');
    layer.setAttribute('class','pl-full-score-boundary-ties');layer.setAttribute('fill','currentColor');
    const source=xmlMeasures(),native=$(svg,'g.tie').filter(t=>getComputedStyle(t).visibility!=='hidden');
    const claimed=new Set(),records=[],unresolved=[];
    for(const half of halves){
      const {event,pair}=half,outgoing=half.side==='outgoing',node=mapped.get(event.id);
      const mi=event.measure-first,xmlNote=source[mi]&&directChildren(source[mi],'note')[event.index];
      const p=xmlNote&&directChildren(xmlNote,'pitch')[0];
      // Full-score indexes must refer to exactly the same note in the excerpt.
      if(!node?.isConnected||!p||
         [localContent(p,'step'),localContent(p,'alter','0'),localContent(p,'octave')].join(':')!==event.pitch||
         localContent(xmlNote,'staff','1')!==event.staff){
        unresolved.push({event:event.id,side:half.side,reason:'full-score/excerpt event mismatch'});continue;
      }
      const r=headRect(node),edge=scan.left+latest.barlines[outgoing?latest.barlines.length-1:0]*scan.width;
      let left=edge+gap*.18;
      if(!outgoing){
        for(const symbol of $(node.closest('g.measure'),'g.clef,g.keySig,g.meterSig')){
          const box=symbol.getBoundingClientRect();
          if(box.width>1&&box.left<r.left-gap*.1)left=Math.max(left,box.right+gap*.16);
        }
      }
      const x1=outgoing?r.right+gap*.14:left,x2=outgoing?edge-gap*.18:r.left-gap*.14;
      if(!(r.width>1&&r.height>1&&x2-x1>gap*.35&&x2-x1<scan.width*.5)){
        unresolved.push({event:event.id,side:half.side,reason:'insufficient boundary clearance'});continue;
      }
      const sibling=halves.filter(h=>h.side===half.side&&h.event.staff===event.staff&&
        h.event.measure===event.measure&&Math.abs(h.event.onset-event.onset)<1e-7);
      const ranks=sibling.map(h=>h.event.rank),low=Math.min(...ranks),high=Math.max(...ranks);
      const orientation=pair.orientation;
      const side=orientation==='over'?-1:orientation==='under'?1:
        high>low?(event.rank>(low+high)/2?-1:1):(event.stem==='down'?-1:1);
      const y=side===1?r.bottom-r.height*.18:r.top+r.height*.18;
      const width=x2-x1,rise=Math.max(gap*.38,Math.min(gap*.95,width*.09)),weight=Math.max(.62,gap*.095);
      const a=point(x1,y),b=point(x2,y),c=point(x1+width*.30,y+side*rise),d=point(x2-width*.30,y+side*rise);
      const e=point(x2-width*.30,y+side*(rise+weight)),f=point(x1+width*.30,y+side*(rise+weight));
      const path=document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d',`M${fmt(a)} C${fmt(c)} ${fmt(d)} ${fmt(b)} C${fmt(e)} ${fmt(f)} ${fmt(a)} Z`);
      path.dataset.sourceEvent=event.id;path.dataset.boundarySide=half.side;
      path.dataset.linkedEvent=outgoing?pair.endID:pair.startID;
      layer.appendChild(path);
      // Retire only a native edge curve associated with this original anchor.
      // Internal tie replacements and unrelated native symbols stay intact.
      const old=preAlignmentHeadBoxes.get(event.id);
      const candidates=old?native.filter(t=>!claimed.has(t)&&t.closest('g.measure')===node.closest('g.measure')).map(t=>{
        const box=t.getBoundingClientRect();
        return {node:t,score:Math.abs((outgoing?box.left:box.right)-(outgoing?old.right:old.left))+
          Math.abs((box.top+box.bottom)/2-(old.top+old.bottom)/2)*.5};
      }).sort((a,b)=>a.score-b.score):[];
      if(candidates[0]&&candidates[0].score<gap*4){claimed.add(candidates[0].node);candidates[0].node.style.visibility='hidden';}
      records.push({event:event.id,side:half.side,linkedEvent:outgoing?pair.endID:pair.startID,pitch:event.pitch});
    }
    if(records.length)drawing.appendChild(layer);
    window.PianoBoundaryTieAudit={expected:halves.length,drawn:records.length,records,unresolved,source:'full-score exact temporal continuity'};
    svg.dataset.fullScoreBoundaryExpected=String(halves.length);svg.dataset.fullScoreBoundaryDrawn=String(records.length);
    // Every native tie came from a source tie endpoint. Once ALL excerpt
    // endpoints have exact regenerated internal/boundary geometry, retire the
    // entire obsolete native tie plane, including curves stranded far outside
    // their old measure. Nearest-rectangle matching cannot reliably identify
    // such displaced curves and previously left duplicate/orphan arcs visible.
    const expectedEndpoints=window.PianoMusicSemantics.eventsFromXML(latest.xml,first)
      .flatMap(e=>[...(e.start?[e.id+':start']:[]),...(e.stop?[e.id+':stop']:[])]);
    const covered=new Set((window.PianoTieAudit?.records||[])
      .flatMap(r=>[r.start+':start',r.end+':stop']));
    for(const r of records)covered.add(r.event+(r.side==='outgoing'?':start':':stop'));
    const complete=expectedEndpoints.length>0&&expectedEndpoints.every(id=>covered.has(id));
    let retired=0;
    if(complete)for(const tie of $(svg,'g.tie')){tie.style.visibility='hidden';retired++;}
    window.PianoTieRetirementAudit={expectedEndpoints:expectedEndpoints.length,coveredEndpoints:covered.size,complete,nativeRetired:retired,
      unresolved:expectedEndpoints.filter(id=>!covered.has(id))};
    context.lastAttachmentReport+=` · ${records.length}/${halves.length} full-score boundary ties`;
    return true;
  }
  return {sourceTiePairs,reflowTies,reflowFullScoreBoundaryTies};
}};
