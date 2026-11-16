'use strict';
/* Music time and tie identity do not depend on rendered coordinates. Durations
   are quarter-note units so a divisions change cannot break continuation. */
(function(root){
  const children=(node,name)=>[...node.children].filter(n=>n.localName===name);
  const value=(node,name,fallback='')=>children(node,name)[0]?.textContent.trim()??fallback;
  function eventsFromXML(xml,first=0){
    const doc=new DOMParser().parseFromString(xml,'application/xml');
    if(doc.querySelector('parsererror'))throw Error('Invalid MusicXML for tie semantics');
    const part=doc.querySelector('score-partwise > part');
    if(!part)throw Error('Part missing from tie semantics');
    const measures=children(part,'measure'),events=[];
    let divisions=1,base=0;
    for(let mi=0;mi<measures.length;mi++){
      let cursor=0,previous=0,extent=0,index=0;
      for(const node of measures[mi].children){
        if(node.localName==='attributes'){
          const next=Number(value(node,'divisions','0'));
          if(next>0)divisions=next;
        }
        if(node.localName==='backup'||node.localName==='forward'){
          cursor+=Number(value(node,'duration','0'))/divisions*(node.localName==='backup'?-1:1);
          continue;
        }
        if(node.localName!=='note')continue;
        const id=`p0-m${Number(first)+mi}-n${index++}`;
        const grace=children(node,'grace').length>0,chord=children(node,'chord').length>0;
        const duration=grace?0:Number(value(node,'duration','0'))/divisions;
        const onset=chord?previous:cursor;
        if(!chord){previous=onset;cursor+=duration;}
        extent=Math.max(extent,onset+duration);
        const p=children(node,'pitch')[0];if(!p||grace)continue;
        const visual=[...node.querySelectorAll('notations > tied')];
        const marks=[...children(node,'tie'),...visual];
        const pitch=[value(p,'step'),value(p,'alter','0'),value(p,'octave')].join(':');
        events.push({id,measure:Number(first)+mi,localMeasure:mi,index:index-1,
          staff:value(node,'staff','1'),voice:value(node,'voice','1'),pitch,
          rank:Number(value(p,'octave'))*7+'CDEFGAB'.indexOf(value(p,'step')),
          onset:base+onset,localOnset:onset,end:base+onset+duration,duration,
          start:marks.some(t=>t.getAttribute('type')==='start'),
          stop:marks.some(t=>t.getAttribute('type')==='stop'),
          orientation:visual.find(t=>t.hasAttribute('orientation'))?.getAttribute('orientation')||null,
          stem:value(node,'stem','')});
      }
      base+=extent;
    }
    return events;
  }
  function pairEvents(events){
    const pairs=[],used=new Set(),unresolved=[];
    for(const start of events.filter(e=>e.start)){
      const possible=events.filter(e=>e.stop&&!used.has(e.id)&&e.id!==start.id&&
        e.staff===start.staff&&e.pitch===start.pitch&&Math.abs(e.onset-start.end)<1e-7);
      const sameVoice=possible.filter(e=>e.voice===start.voice);
      const candidates=sameVoice.length?sameVoice:possible;
      if(candidates.length===1){
        const end=candidates[0];used.add(end.id);
        pairs.push({start,end,startID:start.id,endID:end.id,measure:start.localMeasure,
          orientation:start.orientation||end.orientation});
      }else unresolved.push({event:start.id,reason:candidates.length?'ambiguous continuation':'continuation outside input or missing'});
    }
    return {pairs,unresolved};
  }
  const api={eventsFromXML,pairEvents};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PianoMusicSemantics=api;
})(typeof window==='object'?window:globalThis);
