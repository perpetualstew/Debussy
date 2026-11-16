"use strict";
/* Rendering-input adapter. Keep the original source MusicXML unchanged.
   A chord member (<chord/>) contributes a simultaneous pitch, not an
   independent rhythmic beam onset. Some sources repeat the parent's beam
   state on that second note; the direct Verovio importer can then truncate
   the beamed chord or following voice. Normalize only this redundancy in
   the transient copy given to Verovio, never in the Beat Atlas or score. */
(function () {
  const kids=(node,name)=>Array.from(node.children).filter(x=>x.localName===name);
  const text=(node,tag)=>kids(node,tag)[0]?.textContent?.trim()||'';
  function applyScanEngraving(xml, first, overrides, wordCorrections){
    const doc=new DOMParser().parseFromString(xml,'application/xml');
    if(doc.querySelector('parsererror'))throw Error('Invalid scan-correction input');
    for(const words of doc.querySelectorAll('direction-type > words')){
      const corrected=wordCorrections?.[words.textContent];
      if(typeof corrected==='string')words.textContent=corrected;
      if(corrected&&typeof corrected==='object'&&['normal','bold'].includes(corrected.fontWeight))words.setAttribute('font-weight',corrected.fontWeight);
    }
    const measures=[...doc.querySelectorAll('score-partwise > part > measure')];
    for(const [id,fix] of Object.entries(overrides||{})){
      const match=/^p0-m(\d+)-n(\d+)$/.exec(id);
      const note=match&&kids(measures[Number(match[1])-Number(first)]||{children:[]},'note')[Number(match[2])];
      if(!note)throw Error('Scan correction event missing: '+id);
      const pitch=note.querySelector('pitch'),actual=pitch?[text(pitch,'step'),text(pitch,'alter')||'0',text(pitch,'octave')].join(':'):'rest';
      if(actual!==fix.pitch)throw Error('Scan correction pitch changed: '+id);
      if(fix.pitchStep&&/^[A-G]$/.test(fix.pitchStep))pitch.querySelector('step').textContent=fix.pitchStep;
      if(fix.removeAccidental==='natural'){if(text(pitch,'alter')==='0')kids(pitch,'alter').forEach(a=>a.remove());for(const a of kids(note,'accidental')){if(a.textContent!=='natural')throw Error('Accidental correction changed: '+id);a.remove();}}
      if(Number.isFinite(fix.defaultX))note.setAttribute('default-x',String(fix.defaultX));
      for(const name of fix.removeArticulations||[]){
        if(name==='staccato')for(const mark of note.querySelectorAll('notations > articulations > staccato'))mark.remove();
      }
      if(fix.prependQuarter){
        const forward=note.previousElementSibling;
        if(forward?.localName!=='forward'||text(forward,'duration')!=='18'||text(note,'voice')!=='3')throw Error('Missing-note anchor changed: '+id);
        forward.querySelector('duration').textContent='12';
        const added=doc.createElement('note');added.setAttribute('default-x','274');
        const put=(parent,name,value)=>{const n=doc.createElement(name);if(value!==undefined)n.textContent=String(value);parent.appendChild(n);return n;};
        const pitch=put(added,'pitch');put(pitch,'step','F');put(pitch,'octave','4');
        put(added,'duration','6');put(added,'voice','3');put(added,'type','quarter');put(added,'stem','up');put(added,'staff','1');
        note.parentNode.insertBefore(added,note);
      }

      if(fix.restoreQuarterTriplet){
        const next=note.nextElementSibling;
        if(actual!=='E:0:4'||text(note,'duration')!=='6'||text(note,'voice')!=='1'||next?.localName!=='note'||text(next.querySelector('pitch'),'step')!=='F'||text(next,'duration')!=='6'||text(next,'voice')!=='1')throw Error('Triplet restoration anchor changed: '+id);
        const put=(parent,name,value)=>{const n=doc.createElement(name);if(value!==undefined)n.textContent=String(value);parent.appendChild(n);return n;};
        const added=next.cloneNode(true);added.querySelector('pitch > step').textContent='G';added.setAttribute('default-x','258');next.after(added);
        for(const [i,n] of [note,next,added].entries()){
          n.querySelector('duration').textContent='4';n.setAttribute('default-x',String(166+i*46));
          const tm=doc.createElement('time-modification');put(tm,'actual-notes',3);put(tm,'normal-notes',2);n.insertBefore(tm,n.querySelector('stem'));
          if(i!==1){let no=n.querySelector('notations');if(!no){no=doc.createElement('notations');n.appendChild(no);}const t=put(no,'tuplet');t.setAttribute('type',i===0?'start':'stop');t.setAttribute('number','1');if(i===0)t.setAttribute('placement','above');}
        }
      }

      if(['up','down'].includes(fix.stem)){
        let stem=kids(note,'stem')[0];
        if(!stem){stem=doc.createElement('stem');note.insertBefore(stem,kids(note,'staff')[0]||null);}
        stem.textContent=fix.stem;
      }
    }
    return new XMLSerializer().serializeToString(doc);
  }
  function prepare(xml, options = {}) {
    const doc=new DOMParser().parseFromString(xml,'application/xml');
    if(doc.querySelector('parsererror'))throw Error('MusicXML cannot be normalized: invalid XML');
    // Instrument names add no information in this solo-piano library and
    // can protrude beyond the system crop. Suppress them before engraving.
    for(const label of doc.querySelectorAll('score-part > part-name, score-part > part-abbreviation, score-part > part-name-display, score-part > part-abbreviation-display'))label.remove();
    let tagged=0;
    if(options.collectionDraft) Array.from(doc.querySelectorAll("part > measure")).forEach((m,mi)=>kids(m,"note").forEach((n,ni)=>{n.setAttribute("id",`pl-m${mi}-n${ni}`);tagged++;}));
    let removed=0, octaveNotes=0, octaveDirections=0, hiddenHarmonies=0, repeatedSignatures=0, restoredDirections=0;
    // Christmas Song s15: the canonical full score prints a D.S. al Coda
    // direction AFTER the final m56 double barline. The historic system
    // excerpt accidentally dropped that final direction. Recreate it only in
    // Verovio's transient input; the score/excerpt and all approved notes
    // remain byte-for-byte unchanged. Guard the exact system boundaries.
    if (options.pieceSlug === 'the-christmas-song' && Number(options.first) === 53) {
      const measures=Array.from(doc.querySelectorAll('part > measure'));
      if(measures.length===3 && measures[0].getAttribute('number')==='54'
          && measures[2].getAttribute('number')==='56') {
        const final=measures[2];
        const bar=kids(final,'barline').find(x=>x.getAttribute('location')==='right');
        const already=Array.from(final.querySelectorAll('direction-type > words'))
          .some(x=>x.textContent.trim()==='D.S. al Coda');
        if(bar && !already) {
          const direction=doc.createElement('direction');direction.setAttribute('placement','above');
          const directionType=doc.createElement('direction-type');
          const words=doc.createElement('words');words.textContent='D.S. al Coda';
          directionType.appendChild(words);direction.appendChild(directionType);
          const staff=doc.createElement('staff');staff.textContent='1';direction.appendChild(staff);
          const sound=doc.createElement('sound');sound.setAttribute('dalsegno','segno-25');
          direction.appendChild(sound);final.insertBefore(direction,bar.nextSibling);
          restoredDirections++;
        }
      }
    }
    // Drafts from this collection carry repeated context attributes in each
    // measure. Compare semantic signature values, retaining real changes and
    // every system's initial context. Never change the editable source.
    if(options.collectionDraft === true) {
      for(const part of doc.querySelectorAll('score-partwise > part')) {
        const active=new Map();
        const signature=node=>[node.localName,Array.from(node.attributes).filter(a=>!['print-object','default-x','default-y','relative-x','relative-y'].includes(a.name)).map(a=>[a.name,a.value]).sort(),Array.from(node.children).map(signature),node.children.length?'':node.textContent.trim()];
        for(const measure of kids(part,'measure')) for(const attrs of kids(measure,'attributes')) {
          for(const node of Array.from(attrs.children)) {
            if(!['clef','key','time'].includes(node.localName))continue;
            const key=node.localName+':'+(node.getAttribute('number')||'all');
            const value=JSON.stringify(signature(node));
            if(active.get(key)===value){node.remove();repeatedSignatures++;}
            else active.set(key,value);
          }
        }
      }
      // Playback-only navigation metadata has no printed direction. Verovio
      // otherwise invents a visible To Coda / D.S. label. Retain canonical XML.
      for(const direction of doc.querySelectorAll('direction')){
        if(direction.querySelector('sound') && !direction.querySelector('direction-type > *')){
          direction.remove();removed++;
        }
      }
      // Remove harmony before spacing, rather than hide its SVG bounding box.
      // Notes, dynamics, navigation and arbitrary expression words are kept.

    }
    if(options.showHarmony !== true)for(const h of doc.querySelectorAll('harmony')){h.remove();hiddenHarmonies++;}
    if(options.showHarmony !== true)for(const direction of doc.querySelectorAll('direction')){
      const words=direction.querySelector('direction-type > words')?.textContent?.trim()||'';
      if(words==='CB'||/^(?:N\.?\s*C\.?|[A-Ga-g][#b♯♭]?(?:maj|min|m|M|dim|aug|sus|add|ø|°|\d|[#b♯♭()\/+−-]).*)$/.test(words)){
        direction.remove();hiddenHarmonies++;
      }
    }

    if(options.initialTimeVisible===false){
      for(const part of doc.querySelectorAll('score-partwise > part')){
        const initial=kids(part,'measure')[0];
        for(const t of initial?.querySelectorAll('attributes > time')||[]){t.setAttribute('print-object','no');repeatedSignatures++;}
      }
    }
    for(const measure of doc.querySelectorAll('part > measure')) {
      let parent=null;
      for(const el of kids(measure,'note')) {
        if(kids(el,'chord').length && parent) {
          const parentBeams=kids(parent,'beam');
          for(const beam of kids(el,'beam')) {
            const number=beam.getAttribute('number')||'1';
            if(parentBeams.some(b=>(b.getAttribute('number')||'1')===number && b.textContent.trim()===beam.textContent.trim())) {
              beam.remove();removed++;
            }
          }
        } else parent=el;
      }
    }
    // MusicXML stores sounding pitches during octave shifts. Verovio's
    // direction-dependent layout shifts can spill across voice boundaries,
    // especially near the final barline. For this *glyph-only* input, lift
    // active 8vb pitches into their printed register and render the dotted
    // octave line separately using the immutable source event anchors.
    // The actual score and Beat Atlas retain sounding octaves unchanged.
    const active=new Map();
    for(const part of ((options.collectionDraft && !options.normalizeOctaveShifts) ? [] : doc.querySelectorAll('score-partwise > part'))) {
      active.clear();
      for(const measure of kids(part,'measure')) {
        for(const child of Array.from(measure.children)) {
          if(child.localName==='direction') {
            const shifts=Array.from(child.querySelectorAll('direction-type > octave-shift'));
            for(const shift of shifts) {
              const staff=text(child,'staff')||'1';
              const kind=shift.getAttribute('type');
              if(kind==='stop')active.delete(staff);
              else if(kind==='up' && shift.getAttribute('size')==='8')active.set(staff,1);
              else if(kind==='down' && shift.getAttribute('size')==='8')active.set(staff,0); // This source encodes printed 8va pitches already; draw span only.
              else continue;
              octaveDirections++;
              shift.remove();
            }
            // The removed shift was the direction's only musical content.
            // Its printed line is generated after final note positioning.
            if(shifts.length && !child.querySelector('direction-type > *'))child.remove();
          } else if(child.localName==='note') {
            const semitones=active.get(text(child,'staff')||'1')||0;
            const pitch=kids(child,'pitch')[0],oct=pitch&&kids(pitch,'octave')[0];
            if(semitones && oct && Number.isFinite(Number(oct.textContent))){
              oct.textContent=String(Number(oct.textContent)+semitones);
              octaveNotes++;
            }
          }
        }
      }
    }
    // Scan-evidenced written-register corrections are explicit data, separate
    // from sounding pitches and octave-line semantics in canonical MusicXML.
    // Event indexes are immutable; only transient glyph-input octaves change.
    let printedOctaveCorrections=0;
    if(options.printedOctaveOverrides){
      Array.from(doc.querySelectorAll('part > measure')).forEach((measure,mi)=>{
        kids(measure,'note').forEach((note,ni)=>{
          const id=`p0-m${Number(options.first)+mi}-n${ni}`;
          const target=options.printedOctaveOverrides[id],oct=note.querySelector('pitch > octave');
          if(oct&&Number.isInteger(target)&&target>=0&&target<=9&&Number(oct.textContent)!==target){
            oct.textContent=String(target);printedOctaveCorrections++;
          }
        });
      });
    }
    return {xml:(printedOctaveCorrections||tagged||removed||octaveDirections||hiddenHarmonies||repeatedSignatures||restoredDirections)?new XMLSerializer().serializeToString(doc):xml,
      removed,octaveNotes,octaveDirections,hiddenHarmonies,repeatedSignatures,restoredDirections,printedOctaveCorrections};
  }
  // Test *glyph supply* separately from event association. Even a clever
  // mapper cannot restore a notehead never emitted by the engraving engine.
  // Source note counts include all chord tones, rests and every voice.
  function supply(svg, source, first) {
    const doc=new DOMParser().parseFromString(source,'application/xml');
    if(doc.querySelector('parsererror'))throw Error('Invalid source XML for supply audit');
    const sourceMs=Array.from(doc.querySelectorAll('part > measure'));
    const renderedMs=Array.from(svg.querySelectorAll('g.measure'));
    const short=[];
    for(let i=0;i<sourceMs.length;i++) {
      const sourceNotes=kids(sourceMs[i],'note');
      // Cross-staff notes live under their voice's owning SVG staff. Count
      // exact source IDs instead of incorrectly treating that as lost supply.
      if(sourceNotes.length && sourceNotes.every(n=>n.getAttribute('id')?.startsWith('pl-m'))){
        const glyphs=Array.from(renderedMs[i]?.querySelectorAll('g.note, g.rest, g.mRest')||[]);
        for(const note of sourceNotes){
          const matches=glyphs.filter(g=>g.id===note.getAttribute('id'));
          if(matches.length!==1)short.push({kind:'supply',measure:Number(first)+i+1,event:note.getAttribute('id'),expected:1,actual:matches.length});
        }
        if(glyphs.length!==sourceNotes.length)short.push({kind:'supply',measure:Number(first)+i+1,expected:sourceNotes.length,actual:glyphs.length});
        continue;
      }
      const perStaff=new Map();
      for(const note of sourceNotes) {
        const staff=Number(text(note,'staff')||1);
        perStaff.set(staff,(perStaff.get(staff)||0)+1);
      }
      const staffSVG=Array.from(renderedMs[i]?.querySelectorAll('g.staff')||[]).filter(x=>x.closest('g.measure')===renderedMs[i]);
      for(const [staff,expected] of perStaff) {
        const node=staffSVG[staff-1];
        const actual=node ? Array.from(node.querySelectorAll('g.note, g.rest, g.mRest')).filter(x=>x.closest('g.staff')===node).length : 0;
        if(actual!==expected)short.push({kind:'supply',measure:Number(first)+i+1,staff,expected,actual});
      }
    }
    return short;
  }
  window.PianoMusicXMLInput={prepare,supply,applyScanEngraving};
})();
