/* Produce a repeat-free MusicXML score for flexible performance pagination. */
(function(root,factory) {
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else {
    root.PianoPerformanceEngraving=api;
    if(root.PianoPerformance)root.PianoPerformance.flattenMusicXML=api.flattenMusicXML;
  }
})(typeof globalThis!=='undefined'?globalThis:this,function() {
  'use strict';
  const navigationWords=/^\s*(?:(?:D\s*\.\s*[SC]\s*\.?)(?:\s+(?:al|a\]|a)?\s*(?:Coda|Fine))?|To\s+Coda|Coda|Fine)\s*\.?\s*$/i;
  const chordWords=/^(?:CB|N\.?\s*C\.?|[A-G](?:[#b♯♭])?|[A-Ga-g][#b♯♭]?(?:maj|min|m|M|dim|aug|sus|add|ø|°|\d|[#b♯♭()\/+−-]).*)$/;
  const navigationSounds=['segno','coda','dalsegno','dacapo','tocoda','fine','forward-repeat'];
  function children(node,tag) {
    return Array.from(node.children||[]).filter(x=>!tag||x.localName===tag);
  }
  function flattenMusicXML(xml,route,options= {
  }) {
    if(typeof DOMParser==='undefined'||typeof XMLSerializer==='undefined')throw new Error('MusicXML reflow requires a browser XML parser.');
    const doc=new DOMParser().parseFromString(xml,'application/xml');
    if(doc.getElementsByTagName('parsererror').length)throw new Error('MusicXML could not be parsed.');
    const score=doc.documentElement;
    if(score.localName!=='score-partwise')throw new Error('Performance reflow requires partwise MusicXML.');
    for(const label of score.querySelectorAll('part-name,part-abbreviation'))label.textContent='';
    const parts=children(score,'part');
    if(parts.length!==1)throw new Error('Performance reflow currently supports one grand-staff part.');
    const part=parts[0],source=children(part,'measure'),order=Array.isArray(route)?route:route.measures;
    if(!Array.isArray(order)||!order.length||order.some(i=>!Number.isInteger(i)||i<0||i>=source.length))throw new Error('The performance route contains invalid source measures.');
    const snapshots=[],active=new Map(),outputAttributes=new Map(),attributeOrder=['divisions','key','time','staves','part-symbol','instruments','clef','staff-details','transpose'];
    const attributeKey=value=>value.localName+':'+(value.getAttribute('number')||'');
    const snapshot=()=>[...active.values()].sort((a,b)=>attributeOrder.indexOf(a.localName)-attributeOrder.indexOf(b.localName)).map(v=>v.cloneNode(true));
    for(const measure of source) {
      let entry=null;
      for(const node of children(measure)) {
        if(node.localName==='note'&&entry===null)entry=snapshot();
        if(node.localName==='attributes')for(const value of children(node)) {
          if(attributeOrder.includes(value.localName))active.set(attributeKey(value),value.cloneNode(true));
        }
      }snapshots.push(entry||snapshot());
    }
    const semanticValue=node=>[node.localName,[...node.attributes].filter(a=>!['print-object','default-x','default-y','relative-x','relative-y'].includes(a.name)).map(a=>a.name+'='+a.value).sort().join(','),children(node).length?children(node).map(semanticValue).join('|'):node.textContent.trim()].join(':');
    // This corpus encodes sounding pitches during octave lines. Verovio moves
    // their glyphs automatically. Convert an absolute printed-register repair
    // back to that input convention, so a retained 8va cannot lower it twice.
    const octaveAtNote=new Map(),octaveShifts=new Map();
    source.forEach((measure,mi)=>{let ni=0;for(const node of children(measure)){if(node.localName==='direction'){const staff=children(node,'staff')[0]?.textContent||'1';for(const shift of node.querySelectorAll('octave-shift')){const key=staff+':'+(shift.getAttribute('number')||'1'),kind=shift.getAttribute('type'),size=Number(shift.getAttribute('size')||8),octaves=size===8?1:size===15?2:size===22?3:0;if(kind==='stop')octaveShifts.delete(key);else if(kind==='down'||kind==='up')octaveShifts.set(key,kind==='down'?octaves:-octaves);}}if(node.localName==='note'){const staff=children(node,'staff')[0]?.textContent||'1';octaveAtNote.set(mi+':'+ni,[...octaveShifts].filter(([key])=>key.startsWith(staff+':')).reduce((sum,[key,value])=>sum+value,0));ni++;}}});
    for(const measure of source)measure.remove();
    for(let visit=0;
    visit<order.length;
    visit++) {
      const index=order[visit],measure=source[index].cloneNode(true),incoming=visit===0||order[visit-1]!==index-1,outgoing=visit===order.length-1||order[visit+1]!==index+1;
      measure.setAttribute('number',String(visit+1));
      measure.removeAttribute('width');
      // Scan-evidenced written registers are absolute replacements, applied once
      // to each performed clone; the canonical source and octave signs survive.
      children(measure,'note').forEach((note,ni)=> {
        const target=options.printedOctaveOverrides?.[`p0-m${index}-n${ni}`],octave=note.querySelector('pitch > octave');
        if(octave&&Number.isInteger(target)&&target>=0&&target<=9)octave.textContent=String(target+(octaveAtNote.get(index+':'+ni)||0));
      });
      // Original positioning cannot survive a new page width. Keep vertical engraving intent.
      for(const node of [measure,...measure.querySelectorAll('*')]) {
        node.removeAttribute('default-x');
        node.removeAttribute('relative-x');
        if(node.localName!=='instrument') {
          node.removeAttribute('id');
          node.removeAttributeNS('http://www.w3.org/XML/1998/namespace','id');
        }
      }
      for(const node of measure.querySelectorAll('print,harmony'))node.remove();
      // Chord tones share the onset's beam. Repeated beam tags in imported
      // chord members confuse the engine and can suppress following notes.
      let chordParent=null;
      for(const note of children(measure,'note')) {
        if(children(note,'chord').length&&chordParent) {
          for(const beam of children(note,'beam'))if(children(chordParent,'beam').some(parent=>(parent.getAttribute('number')||'1')===(beam.getAttribute('number')||'1')&&parent.textContent.trim()===beam.textContent.trim()))beam.remove();
        }else chordParent=note;
      }
      if(incoming) {
        for(const node of children(measure)) {
          if(node.localName==='note')break;
          if(node.localName==='attributes')node.remove();
        }const attributes=doc.createElement('attributes');
        for(const value of snapshots[index])attributes.appendChild(value.cloneNode(true));
        measure.insertBefore(attributes,measure.firstChild);
      }
      // Canonical imports repeat the same clef/meter in every measure. Emit only
      // actual changes, including state restored after a noncontiguous jump.
      for(const attributes of children(measure,'attributes')) {
        for(const value of children(attributes)) {
          if(!attributeOrder.includes(value.localName))continue;
          const key=attributeKey(value),semantic=semanticValue(value);
          if(outputAttributes.get(key)===semantic)value.remove();
          else outputAttributes.set(key,semantic);
        }if(!children(attributes).length)attributes.remove();
      }
      for(const direction of measure.querySelectorAll('direction')) {
        for(const type of children(direction,'direction-type')) {
          for(const value of children(type))if(value.localName==='segno'||value.localName==='coda'||value.localName==='words'&&(navigationWords.test(value.textContent)||chordWords.test(value.textContent.trim())))value.remove();
          if(!children(type).length)type.remove();
        }
        for(const sound of children(direction,'sound')) {
          for(const key of navigationSounds)sound.removeAttribute(key);
          if(!sound.attributes.length&&!children(sound).length)sound.remove();
        }
        if(!children(direction,'direction-type').length&&!children(direction,'sound').length)direction.remove();
      }
      for(const barline of measure.querySelectorAll('barline')) {
        const hadRepeat=children(barline,'repeat').length>0;
        for(const child of children(barline))if(child.localName==='repeat'||child.localName==='ending')child.remove();
        if(hadRepeat) {
          const style=children(barline,'bar-style')[0];
          if(style)style.textContent=visit===order.length-1?'light-heavy':'regular';
        }if(!children(barline).length)barline.remove();
      }
      // Only cross-boundary ties are severed. Ties wholly inside a measure survive.
      const pending=new Map(),externalStops=[];
      for(const note of children(measure,'note')) {
        const pitch=children(note,'pitch')[0];
        if(!pitch)continue;
        const value=name=> {
          const node=children(pitch,name)[0];
          return node?node.textContent:'';
        };
        const voice=children(note,'voice')[0],staff=children(note,'staff')[0];
        const key=[voice?voice.textContent:'1',staff?staff.textContent:'1',value('step'),value('alter')||'0',value('octave')].join(':');
        const ties=Array.from(note.querySelectorAll('tie,tied')),types=new Set(ties.map(t=>t.getAttribute('type')));
        if(types.has('stop')||types.has('continue')) {
          if(pending.has(key))pending.delete(key);
          else externalStops.push(note);
        }
        if(types.has('start')||types.has('continue'))pending.set(key,note);
      }
      function sever(note,type) {
        for(const tie of note.querySelectorAll('tie,tied')) {
          if(tie.getAttribute('type')===type)tie.remove();
          else if(tie.getAttribute('type')==='continue')tie.setAttribute('type',type==='start'?'stop':'start');
        }
      }
      if(incoming)for(const note of externalStops)sever(note,'stop');
      if(outgoing)for(const note of pending.values())sever(note,'start');
      for(const notation of measure.querySelectorAll('notations'))if(!children(notation).length)notation.remove();
      part.appendChild(measure);
    }
    for(const sound of score.querySelectorAll('sound'))for(const key of navigationSounds)sound.removeAttribute(key);
    return '<?xml version="1.0" encoding="UTF-8"?>\n'+new XMLSerializer().serializeToString(score);
  }
  return {
    flattenMusicXML
  };
});
