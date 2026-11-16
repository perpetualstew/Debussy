'use strict';
/* Source-coordinate layout owns the complete note plan, then applies attachments.
   Mutable renderer state enters through an explicit context; no DOM bootstrap here. */
window.PianoSourceLayout={create(context){
  function positionFromOriginalMusicXML(svg) {
    const {$, latest, mapped, image, staffSizeFactor, addTranslation, createAnnotationLayer, directChildren, drawAnnotationLine, engravingPoint, headRect, headX, localContent, measureEventSourceX, noCoordinateMeasurePositions, reflowSourceInternalSignatures, registerOpeningSystem, staffGroups, staffLineBox, xmlMeasures}=context;
    const geom=window.PianoLayoutGeometry;
    if(!geom)throw Error('PianoLayoutGeometry dependency missing');
    const xml=xmlMeasures(), measures=$(svg,'g.measure'),first=Number(latest.first);
    if(xml.length!==measures.length || latest.barlines.length!==xml.length+1)
      throw Error('Layout input and scan measure boundaries disagree');
    const scan=image.getBoundingClientRect();
    const bars=latest.barlines.map(x=>scan.left+x*scan.width);
    const staffGap=(Number(latest.scanStaffSpacePx)||17)*scan.width/(image.naturalWidth||2300)*staffSizeFactor;
    const plan=new Map(), noteShifts=new Map(), originalCenters=new Map();
    const explicitlyInferredEventIDs=new Set();
    const sourceOwners=new Map(), annotations=[];
    const beamSpecs=[];
    let recovered=0,correctedTupletColumns=0,prov=[],placed=0,clearances=0;
    const sourceTupletRhythmCorrections=[];
    const sourceRhythmCorrections=[];
    const sourceVoiceOnsetCorrections=[];
    const stats={beam:0,hook:0,beamUnknown:0,arp:0,arpUnknown:0,tuplet:0,
      tupletUnknown:0,single:0,singleUnknown:0};

    // Capture original stem locations and beam polygons before moving a note.
    // They are genuine attachments, not bounding boxes of entire beamed runs.
    for(const beam of $(svg,'g.beam')){
      const groupNotes=$(beam,'g.chord, g.note').filter(n=>n.closest('g.beam')===beam &&
        (n.classList.contains('chord')||!n.closest('g.chord')));
      const stems=[];
      for(const node of groupNotes){
        const ownStem=node.querySelector(':scope > g.stem');
        const fallback=node.closest('g.chord')?.querySelector(':scope > g.stem');
        const stem=ownStem||fallback;
        const r=(stem||node).getBoundingClientRect();
        stems.push({node,x:(r.left+r.right)/2});
      }
      const shapes=Array.from(beam.children).filter(n=>
        ['polygon','polyline','path','rect'].includes(n.localName));
      if(shapes.length)beamSpecs.push({beam,stems,shapes,measure:beam.closest('g.measure')});
    }
    const originalArps=$(svg,'g.arpeg, g.arpeggio, g.arpegLine, g.arpeggiate')
      .filter(g=>!g.parentElement?.closest('g.arpeg, g.arpeggio, g.arpegLine, g.arpeggiate'));
    const semantic=['g.dir','g.dynam','g.harm','g.tempo','g.fermata','g.ornam',
      'g.artic','g.trill','g.lyric','g.reh','g.flag','g.breath','g.caesura'];
    const singleGroups=[...new Set($(svg,semantic.join(',')))].filter(n=>{
      if(n.closest('g.note, g.chord, g.beam, g.tuplet'))return false;
      if(n.classList.contains('dynam')||n.querySelector('g.dynam'))return false;
      if(n.parentElement?.closest(semantic.join(',')))return false;
      return !!n.closest('g.measure');
    }).map(n=>({node:n,rect:n.getBoundingClientRect(),
      measure:n.closest('g.measure'),staff:n.closest('g.staff')}));

    // System symbols do not have MusicXML note coordinates; register them
    // separately, before first-note clearance is calculated.
    const opening=registerOpeningSystem(svg,bars[0],staffGap);
    context.lastOpeningReport=`opening: ${opening.braces} brace, ${opening.signatures} signature groups`;

    // Musical onset is independent of engraving x. Accidentals can push
    // different voices of a beat to slightly different horizontal columns;
    // their left-side clearance must still be evaluated as ONE event group.
    function onsetTable(measure) {
      const positions=new Map();
      let cursor=0,previous=0;
      for(const child of measure.children){
        if(child.localName==='backup')cursor-=Number(localContent(child,'duration','0'))||0;
        else if(child.localName==='forward')cursor+=Number(localContent(child,'duration','0'))||0;
        else if(child.localName==='note'){
          const chord=directChildren(child,'chord').length>0;
          const at=chord?previous:cursor;
          positions.set(child,at);
          if(!chord){previous=at;cursor+=Number(localContent(child,'duration','0'))||0;}
        }
      }
      return positions;
    }
    // Stage 1: determine every note/chord's final x without editing the SVG.
    for(let mi=0;mi<xml.length;mi++){
      const sourceWidth=Number(xml[mi].getAttribute('width'));
      if(!(sourceWidth>0))continue;
      const notes=directChildren(xml[mi],'note');
      const onsets=onsetTable(xml[mi]);
      const positions=measureEventSourceX(xml[mi]);
      recovered+=positions.recovered;
      correctedTupletColumns+=positions.correctedTupletColumns||0;
      sourceTupletRhythmCorrections.push(...(positions.correctedTupletRhythm||[]));
      sourceRhythmCorrections.push(...(positions.rhythmCorrections||[]));
      sourceVoiceOnsetCorrections.push(...(positions.correctedVoiceOnsets||[]));
      const inferred=positions.positions;
      // Beginning to Look a Lot Like Christmas, s12/m43: the entire RH
      // opening voice (including its rest) lacks source default-x, although
      // the LH has usable printed x positions. Constrain only those RH onset
      // columns between the LH x=101 at time 0 and x=295 at time 36.
      // This respects source rhythmic ordering and keeps its final accented
      // chord inside m43; it is intentionally provisional until scan review.
      if(latest?.pieceSlug==='it-s-beginning-to-look-a-lot-like-christmas' &&
         first===42 && mi===0 && Number(xml[mi].getAttribute('width'))===378){
        const anchorNotes=notes.filter(n=>localContent(n,'staff','1')==='2'&&
          n.hasAttribute('default-x') && !directChildren(n,'chord').length);
        const left=anchorNotes.find(n=>onsets.get(n)===0);
        const right=anchorNotes.find(n=>onsets.get(n)===36);
        if(left && right && Number(left.getAttribute('default-x'))===101 &&
           Number(right.getAttribute('default-x'))===295){
          let filled=0;
          for(const note of notes){
            if(localContent(note,'staff','1')!=='1' ||
               note.hasAttribute('default-x') || inferred.has(note))continue;
            const at=onsets.get(note);
            if(!Number.isFinite(at)||at<0||at>30)continue;
            inferred.set(note,101+(295-101)*at/36);
            explicitlyInferredEventIDs.add(`p0-m${first+mi}-n${notes.indexOf(note)}`);
            filled++;
          }
          if(filled)recovered+=filled;
        }
      }
      const fallback=noCoordinateMeasurePositions(xml[mi],mi,first,bars,mapped,new Map(
        [...mapped].map(([id,n])=>[n,headX(n)])));
      if(fallback){
        prov.push(first+mi+1);
        for(const [note,x] of fallback)inferred.set(note,x);
      }
      for(let ni=0;ni<notes.length;ni++){
        const note=notes[ni],el=mapped.get(`p0-m${first+mi}-n${ni}`);
        const sx=inferred.get(note);
        if(!el||!Number.isFinite(sx))continue;
        const owner=el.closest('g.chord')||el;
        const oldX=headX(el);
        const target=bars[mi]+sx/sourceWidth*(bars[mi+1]-bars[mi]);
        const item=plan.get(owner);
        const hasIndividualHead=el!==owner && el.closest('g.chord')===owner &&
          Number.isFinite(headX(el));
        if(!item){
          plan.set(owner,{owner,mi,measure:measures[mi],staff:owner.closest('g.staff'),
            oldX,target,onset:onsets.get(note),sourceNotes:[note],elements:[el],
            sourceMinX:sx,nominal:hasIndividualHead?{sx,target,oldX}:null,
            originalBox:owner.getBoundingClientRect()});
        }else{
          item.sourceNotes.push(note);item.elements.push(el);
          // Preserve the verified pre-existing chord mapping unless a second
          // voice shares the RIGHT (nominal) source column. A left-offset
          // second on its own is NOT grounds to move an approved chord.
          item.target=(item.target*(item.elements.length-1)+target)/item.elements.length;
          item.sourceMinX=Math.min(item.sourceMinX,sx);
          if(hasIndividualHead && (!item.nominal || sx>item.nominal.sx))
            item.nominal={sx,target,oldX};
        }
        sourceOwners.set(note,owner);
      }
    }
    // Missing-x grace notes need a plan entry even when other voices have
    // conflicting simultaneous accidental columns. They cannot borrow that
    // averaged onset x. Anchor the isolated grace to its following same-voice,
    // same-staff sounding event, preserving the small native grace separation.
    let createdGracePlans=0;
    for(let mi=0;mi<xml.length;mi++){
      const notes=directChildren(xml[mi],'note'),onsets=onsetTable(xml[mi]);
      for(let ni=0;ni<notes.length;ni++){
        const note=notes[ni];
        if(!directChildren(note,'grace').length||note.hasAttribute('default-x')||sourceOwners.has(note))continue;
        const id=`p0-m${first+mi}-n${ni}`,el=mapped.get(id);
        const next=notes.slice(ni+1).find(n=>!directChildren(n,'grace').length&&
          localContent(n,'staff','1')===localContent(note,'staff','1')&&
          localContent(n,'voice','1')===localContent(note,'voice','1'));
        const main=next&&plan.get(sourceOwners.get(next));
        const mainEl=next&&mapped.get(`p0-m${first+mi}-n${notes.indexOf(next)}`);
        if(!el||!main||!mainEl||onsets.get(note)!==onsets.get(next))continue;
        const owner=el.closest('g.chord')||el;
        if(plan.has(owner))continue;
        const natural=headX(mainEl)-headX(el);
        const gap=Math.max(staffGap*1.35,Math.min(staffGap*2.25,natural>0?natural:staffGap*1.55));
        const target=headX(mainEl)+main.target-main.oldX-gap;
        if(!(target>bars[mi]+staffGap*.5&&target<bars[mi+1]-staffGap*.5))continue;
        plan.set(owner,{owner,mi,measure:measures[mi],staff:owner.closest('g.staff'),
          oldX:headX(el),target,onset:onsets.get(note),sourceNotes:[note],elements:[el],
          sourceMinX:NaN,nominal:null,originalBox:owner.getBoundingClientRect(),createdGracePlan:true});
        sourceOwners.set(note,owner);explicitlyInferredEventIDs.add(id);recovered++;createdGracePlans++;
      }
    }
    svg.dataset.createdGracePlans=String(createdGracePlans);

    // Source-proven opening-column reanchor: in Most Wonderful s17 m64 the
    // RH first voice starts at default-x 25 even though the simultaneous RH
    // second voice and LH are at 111–123. The source scan clearly places the
    // RH A-flat on the same attack as the other voices, AFTER the five-flat
    // opening signature. This is a malformed VOICE origin, not missing music.
    // Recover the constant offset from the LH onset-0 chord's source x,
    // then apply it to this RH voice's three notes only; do not touch any
    // score XML, locked-system snapshot, other voice, or scanned barline.
    let openingVoiceReanchors=0;
    if(latest?.pieceSlug==='the-most-wonderful-time-of-the-year' && first===63 &&
       xml[0]?.getAttribute('width')==='370'){
      const notes=directChildren(xml[0],'note');
      const is=(n,step,oct,staff,voice,x)=>n &&
        localContent(n.querySelector('pitch'),'step','')===step &&
        localContent(n.querySelector('pitch'),'octave','')===oct &&
        localContent(n,'staff','1')===staff && localContent(n,'voice','1')===voice &&
        Number(n.getAttribute('default-x'))===x;
      if(notes.length>=7 && is(notes[0],'A','4','1','1',25) &&
         is(notes[1],'G','4','1','1',90) &&
         is(notes[2],'E','4','1','1',124) &&
         is(notes[5],'A','2','2','5',123)){
        const deltaSource=Number(notes[5].getAttribute('default-x'))-
          Number(notes[0].getAttribute('default-x'));
        const delta=deltaSource/370*(bars[1]-bars[0]);
        const owners=notes.slice(0,3).map(n=>plan.get(sourceOwners.get(n)));
        if(owners.every((p,i)=>p && p.sourceNotes.includes(notes[i]) &&
             p.sourceNotes.length===1 && p.mi===0) && delta>0 && delta<staffGap*16){
          for(const p of owners){p.target+=delta;openingVoiceReanchors++;}
        }
      }
    }
    svg.dataset.sourceOpeningVoiceReanchors=String(openingVoiceReanchors);

    // Annotated alignment measures: source positions describe individual
    // heads, so a displaced chord must use its right head, never their mean.
    const alignmentMeasures={"the-christmas-song":[5,14,19,22,24,37,42,63],"christmas-time-is-here":[8,10,16,18,24,26,32,34,72,74,80,82],"frosty-the-snowman":[6,15,16,17,18,19,30,31,32,33,34,40,41,42,43,59,60,61,62,63,74,75,76,77,78],"have-yourself-a-merry-little-christmas":[0,1,2,3,4,6,32,12,13,14,15,16,17,18,19,20,21,22,23,24,33,34,35,36,37,38,39,40,41,55,56,57,58],"there-s-no-place-like-home-for-the-holidays":[4,16,17,18,19],"i-ll-be-home-for-christmas":[5,6,7,8,9,10,11,12,18,19,20,21,26,27,28,29,67,68,69,70],"i-ve-got-my-love-to-keep-me-warm":[20,21,22,23,27,53],"it-s-beginning-to-look-a-lot-like-christmas":[10,74],"let-it-snow-let-it-snow-let-it-snow":[5,24,25,26,27,28],"rudolph-the-red-nosed-reindeer":[42,10,11,12,13,14,30,31,32,33,34,61,62,63,64,65,98,99,100,101,102],"the-most-wonderful-time-of-the-year":[0,1,2,3,44,45,46,47],"we-wish-you-the-merriest":[33,34,35,36,61,62,63,64,65,76,77,78,79,84,85,86,87]};
    const alignMeasure=mi=>(alignmentMeasures[latest.pieceSlug]||[]).includes(first+mi);
    let mixedVoiceAnchors=0;
    const approvedAlignedPieces=new Set([
      'the-christmas-song','christmas-time-is-here',
      'frosty-the-snowman','have-yourself-a-merry-little-christmas'
    ]);
    // For newly aligned arrangements ONLY: anchor a mixed-voice half-note
    // chord using the translation of its normal (rightmost) source notehead.
    // Keep item.oldX equal to its original VEROVIO position: changing oldX to
    // the head's position while retaining old originalBox breaks subsequent
    // attachment and nearest-anchor calculations. Only the final translation
    // changes; sibling heads, stem and accidentals stay in one rigid SVG group.
    if(!approvedAlignedPieces.has(latest?.pieceSlug))for(const p of plan.values()){
      if(alignMeasure(p.mi))continue;
      const n=p.nominal;
      if(!n || p.sourceNotes.length<2 || n.sx-p.sourceMinX<5 ||
        !p.sourceNotes.some(note=>localContent(note,'type')==='half'))continue;
      const chordVoice=localContent(p.sourceNotes[0],'voice','1');
      const companion=[...plan.values()].some(o=>o!==p && o.mi===p.mi &&
        o.staff===p.staff && o.onset===p.onset && o.sourceNotes.length===1 &&
        localContent(o.sourceNotes[0],'type')==='quarter' &&
        localContent(o.sourceNotes[0],'voice','1')!==chordVoice &&
        Math.abs(o.target-n.target)<Math.max(2,staffGap*.18));
      if(companion){
        const dx=n.target-n.oldX;
        // Preserve the original owner anchor in the plan and move its complete
        // engraved group by the nominal head's source-defined displacement.
        if(Number.isFinite(dx) && Math.abs(dx)<svg.getBoundingClientRect().width*2){
          p.target=p.oldX+dx;
          mixedVoiceAnchors++;
        }
      }
    }
    for(const p of plan.values()){
      if(!alignMeasure(p.mi)||!p.nominal||p.sourceNotes.length<2||p.nominal.sx-p.sourceMinX<5)continue;
      const xs=p.elements.map(headX);
      if(Math.max(...xs)-Math.min(...xs)<staffGap*.3)continue;
      p.target=p.oldX+p.nominal.target-p.nominal.oldX;
    }
    // m56: the G3 in voice 2 is a deliberately displaced (left) chord tone.
    // The E4 of voice 1 aligns with A3/C4, not with the bounding box of G3.
    // Register this relationship in the coordinate PLAN, before any glyph moves.
    if(latest?.pieceTitle==='Christmas Time Is Here'){
      const mi=56-first-1;
      if(mi>=0&&mi<xml.length){
        const entries=[...plan.values()].filter(v=>v.mi===mi&&v.staff===staffGroups(measures[mi])[0]);
        const hasPitch=(entry,step,oct)=>entry.sourceNotes.some(n=>
          localContent(n.querySelector('pitch'),'step','')===step &&
          localContent(n.querySelector('pitch'),'octave','')===oct);
        const chord=entries.find(v=>hasPitch(v,'A','3')&&hasPitch(v,'C','4'));
        const melody=entries.find(v=>hasPitch(v,'E','4'));
        const preferred=chord && $(chord.owner,'g.note').find(n=>
          n.getAttribute('data-pname')==='c'&&n.getAttribute('data-oct')==='4');
        if(chord&&melody&&preferred){
          const preferredX=headX(preferred);
          const needed=melody.target-(preferredX-chord.oldX);
          if(Number.isFinite(needed)&&Math.abs(needed-chord.target)<staffGap*2.2)
            chord.target=needed;
        }
      }
    }

    // One clearance calculation per opening column, before any transformations.
    // The source layout remains authoritative except for small, bounded gaps.
    for(let mi=0;mi<measures.length;mi++){
      for(const staff of staffGroups(measures[mi])){
        const entries=[...plan.values()].filter(p=>p.mi===mi&&p.staff===staff).sort((a,b)=>a.target-b.target);
        if(!entries.length)continue;
        let requirement=bars[mi]+Math.max(5,staffGap*(mi===0?1.12:.62));
        // Only on a system-opening measure, account for clef and key signatures.
        if(mi===0){
          for(const g of $(staff,'g.clef, g.keySig')){
            const r=g.getBoundingClientRect();
            if(Number.isFinite(r.right))requirement=Math.max(requirement,r.right+staffGap*1.22);
          }
        }
        const firstX=entries[0].target;
        const firstOnset=Math.min(...entries.map(e=>e.onset).filter(Number.isFinite));
        const group=entries.filter(e=>e.onset===firstOnset);
        const predicted=group.map(p=>({left:p.originalBox.left+p.target-p.oldX}));
        let extra=geom.openingClearance(requirement,predicted,0,staffGap*4);
        if(extra && entries.length>group.length){
          const later=entries.filter(e=>e.onset!==firstOnset);
          if(later.length){
            const next=Math.min(...later.map(e=>e.target));
            extra=Math.min(extra,Math.max(0,(next-Math.max(...group.map(e=>e.target)))*.45));
          }
        }
        if(extra>0){group.forEach(p=>p.target+=extra);clearances++;}
      }
    }

    // Two source-defined opening details: the first right-hand chord of m15
    // needs three distinct accidentals, and the second left-hand attack of
    // m24 needs clearance from the preceding flagged/ledger-lined note.
    // Keep these bounded, rhythmic-onset adjustments in the PLAN rather than
    // applying post hoc corrections to the SVG or moving any scanned barline.
    const originalChristmasSong = latest?.pieceTitle === "The Christmas Song";
    let measuredCollisionRepairs=0;
    for(const [measureNumber,staffNumber,firstTime,secondTime] of (originalChristmasSong ? [[15,1,0,null],[24,2,0,6]] : [])){
      const mi=measureNumber-first-1;
      if(mi<0||mi>=measures.length)continue;
      const staff=staffGroups(measures[mi])[staffNumber-1];
      if(!staff)continue;
      const entries=[...plan.values()].filter(p=>p.mi===mi&&p.staff===staff);
      const firstNotes=entries.filter(p=>p.onset===firstTime);
      const later=entries.filter(p=>p.onset>firstTime);
      if(!firstNotes.length||!later.length)continue;
      if(measureNumber===15){
        // Reserve room for E-natural | F-sharp | B-natural. B-natural needs
        // its own innermost column without covering its B4 notehead.
        const next=Math.min(...later.map(p=>p.target));
        const furthest=Math.max(...firstNotes.map(p=>p.target));
        const room=Math.max(0,(next-furthest)*.46);
        const adjustment=Math.min(staffGap*.9,room);
        if(adjustment>0.2){for(const item of firstNotes)item.target+=adjustment;measuredCollisionRepairs++;}
      }else{
        const secondNotes=entries.filter(p=>p.onset===secondTime);
        if(!secondNotes.length)continue;
        const leftFirst=Math.max(...firstNotes.map(p=>p.originalBox.right+p.target-p.oldX));
        const leftSecond=Math.min(...secondNotes.map(p=>p.originalBox.left+p.target-p.oldX));
        const desired=Math.max(2,staffGap*.40);
        const shortfall=leftFirst+desired-leftSecond;
        const next=entries.filter(p=>p.onset>secondTime);
        const limit=next.length?Math.max(0,(Math.min(...next.map(p=>p.target))-Math.max(...secondNotes.map(p=>p.target)))*.35):staffGap;
        const adjustment=Math.min(Math.max(0,shortfall),staffGap*1.35,limit);
        if(adjustment>0.2){for(const item of secondNotes)item.target+=adjustment;measuredCollisionRepairs++;}
      }
    }

    svg.dataset.mixedVoiceAnchors=String(mixedVoiceAnchors);

    // Grace notes without print coordinates must NOT borrow the main note's
    // rhythmic x column: an acciaccatura has the same onset as its destination
    // but a DISTINCT engraved position to the left. Locate its destination
    // through the exact MusicXML slur number/staff/voice within one measure.
    // Do not alter any explicit source-x or any main-note destination.
    let recoveredGraceOffsets=0;
    for(let mi=0;mi<xml.length;mi++){
      const pending=new Map();let ni=0;
      for(const note of directChildren(xml[mi],'note')){
        const eventID=`p0-m${first+mi}-n${ni++}`;
        const keyPart=`${localContent(note,'staff','1')}:${localContent(note,'voice','1')}:`;
        for(const slur of $(note,'notations > slur')){
          const key=keyPart+(slur.getAttribute('number')||'1');
          if(slur.getAttribute('type')==='start')pending.set(key,{note,eventID});
          else if(slur.getAttribute('type')==='stop'&&pending.has(key)){
            const start=pending.get(key);pending.delete(key);
            const graceSource=Number(start.note.getAttribute('default-x'));
            const mainSource=Number(note.getAttribute('default-x'));
            const coincidentSource= start.note.hasAttribute('default-x') &&
              note.hasAttribute('default-x') && Number.isFinite(graceSource) &&
              Number.isFinite(mainSource) && Math.abs(graceSource-mainSource)<.25;
            // Verovio/MusicXML may give a grace and its destination the SAME
            // default-x. Such a pair must be separated even though neither
            // coordinate is absent. Explicitly different x values stay intact.
            if(!directChildren(start.note,'grace').length ||
              (start.note.hasAttribute('default-x')&&!coincidentSource) ||
              !note.hasAttribute('default-x'))continue;
            const from=mapped.get(start.eventID),to=mapped.get(eventID);
            const a=plan.get(sourceOwners.get(start.note));
            const b=plan.get(sourceOwners.get(note));
            if(!from||!to||!a||!b||a===b||a.sourceNotes.length!==1||
              !Number.isFinite(b.target))continue;
            const oldGap=headX(to)-headX(from);
            // The SVG has already been scaled to the scanned staff size.
            // Keep a recognizably small grace gap, but never extrapolate an
            // unbounded Verovio distance or push the grace across the barline.
            const distance=Math.max(staffGap*1.35,
              Math.min(staffGap*2.25,Number.isFinite(oldGap)&&oldGap>0?oldGap:staffGap*1.55));
            const desired=b.target-distance;
            if(!(desired>bars[mi]+staffGap*.5) ||
              !(desired<b.target-staffGap*.9))continue;
            a.target=desired;
            a.missingGraceSourceX=true;
            a.coincidentGraceSourceX=coincidentSource;
            recoveredGraceOffsets++;
          }
        }
      }
    }
    svg.dataset.inferredGraceOffsets=String(recoveredGraceOffsets);

    // When malformed or cross-voice slur tags cannot be paired safely, the
    // *grace note* can still have an unambiguous position: its following
    // same-staff, same-voice, same-onset sounding event is the rhythmic anchor.
    // This does not infer slur endpoints and never hides or fabricates curves.
    // A missing source x is essential; printed explicit x and all aligned
    // grace/main pairs above are immutable. Work in the shared source-plan,
    // before the note groups and their attached accidentals are translated.
    let unpairedGraceAnchors=0;
    const unpairedGraceAudit=[];
    for(let mi=0;mi<xml.length;mi++){
      const notes=directChildren(xml[mi],'note'),onsets=onsetTable(xml[mi]);
      for(let ni=0;ni<notes.length;ni++){
        const note=notes[ni];
        if(!directChildren(note,'grace').length || note.hasAttribute('default-x') ||
           !$(note,'notations > slur[type="start"]').length)continue;
        const from=plan.get(sourceOwners.get(note));
        if(!from || from.sourceNotes.length!==1 || from.missingGraceSourceX ||
           !Number.isFinite(from.onset))continue;
        const staff=localContent(note,'staff','1'),voice=localContent(note,'voice','1');
        // Only one immediate following sounding event of the SAME voice and
        // onset is eligible; do not leap to the next beat or another voice.
        const next=notes.slice(ni+1).find(n=>
          localContent(n,'staff','1')===staff &&
          localContent(n,'voice','1')===voice && !directChildren(n,'grace').length);
        if(!next || !next.hasAttribute('default-x') ||
           onsets.get(next)!==from.onset)continue;
        const to=plan.get(sourceOwners.get(next));
        if(!to || to===from || !Number.isFinite(to.target) ||
           !to.sourceNotes.includes(next))continue;
        const sameColumn=notes.filter(n=>
          n!==next && n!==note && !to.sourceNotes.includes(n) &&
          !directChildren(n,'grace').length &&
          localContent(n,'staff','1')===staff &&
          localContent(n,'voice','1')===voice && onsets.get(n)===from.onset);
        if(sameColumn.length)continue;
        const fromGlyph=mapped.get(`p0-m${first+mi}-n${ni}`);
        if(!fromGlyph?.isConnected)continue;
        const toGlyph=mapped.get(`p0-m${first+mi}-n${notes.indexOf(next)}`);
        if(!toGlyph?.isConnected)continue;
        const naturalGap=headX(toGlyph)-headX(fromGlyph);
        const gap=Math.max(staffGap*1.35,Math.min(staffGap*2.25,
          Number.isFinite(naturalGap)&&naturalGap>0?naturalGap:staffGap*1.55));
        const desired=to.target-gap;
        // Preserve the printed barline and earlier attacks; never squeeze a
        // missing grace x across either boundary just to force a repair.
        if(!(desired>bars[mi]+staffGap*.65) ||
           !(desired<to.target-staffGap*.9))continue;
        const previous=[...plan.values()].filter(p=>p.mi===mi && p!==from && p!==to &&
          p.staff===from.staff && Number.isFinite(p.onset) &&
          p.onset<from.onset && p.target<=to.target);
        if(previous.length && desired<Math.max(...previous.map(p=>p.target))+staffGap*.55)
          continue;
        from.target=desired;
        from.missingGraceSourceX=true;
        from.unpairedGraceAnchor=true;
        unpairedGraceAnchors++;
        unpairedGraceAudit.push({event:`p0-m${first+mi}-n${ni}`,
          following:`p0-m${first+mi}-n${notes.indexOf(next)}`,measure:first+mi+1,
          onset:from.onset,source:'same-staff-and-voice-onset',
          slur:'unresolved-by-design'});
      }
    }
    svg.dataset.sourceVoiceOnsetRepairs=String(sourceVoiceOnsetCorrections.length);
    svg.dataset.sourceVoiceOnsetAudit=JSON.stringify(sourceVoiceOnsetCorrections);
    svg.dataset.sourceRhythmRepairs=String(sourceRhythmCorrections.length);
    svg.dataset.sourceRhythmRepairAudit=JSON.stringify(sourceRhythmCorrections);
    svg.dataset.unpairedGraceAnchors=String(unpairedGraceAnchors);
    svg.dataset.unpairedGraceAudit=JSON.stringify(unpairedGraceAudit);

    // INTERNAL METER RESERVATION: a note's MusicXML default-x is relative to
    // its original measure width, whereas the newly scan-aligned time symbol
    // sits independently at the measure boundary. A mid-system time change
    // can consequently overlap the first chord (including displaced seconds)
    // even when every note has a valid source x. Recompute the usable NOTE
    // interval from the final on-screen signature width, not a fixed per-piece
    // offset. Taper the needed opening clearance to zero at the right edge so
    // the scanned barlines and later rhythmic order remain anchored. This
    // operates on the shared plan BEFORE note, beam, tie and grace reflow.
    let meterReservations=0, meterReservationNotes=0, meterReservationAmbiguous=0;
    const meterReservationAudit=[];
    for(let mi=1;mi<xml.length;mi++){
      const measure=xml[mi];
      const children=[...measure.children];
      const firstMusical=children.findIndex(n=>
        ['note','backup','forward','direction'].includes(n.localName));
      const current=children.find((n,index)=> n.localName==='attributes' &&
        (firstMusical<0||index<firstMusical) &&
        directChildren(n,'time').length===1);
      if(!current)continue;
      // Only a real *new* meter consumes an additional opening region.
      // Courtesy/warning signatures commonly appear in the previous measure
      // after its final note and repeats of the active time can occur at the
      // next bar; those must not change any note's horizontal coordinates.
      const previous=xml.slice(0,mi).flatMap(m=>directChildren(m,'attributes')
        .flatMap(a=>directChildren(a,'time'))).at(-1);
      const incoming=directChildren(current,'time')[0];
      const meterValue=t=>t?localContent(t,'beats','')+'/'+localContent(t,'beat-type',''):'';
      if(!previous || !incoming || meterValue(previous)===meterValue(incoming))continue;
      const staves=staffGroups(measures[mi]);
      if(staves.length!==2)continue;
      const signatures=staves.map(staff=>$(staff,'g.meterSig').filter(n=>
        n.closest('g.staff')===staff && !n.parentElement?.closest('g.meterSig')));
      if(signatures.some(g=>g.length!==1)){
        meterReservationAmbiguous++;continue;
      }
      const glyphRects=signatures.map(g=>g[0].getBoundingClientRect());
      if(glyphRects.some(r=>!(r.width>1&&Number.isFinite(r.width)))){
        meterReservationAmbiguous++;continue;
      }
      // This is the SAME boundary anchor used later by
      // reflowSourceInternalSignatures; the path width comes from Verovio.
      const meterEnd=bars[mi]+staffGap*.32 + Math.max(...glyphRects.map(r=>r.width));
      const starts=[...plan.values()].filter(p=>p.mi===mi && p.onset===0 &&
        p.sourceNotes.some(n=>!directChildren(n,'grace').length) &&
        Number.isFinite(p.target) && Number.isFinite(p.oldX) &&
        p.elements.length);
      const all=[...plan.values()].filter(p=>p.mi===mi && Number.isFinite(p.target));
      if(!starts.length || all.length<2)continue;
      const firstInk=Math.min(...starts.flatMap(p=>p.elements.map(n=>{
        const r=headRect(n);
        return Number.isFinite(r.left)?p.target+(r.left-p.oldX):NaN;
      })).filter(Number.isFinite));
      if(!Number.isFinite(firstInk))continue;
      // Leave approximately three quarters of a staff space between meter
      // figures and the leftmost notehead, including second-interval chords.
      const required=meterEnd+staffGap*.75;
      const shortfall=required-firstInk;
      if(shortfall<=staffGap*.12)continue;
      // Do not coerce an impossible or badly misidentified source passage.
      if(shortfall>staffGap*3.25){meterReservationAmbiguous++;continue;}
      const firstColumn=Math.min(...starts.map(p=>p.target));
      const right=bars[mi+1]-staffGap*1.15;
      if(!(right>firstColumn+staffGap*8)){
        meterReservationAmbiguous++;continue;
      }
      let shifted=0;
      for(const p of all){
        const weight=Math.max(0,Math.min(1,(right-p.target)/(right-firstColumn)));
        const delta=shortfall*weight;
        if(delta<=.05)continue;
        p.target+=delta;
        shifted+=p.elements.length;
      }
      meterReservations++;
      meterReservationNotes+=shifted;
      meterReservationAudit.push({measure:first+mi+1,source:'initial-time-attributes',
        oldInkLeft:firstInk,meterRight:meterEnd,requiredGap:staffGap*.75,
        adjustment:shortfall,notesMoved:shifted});
    }
    svg.dataset.sourceMeterReservations=String(meterReservations);
    svg.dataset.sourceMeterReservationEvents=String(meterReservationNotes);
    svg.dataset.sourceMeterReservationAmbiguous=String(meterReservationAmbiguous);
    svg.dataset.sourceMeterReservationAudit=JSON.stringify(meterReservationAudit);

    // Explicit scan-reviewed opening-meter reserve. Include every voice in
    // the same taper so simultaneous attacks remain together.
    if(latest.reserveInitialMeter){
      const meters=staffGroups(measures[0]).flatMap(st=>$(st,'g.meterSig')).map(n=>n.getBoundingClientRect()).filter(r=>r.width>1);
      const all=[...plan.values()].filter(p=>p.mi===0),starts=all.filter(p=>p.onset===0&&p.sourceNotes.some(n=>n.querySelector('pitch')));
      if(meters.length===2&&starts.length){
        const ink=Math.min(...starts.flatMap(p=>p.elements.map(n=>headRect(n).left+p.target-p.oldX)));
        const needed=Math.max(...meters.map(r=>r.right))+staffGap*.9-ink;
        if(needed>0&&needed<staffGap*4){
          const firstX=Math.min(...starts.map(p=>p.target)),right=bars[1]-staffGap*1.2;
          for(const p of all)p.target+=needed*Math.max(0,Math.min(1,(right-p.target)/(right-firstX)));
          svg.dataset.openingMeterReserve=String(needed);
        }
      }
    }

    window.PianoSourcePlanSnapshot=xml.flatMap((measure,mi)=>directChildren(measure,'note').map((note,ni)=>{
      const id=`p0-m${first+mi}-n${ni}`,owner=sourceOwners.get(note),p=owner&&plan.get(owner),el=mapped.get(id);
      return {event:id,grace:!!directChildren(note,'grace').length,owner:owner?.id,ownerNotes:p?.sourceNotes.length,target:p?.target,oldX:p?.oldX,onset:p?.onset,svgID:el?.id,ancestry:el?[...(()=>{let a=el,out=[];while(a&&a!==svg){out.push(a.getAttribute('class'));a=a.parentElement;}return out;})()]:[]};
    }));

    // Offline visual search supplies head-center destinations in ORIGINAL
    // SCAN PIXELS. Apply them to the shared plan before any glyph or dependent
    // beam, tie, grace curve, ledger line or direction is rebuilt. A chord is
    // one movable owner: contradictory destinations for its tones are rejected.
    const visualOverrideAudit={applied:[],rejected:[]},overrideOwners=new Map();
    for(const [id,sourcePixelX] of Object.entries(latest.visualXOverrides||{})){
      const match=/^p0-m(\d+)-n(\d+)$/.exec(id),mi=match?Number(match[1])-first:-1;
      const note=mi>=0&&mi<xml.length?directChildren(xml[mi],'note')[Number(match[2])]:null;
      const owner=note&&sourceOwners.get(note),p=owner&&plan.get(owner),el=mapped.get(id);
      const scanWidth=Number(latest.scanWidthPx)||image.naturalWidth;
      if(!p||!el||!Number.isFinite(sourcePixelX)||!(scanWidth>0)){
        visualOverrideAudit.rejected.push({event:id,reason:'event or scan coordinate unavailable'});continue;
      }
      const target=scan.left+Number(sourcePixelX)/scanWidth*scan.width;
      const predicted=headX(el)+p.target-p.oldX;
      if(!(target>bars[mi]+staffGap*.1&&target<bars[mi+1]-staffGap*.1)){
        visualOverrideAudit.rejected.push({event:id,reason:'destination outside measure'});continue;
      }
      const delta=target-predicted,previous=overrideOwners.get(owner);
      if(previous&&Math.abs(previous.delta-delta)>.15){
        previous.conflict=true;visualOverrideAudit.rejected.push({event:id,reason:'contradictory chord destinations'});continue;
      }
      if(!previous)overrideOwners.set(owner,{p,delta,events:[id],target});
      else previous.events.push(id);
    }
    for(const record of overrideOwners.values()){
      if(record.conflict)continue;
      record.p.target+=record.delta;
      visualOverrideAudit.applied.push({events:record.events,deltaScreenPx:record.delta,targetScreenPx:record.target});
    }
    svg.dataset.visualXOverrides=String(visualOverrideAudit.applied.length);
    window.PianoVisualOverrideAudit=visualOverrideAudit;

    // At a shared onset, the upper voice aligns to the lower chord's
    // rightmost head. Do this in the plan so stems, beams, ties and ledgers
    // are rebuilt from the same final positions, rather than dragged later.
    const voiceColumnPairs=[];
    for(const lower of plan.values()){
      const singleHoliday=(latest.pieceSlug==='there-s-no-place-like-home-for-the-holidays'&&lower.elements.includes(mapped.get('p0-m4-n8')))||
        (latest.pieceSlug==='i-ve-got-my-love-to-keep-me-warm'&&lower.elements.includes(mapped.get('p0-m27-n3')));
      if(!alignMeasure(lower.mi)||(lower.elements.length<2&&!singleHoliday))continue;
      if(lower.sourceNotes.some(n=>!n.querySelector('pitch')||n.querySelector('grace')))continue;
      const heads=lower.elements.map(el=>({el,x:headX(el),y:(headRect(el).top+headRect(el).bottom)/2}));
      // The annotated m25 half-note chord has no displaced second; its
      // shared attack still requires the same upper/lower head column.
      const alignPlainChord=(latest.pieceSlug==='the-christmas-song'&&[24,63].includes(first+lower.mi))||
        (latest.pieceSlug==='have-yourself-a-merry-little-christmas'&&first+lower.mi===32)||
        (latest.pieceSlug==='i-ve-got-my-love-to-keep-me-warm'&&first+lower.mi===53)||
        (latest.pieceSlug==='let-it-snow-let-it-snow-let-it-snow'&&first+lower.mi===28)||singleHoliday;
      if(!alignPlainChord&&Math.max(...heads.map(h=>h.x))-Math.min(...heads.map(h=>h.x))<staffGap*.3)continue;
      const holidayAb=latest.pieceSlug==='there-s-no-place-like-home-for-the-holidays'&&lower.elements.includes(mapped.get('p0-m16-n10'));
      const anchorX=(holidayAb?Math.min:Math.max)(...heads.map(h=>h.x));
      const right=anchorX+lower.target-lower.oldX;
      const lowerY=Math.min(...heads.map(h=>h.y));
      const writtenStaff=localContent(lower.sourceNotes[0],'staff','1');
      if(lower.sourceNotes.some(n=>localContent(n,'staff','1')!==writtenStaff))continue;
      const voices=new Set(lower.sourceNotes.map(n=>localContent(n,'voice','1')));
      for(const upper of plan.values()){
        if(upper===lower||upper.mi!==lower.mi||upper.staff!==lower.staff||upper.onset!==lower.onset)continue;
        if(upper.sourceNotes.some(n=>!n.querySelector('pitch')||n.querySelector('grace')||localContent(n,'staff','1')!==writtenStaff||voices.has(localContent(n,'voice','1'))))continue;
        const upperHeads=upper.elements.map(el=>headRect(el));
        if(Math.max(...upperHeads.map(r=>(r.top+r.bottom)/2))>=lowerY-staffGap*.15)continue;
        const upperRight=Math.max(...upper.elements.map(headX))+upper.target-upper.oldX;
        upper.target+=right-upperRight;
        mixedVoiceAnchors++;
        voiceColumnPairs.push({upper:upper.elements.map(el=>[...mapped].find(([,n])=>n===el)?.[0]),lower:lower.elements.filter(el=>!holidayAb||Math.abs(headX(el)-anchorX)<.1).map(el=>[...mapped].find(([,n])=>n===el)?.[0])});
      }
    }
    window.PianoVoiceColumnPairs=voiceColumnPairs;
    svg.dataset.mixedVoiceAnchors=String(mixedVoiceAnchors);

    // Scan-verified shared attacks can cross staves or join plain chords.
    // Move the whole owning group before rebuilding stems, beams and ties.
    const explicitAlignmentAudit={applied:[],rejected:[]};
    for(const pair of latest.alignmentPairs||[]){
      const a=mapped.get(pair.anchor),b=mapped.get(pair.move);
      const anchor=[...plan.values()].find(p=>p.elements.includes(a));
      const moving=[...plan.values()].find(p=>p.elements.includes(b));
      if(!anchor||!moving||anchor.mi!==moving.mi||Math.abs(anchor.onset-moving.onset)>1e-7){
        explicitAlignmentAudit.rejected.push({...pair,reason:'missing or non-simultaneous source events'});continue;
      }
      if(anchor===moving)continue;
      const x=headX(a)+anchor.target-anchor.oldX+(Number.isFinite(pair.offsetStaffSpaces)?pair.offsetStaffSpaces*staffGap:0);
      const delta=x-(headX(b)+moving.target-moving.oldX);
      moving.target+=delta;explicitAlignmentAudit.applied.push({...pair,delta});
    }
    window.PianoExplicitAlignmentAudit=explicitAlignmentAudit;

    // Stage 2: apply those immutable destinations to the musical glyph groups.
    for(const p of plan.values()){
      const dx=p.target-p.oldX;
      if(!Number.isFinite(dx)||!addTranslation(p.owner,dx))continue;
      noteShifts.set(p.owner,dx);
      for(const el of p.elements){noteShifts.set(el,dx);originalCenters.set(el,p.oldX);}
      placed+=p.elements.length;
      annotations.push({owner:p.owner,staff:p.staff,measure:p.measure,
        oldX:p.oldX,dx,mi:p.mi});
    }

    // A tertiary (32nd) beam may span only the FINAL pair of stems, even
    // though its parent g.beam contains the entire eighth/16th run. Gather
    // the source note's beam-number declarations so the third level can be
    // assigned from MUSIC rather than a bounding-box nearest-stem guess.
    function sourceBeamLevels(spec){
      const matches=[];
      const mi=measures.indexOf(spec.measure);
      if(mi<0)return matches;
      const notes=directChildren(xml[mi],'note');
      for(let ni=0;ni<notes.length;ni++){
        const n=notes[ni],svgNode=mapped.get(`p0-m${first+mi}-n${ni}`);
        if(!svgNode || svgNode.closest('g.beam')!==spec.beam)continue;
        const stem=svgNode.closest('g.chord')||svgNode;
        const stemItem=spec.stems.find(item=>item.node===stem || item.node.contains(svgNode));
        if(!stemItem)continue;
        const declarations=directChildren(n,'beam').map(b=>({
          level:Number(b.getAttribute('number')||1),action:b.textContent.trim().toLowerCase()
        }));
        if(declarations.length)matches.push({stemItem,declarations});
      }
      return matches;
    }

    // Stage 3: reconstruct beam geometry once, with no intermediate mutation.
    // Polygon endpoints are attached to their corresponding original stems;
    // ordinary primary beams can expand, while short hooks translate rigidly.
    for(const spec of beamSpecs){
      const stems=spec.stems.map(s=>({...s,dx:noteShifts.get(s.node) ??
        noteShifts.get(s.node.closest('g.chord'))}));
      const levelNotes=sourceBeamLevels(spec);
      // An unchanged beam may legitimately have no entries in noteShifts:
      // its entire stem run was left at native positions because the source
      // has no trustworthy default-x values. Keep that ink exactly in place
      // only if BOTH geometric endpoints and MusicXML's begin/end declarations
      // identify the same complete stem run. Never invent a translation.
      // This case is deliberately limited to the unapproved Ill Be Home s11.
      const untouchedSourceBeam=latest?.pieceSlug==='i-ll-be-home-for-christmas' &&
        first===42 && Number(latest.last)===45 &&
        spec.measure===measures[0] && spec.shapes.length===1 &&
        stems.length>=2 && stems.every(s=>s.dx===undefined) &&
        levelNotes.some(n=>n.declarations.some(d=>d.level===1 && d.action==='begin') &&
          n.stemItem.node===stems[0].node) &&
        levelNotes.some(n=>n.declarations.some(d=>d.level===1 && d.action==='end') &&
          n.stemItem.node===stems[stems.length-1].node) &&
        (()=>{const box=spec.shapes[0].getBoundingClientRect();
          return box.width>1 && Math.abs(box.left-stems[0].x)<2 &&
            Math.abs(box.right-stems[stems.length-1].x)<2;})();
      if(untouchedSourceBeam){
        // Verified unchanged, hence already attached. Do not redraw it.
        stats.beam++;
        continue;
      }
      // Verovio emits primary beam first, then additional beam polygons.
      // For an explicit 32nd run, the source-defined third-level start/end
      // notes are more reliable anchors than the polygon's original bbox.
      const sourceSpan=level=>{
        const notes=levelNotes.filter(a=>a.declarations.some(d=>d.level===level));
        return notes.length>=2 ? [notes[0],notes[notes.length-1]] : null;
      };
      const secondaryEnds=sourceSpan(2),tertiaryEnds=sourceSpan(3);
      for(let shapeIndex=0;shapeIndex<spec.shapes.length;shapeIndex++){
        const shape=spec.shapes[shapeIndex];
        const r=shape.getBoundingClientRect();
        if(!(r.width>1))continue;
        let assignment=geom.beamAssignment(stems,r.left,r.right);
        // Assign the THIRD beam level from the two notes declaring level 3.
        // Match against its actual stem pair so a short displaced tertiary
        // segment cannot be attached to the preceding eighth-note stem.
        // A simple 32nd group has exactly three beam polygons: primary,
        // secondary and tertiary, in that order. Limit source-ownership
        // override to that unambiguous case; other beam structures keep the
        // tested geometry matcher and fail safely if ownership is unknown.
        const specific=tertiaryEnds && spec.shapes.length===3
          ? (shapeIndex===1?secondaryEnds:shapeIndex===2?tertiaryEnds:null) : null;
        if(specific){
          const a=stems.find(x=>x.node===specific[0].stemItem.node);
          const b=stems.find(x=>x.node===specific[1].stemItem.node);
          if(a&&b&&a.x<b.x&&Number.isFinite(a.dx)&&Number.isFinite(b.dx))
            assignment={kind:'span',dxL:a.dx,dxR:b.dx};
        }
        // The extra, shorter layers in 32nd-note groups can have bevelled
        // endpoints well inside the parent stems. Apply a bounded fallback
        // ONLY for 32nd-note measures; otherwise retain the strict matcher.
        if(!assignment){
          const mi=Array.from($(svg,'g.measure')).indexOf(spec.measure);
          if(mi>=0 && directChildren(xml[mi],'note').some(n=>localContent(n,'type','')==='32nd'))
            assignment=geom.beamAssignment32(stems,r.left,r.right);
        }
        if(!assignment){stats.beamUnknown++;continue;}
        if(assignment.kind==='hook'){
          if(addTranslation(shape,assignment.dx))stats.hook++;
          else stats.beamUnknown++;
          continue;
        }
        const pts=geom.readPolygon(shape.getAttribute('points'));
        const scale=shape.getScreenCTM()?.a;
        if(!pts||!Number.isFinite(scale)){
          stats.beamUnknown++;continue;
        }
        const updated=geom.warpPolygonPoints(pts,assignment.dxL,assignment.dxR,scale);
        if(!updated){stats.beamUnknown++;continue;}
        shape.setAttribute('points',geom.drawPolygon(updated));stats.beam++;
      }
    }

    // The scan prints Rudolph's opening LH triplet beam horizontally.
    if(latest.pieceSlug==='rudolph-the-red-nosed-reindeer'&&first===0){
      const notes=['p0-m4-n12','p0-m4-n13'].map(id=>mapped.get(id)),beam=notes[0]?.closest('g.beam');
      const polygon=beam?.querySelector(':scope > polygon');
      const stems=notes.map(n=>n?.querySelector('g.stem'));
      if(polygon&&notes[1]?.closest('g.beam')===beam&&stems.every(Boolean)){
        const r=polygon.getBoundingClientRect(),y=Math.min(...stems.map(n=>n.getBoundingClientRect().top));
        const thickness=staffGap*.38,inv=polygon.getScreenCTM().inverse();
        const points=[[r.left,y],[r.right,y],[r.right,y+thickness],[r.left,y+thickness]].map(([x,y])=>new DOMPoint(x,y).matrixTransform(inv));
        polygon.setAttribute('points',points.map(p=>p.x+','+p.y).join(' '));
        for(const stem of stems){
          const r=stem.getBoundingClientRect(),inv=stem.getScreenCTM().inverse(),x=(r.left+r.right)/2;
          const a=new DOMPoint(x,y+thickness*.5).matrixTransform(inv),b=new DOMPoint(x,r.bottom).matrixTransform(inv);
          const line=document.createElementNS('http://www.w3.org/2000/svg','line');
          for(const [k,v] of Object.entries({x1:a.x,y1:a.y,x2:b.x,y2:b.y}))line.setAttribute(k,String(v));
          line.setAttribute('stroke','#111');line.setAttribute('stroke-width',String(Math.max(.9,r.width)));line.setAttribute('vector-effect','non-scaling-stroke');stem.replaceChildren(line);
        }
        beam.dataset.scanFlatTriplet='true';
      }
    }

    // Stage 4: translate semantic single-anchor elements once, using ORIGINAL
    // staff and measure anchors. Detached note embellishments never steal a
    // nearby note from a different staff or measure.
    const nearest=(items,x)=>items.reduce((a,b)=>Math.abs(a.oldX-x)<Math.abs(b.oldX-x)?a:b);
    for(const s of singleGroups){
      let anchors=annotations.filter(a=>a.measure===s.measure&&a.staff===s.staff);
      if(!anchors.length)anchors=annotations.filter(a=>a.measure===s.measure);
      if(!anchors.length){stats.singleUnknown++;continue;}
      const x=(s.rect.left+s.rect.right)/2;
      if(addTranslation(s.node,nearest(anchors,x).dx))stats.single++;
      else stats.singleUnknown++;
    }

    // Dynamics have exact rhythmic offsets (including eighth-note onsets),
    // not simply a parent beat. Place source directions at their musical
    // time using the same planned notes. A note-independent symbol is moved
    // ONCE without modifying any note, beam or barline.
    let timedDynamics=0;
    for(let mi=0;mi<xml.length;mi++){
      const rows=[];
      const onsets=onsetTable(xml[mi]);
      for(const [note,time] of onsets){
        const owner=sourceOwners.get(note),entry=plan.get(owner);
        if(entry&&Number.isFinite(entry.target)&&Number.isFinite(time))
          rows.push({time,x:entry.target,staff:localContent(note,'staff','1')});
      }
      if(!rows.length)continue;
      const directionTimes=[];let cursor=0;
      for(const child of xml[mi].children){
        if(child.localName==='backup')cursor-=Number(localContent(child,'duration','0'))||0;
        else if(child.localName==='forward')cursor+=Number(localContent(child,'duration','0'))||0;
        else if(child.localName==='note'){
          if(!directChildren(child,'chord').length)cursor+=Number(localContent(child,'duration','0'))||0;
        }else if(child.localName==='direction' && child.querySelector('direction-type > dynamics')){
          directionTimes.push(cursor+(Number(localContent(child,'offset','0'))||0));
        }
      }
      const symbols=$(measures[mi],'g.dynam').filter(g=>!g.parentElement?.closest('g.dynam')&&!/^(dim\.|cresc\.)$/.test(g.textContent.trim()));
      if(symbols.length!==directionTimes.length)continue;
      for(let k=0;k<symbols.length;k++){
        const time=directionTimes[k],sorted=[...rows].sort((a,b)=>a.time-b.time || a.x-b.x);
        const exact=sorted.filter(r=>Math.abs(r.time-time)<1e-7);
        let target;
        if(exact.length)target=Math.min(...exact.map(r=>r.x));
        else{
          const before=sorted.filter(r=>r.time<time).sort((a,b)=>b.time-a.time)[0];
          const after=sorted.find(r=>r.time>time);
          if(before&&after)target=before.x+(after.x-before.x)*(time-before.time)/(after.time-before.time);
          else target=(before||after)?.x;
        }
        const r=symbols[k].getBoundingClientRect();
        if(Number.isFinite(target)&&r.width>0 && addTranslation(symbols[k],target-(r.left+r.right)/2)){
          symbols[k].dataset.universalAnchor='source-timed-dynamic';timedDynamics++;
        }
      }
    }

    // Expression directions need the same rhythmic anchors as dynamics.
    // Native word positions no longer apply after the note columns are moved.
    if(originalChristmasSong){
      for(let mi=0;mi<xml.length;mi++){
        const rows=[...onsetTable(xml[mi])].map(([note,time])=>({time,entry:plan.get(sourceOwners.get(note))})).filter(r=>r.entry);
        let cursor=0;
        for(const child of xml[mi].children){
          if(child.localName==='backup')cursor-=Number(localContent(child,'duration','0'));
          else if(child.localName==='forward')cursor+=Number(localContent(child,'duration','0'));
          else if(child.localName==='note'&&!child.querySelector('chord'))cursor+=Number(localContent(child,'duration','0'));
          else if(child.localName==='direction'){
            const word=child.querySelector('direction-type > words')?.textContent?.trim();
            if(!/^(rit\.|dim\.|cresc\.|a tempo)$/.test(word||'') && !(first===0&&mi===0&&word==='Sentimentally'))continue;
            const time=cursor+Number(localContent(child,'offset','0'));
            const exact=rows.filter(r=>r.time===time);if(!exact.length)continue;
            const target=Math.min(...exact.map(r=>r.entry.target));
            const glyph=$(measures[mi],'g.dir, g.dynam, g.tempo').find(g=>g.textContent.trim()===word);if(!glyph)continue;
            let x=target;
            if(word==='a tempo'){
              const dynamic=measures[mi].querySelector('g.dynam');
              if(dynamic)x=Math.max(x,dynamic.getBoundingClientRect().right+staffGap*.6);
            }
            const box=glyph.getBoundingClientRect();
            const dynamic=word==='a tempo'?measures[mi].querySelector('g.dynam'):null;
            addTranslation(glyph,x-box.left,dynamic?dynamic.getBoundingClientRect().bottom-box.bottom:0);
            glyph.dataset.rhythmicExpressionTime=String(time);
          }
        }
      }
    }

    // Each accidental is positioned as its OWN glyph while the chord stays
    // intact. At m15 the explicit printed ordering is E-natural (outer),
    // F-sharp (middle), B-natural (innermost, next to B4). Engraved accidentals
    // are preserved at their original scale; make room via the stage-1 plan.
    let accidentalColumnsImproved=0;
    for(let mi=0;mi<xml.length;mi++){
      if(!originalChristmasSong || first+mi+1!==15)continue;
      const notes=directChildren(xml[mi],'note'),onsets=onsetTable(xml[mi]);
      const glyphs=[];
      for(let ni=0;ni<notes.length;ni++){
        const n=notes[ni];
        if(localContent(n,'staff','1')!=='1'||onsets.get(n)!==0)continue;
        const el=mapped.get(`p0-m${first+mi}-n${ni}`);
        if(!el)continue; // Missing SVG glyphs must not crash annotation positioning.
        const pitch=localContent(n.querySelector('pitch'),'step','');
        const octave=localContent(n.querySelector('pitch'),'octave','');
        const chord=el?.classList.contains('chord')?el:el?.closest('g.chord');
        const glyph=el?.classList.contains('note')?el:
          $(chord||el,'g.note').find(g=>g.getAttribute('data-pname')===pitch.toLowerCase() &&
            g.getAttribute('data-oct')===octave);
        const acc=glyph?.querySelector('g.accid');
        if(acc && acc.getBoundingClientRect().width>0)
          glyphs.push({pitch,name:localContent(n,'accidental',''),acc,note:glyph});
      }
      const required=[['E','natural'],['F','sharp'],['B','natural']];
      const arranged=required.map(([p,k])=>glyphs.find(g=>g.pitch===p&&g.name===k));
      if(arranged.some(x=>!x))continue;
      const [outer,middle,inner]=arranged;
      const gap=Math.max(1.5,staffGap*.19);
      // Work inside-out to keep the natural B as close to its own note as
      // possible, then position F-sharp and E-natural in distinct outer lanes.
      const head=headRect(inner.note);
      if(!Number.isFinite(head.left))continue;
      const bound=bars[mi]+Math.max(1,staffGap*.08);
      const boxes=arranged.map(g=>g.acc.getBoundingClientRect());
      const targets=[0,0,0];
      targets[2]=head.left-Math.max(1,staffGap*.10)-boxes[2].width;
      targets[1]=targets[2]-gap-boxes[1].width;
      targets[0]=targets[1]-gap-boxes[0].width;
      // If available scan-column space cannot hold all three signs, keep the
      // originally visible arrangement rather than pushing symbols through
      // the barline or pretending the collision was resolved.
      if(targets[0]<bound)continue;
      let corrected=0;
      for(let i=0;i<3;i++){
        const delta=targets[i]-boxes[i].left;
        if(Math.abs(delta)>.2 && addTranslation(arranged[i].acc,delta))corrected++;
      }
      if(corrected)accidentalColumnsImproved++;
    }
    // The second song's m62 bass opening has three accidentals. Their
    // publishing order is B-natural (outer), C-sharp (middle), F-sharp (inner).
    // Reposition the existing glyphs only; do not move their chord heads.
    if(latest?.pieceTitle === 'Christmas Time Is Here'){
      for(let mi=0;mi<xml.length;mi++){
        if(first+mi+1!==62)continue;
        const notes=directChildren(xml[mi],'note'),onsets=onsetTable(xml[mi]);
        const column=new Map();
        for(let ni=0;ni<notes.length;ni++){
          const n=notes[ni];
          if(localContent(n,'staff','1')!=='2'||onsets.get(n)!==0)continue;
          const pitch=n.querySelector('pitch');if(!pitch)continue;
          const step=localContent(pitch,'step',''),oct=localContent(pitch,'octave','');
          if(!(step==='B'&&oct==='3'||step==='C'&&oct==='4'||step==='F'&&oct==='4'))continue;
          const el=mapped.get(`p0-m${first+mi}-n${ni}`);
          const owner=el?.closest('g.chord')||el;
          const tone=el?.classList.contains('note')?el:
            $(owner,'g.note').find(x=>x.getAttribute('data-pname')===step.toLowerCase()&&x.getAttribute('data-oct')===oct);
          const accidental=tone?.querySelector('g.accid');
          const r=accidental?.getBoundingClientRect();
          if(r?.width)column.set(step,{accidental,r,tone});
        }
        if(!['B','C','F'].every(p=>column.has(p)))continue;
        // Keep the B-natural at EXACTLY the v38 outer-column target. The
        // user wants only the two inner sharps brought closer to the notes.
        // Column widths and glyph sizes are never scaled. Small additional
        // overlaps of SVG glyph bounding-box margins are intentional; cap
        // F-sharp against its own notehead to avoid ink collision.
        const gap=-Math.min(1.7,staffGap*.085);
        const headLeft=Math.min(...['B','C','F'].map(k=>headRect(column.get(k).tone).left));
        let right=headLeft-Math.max(.18,staffGap*.012);
        const places=[];
        for(const step of ['F','C','B']){
          const entry=column.get(step);
          const wanted=right-entry.r.width;
          places.push({step,entry,wanted});
          right=wanted-gap;
        }
        // Preserve existing natural placement exactly; move the sharps
        // relative to it instead of compacting the entire stack again.
        if(places.at(-1).wanted<bars[mi]+staffGap*.25)continue;
        const nudge=window.PianoLayoutGeometry?.m62SharpNudgePx?.(staffGap)||1.75;
        for(const {step,entry,wanted} of places){
          let next=wanted;
          if(step==='C')next+=nudge;
          if(step==='F'){
            // F-sharp is already innermost. Allow up to one screen pixel of
            // optical overlap with its notehead, but no additional collision.
            const ownHead=headRect(entry.tone);
            const safeRight=Number.isFinite(ownHead.left)?ownHead.left+Math.min(1.0,staffGap*.075):headLeft;
            next+=Math.max(0,Math.min(nudge,safeRight-(wanted+entry.r.width)));
          }
          if(addTranslation(entry.accidental,next-entry.r.left))accidentalColumnsImproved++;
        }
      }
    }

    // The left-hand G-flat on beat 3 of m15 occupies the outside column in
    // the printed edition, beyond the two flats of the sustained lower chord.
    // Shift only its ACTUAL accidental glyph: pitches, chord positions, and
    // the other two flats remain unchanged and at their native scale.
    let bassOuterAccidentals=0;
    for(let mi=0;mi<xml.length;mi++){
      if(!originalChristmasSong || first+mi+1!==15)continue;
      const notes=directChildren(xml[mi],'note'),onsets=onsetTable(xml[mi]);
      let outer=null;const inside=[];
      for(let ni=0;ni<notes.length;ni++){
        const n=notes[ni],p=n.querySelector('pitch');
        if(localContent(n,'staff','1')!=='2'||onsets.get(n)!==24||
          localContent(n,'accidental','')!=='flat')continue;
        const el=mapped.get(`p0-m${first+mi}-n${ni}`);
        const owner=el?.closest('g.chord')||el;
        const pitch=localContent(p,'step',''),octave=localContent(p,'octave','');
        const tone=el?.classList.contains('note')?el:
          $(owner,'g.note').find(g=>g.getAttribute('data-pname')===pitch.toLowerCase()&&g.getAttribute('data-oct')===octave);
        const glyph=tone?.querySelector('g.accid');
        const rect=glyph?.getBoundingClientRect();
        if(!rect?.width)continue;
        if(pitch==='G'&&octave==='3')outer={glyph,rect};
        else inside.push(rect);
      }
      if(!outer||!inside.length)continue;
      const minimum=Math.min(...inside.map(r=>r.left));
      const desired=minimum-Math.max(2,staffGap*.28)-outer.rect.width;
      const delta=desired-outer.rect.left;
      const lowerBound=bars[mi]+staffGap*.30;
      if(desired>=lowerBound && Math.abs(delta)<staffGap*4 && Math.abs(delta)>.2 &&
        addTranslation(outer.glyph,delta)){bassOuterAccidentals++;}
    }

    // Source-anchored words such as "dim." and "cresc." are Verovio g.dynam
    // groups, but are NOT handled by the glyph-only timed-dynamics loop.
    // Their cursor/offset belongs to musical time even while an obsolete
    // native rectangle happens to remain inside its resized measure. Rebuild
    // missing-print-X words from that source onset and relative-X adjustment.
    // Explicit print-X words retain their supplied position unless escaped.
    let recoveredDynamicWords=0;const dynamicWordRecords=[];
    for(let mi=0;mi<xml.length;mi++){
      let cursor=0,previous=0;
      const noteTime=new Map(), wordTimes=[];
      for(const child of xml[mi].children){
        if(child.localName==='backup')cursor-=Number(localContent(child,'duration','0'))||0;
        else if(child.localName==='forward')cursor+=Number(localContent(child,'duration','0'))||0;
        else if(child.localName==='note'){
          const chord=!!child.querySelector('chord'),at=chord?previous:cursor;
          noteTime.set(child,at);
          if(!chord){previous=at;cursor+=Number(localContent(child,'duration','0'))||0;}
        }else if(child.localName==='direction'){
          const words=child.querySelector('direction-type > words');
          const label=(words?.textContent||'').trim().toLowerCase();
          if(/^(?:dim\.|cresc\.)$/.test(label))wordTimes.push({label,time:cursor+(Number(localContent(child,'offset','0'))||0),
            staff:localContent(child,'staff','1'),relativeX:Number(words.getAttribute('relative-x')||0),
            explicitX:words.hasAttribute('default-x')||child.hasAttribute('default-x')});
        }
      }
      if(!wordTimes.length)continue;
      const glyphs=$(measures[mi],'g.dynam').filter(n=>/^(?:dim\.|cresc\.)$/.test(n.textContent.trim().toLowerCase()));
      if(glyphs.length!==wordTimes.length)continue;
      const entries=[];
      for(const [note,time] of noteTime){
        const p=plan.get(sourceOwners.get(note));
        if(p&&Number.isFinite(p.target))entries.push({time,target:p.target,staff:localContent(note,'staff','1')});
      }
      for(let k=0;k<glyphs.length;k++){
        const el=glyphs[k],word=wordTimes[k],r=el.getBoundingClientRect();
        const barLeft=bars[mi],barRight=bars[mi+1];
        const escaped=r.left>barRight+staffGap || r.right<barLeft-staffGap;
        if((word.explicitX&&!escaped)||!r.width||!Number.isFinite(r.left))continue;
        const candidates=entries.filter(e=>e.staff===word.staff);
        const rows=candidates.length?candidates:entries;
        const exact=rows.filter(e=>Math.abs(e.time-word.time)<1e-7);
        const a=exact.length?exact:(escaped?rows.sort((a,b)=>Math.abs(a.time-word.time)-Math.abs(b.time-word.time)).slice(0,1):[]);
        if(!a.length)continue;
        const at=Math.min(...a.map(e=>e.target));
        // These words are left-aligned to the associated beat, not centered.
        const desired=at+word.relativeX*staffGap/10-Math.min(staffGap*.35,5);
        if(desired>barLeft-staffGap*1.5&&desired<barRight-staffGap*.2&&
          Math.abs(desired-r.left)<Math.max(1600,barRight-barLeft+staffGap*30)&&addTranslation(el,desired-r.left)){
          el.dataset.universalAnchor='source-timed-word';recoveredDynamicWords++;
          dynamicWordRecords.push({measure:first+mi+1,label:word.label,staff:word.staff,time:word.time,relativeX:word.relativeX,oldScreenX:r.left,targetScreenX:desired,deltaScreenX:desired-r.left,source:'MusicXML cursor/offset and relative-x'});
        }
      }
    }

    window.PianoDynamicWordAudit={positioned:recoveredDynamicWords,records:dynamicWordRecords};
    // Scan-verified missing expression: Frosty m111, beat 3. Preserve the
    // source notes and anchor this label to the final RH half-note chord.
    if(latest.pieceSlug==='frosty-the-snowman'&&first===109){
      const note=mapped.get('p0-m110-n4');
      const staff=staffGroups(measures[1])[0],lines=staff&&staffLineBox(staff);
      if(note&&lines){
        const layer=createAnnotationLayer(svg,'pl-scan-expression');
        const label=document.createElementNS('http://www.w3.org/2000/svg','text');
        const pos=engravingPoint(svg,headRect(note).left,lines.bottom+staffGap*3.1);
        if(pos){
          label.setAttribute('x',String(pos.x));label.setAttribute('y',String(pos.y));
          label.setAttribute('font-size',String(staffGap*2.05/Math.abs(svg.getScreenCTM()?.d||1)));
          label.setAttribute('font-family','Times New Roman, serif');label.setAttribute('font-style','italic');
          label.setAttribute('fill','#111');label.textContent='cresc.';
          label.dataset.scanExpression='m111-beat3';layer.appendChild(label);
        }
      }
    }


    // Arpeggiation is attached to note/chord events in MusicXML, but one
    // Verovio g.arpeg can serve MULTIPLE chords at the same onset across the
    // grand staff. Combine those source targets by final x column before
    // assigning an SVG glyph, rather than requiring a one-glyph-per-chord
    // correspondence. Some source files arpeggiate three noteheads in a
    // single chord; that still describes only one glyph.
    const arpTargets=[];
    for(const [source,owner] of sourceOwners){
      if(!$(source,'notations > arpeggiate').length)continue;
      const entry=plan.get(owner);
      if(!entry||arpTargets.some(t=>t.owner===owner))continue;
      arpTargets.push({owner,entry,staff:entry.staff,measure:entry.measure});
    }
    const arpColumns=[];
    for(const target of arpTargets){
      const group=arpColumns.find(c=>c.measure===target.measure &&
        Math.abs(c.x-target.entry.target)<Math.max(3,staffGap*.55));
      if(group){group.targets.push(target);group.x=group.targets.reduce((sum,t)=>sum+t.entry.target,0)/group.targets.length;}
      else arpColumns.push({measure:target.measure,x:target.entry.target,targets:[target]});
    }
    const usedColumns=new Set();
    for(const glyph of originalArps){
      const measure=glyph.closest('g.measure');
      const gr=glyph.getBoundingClientRect();
      if(!Number.isFinite(gr.left)||!Number.isFinite(gr.top)||!(gr.width>0||gr.height>0)){stats.arpUnknown++;continue;}
      const gx=(gr.left+gr.right)/2, gy=(gr.top+gr.bottom)/2;
      const cols=arpColumns.filter(c=>c.measure===measure&&!usedColumns.has(c));
      if(!cols.length){stats.arpUnknown++;continue;}
      // The input SVG can be at Verovio's compact coordinates, or an older
      // already-adjusted diagnostic fixture. Rank by the ORIGINAL source
      // chord x and vertical range; never by the post-reflow target alone.
      const score=c=>{
        const originalX=c.targets.reduce((sum,t)=>sum+t.entry.oldX,0)/c.targets.length;
        const nearY=Math.min(...c.targets.map(t=>{
          const r=t.entry.originalBox;
          return gy<r.top?r.top-gy:gy>r.bottom?gy-r.bottom:0;
        }));
        return Math.abs(originalX-gx) + nearY*.8;
      };
      cols.sort((a,b)=>score(a)-score(b));
      const col=cols[0];
      const headBoxes=col.targets.flatMap(t=>t.entry.elements.map(headRect))
        .filter(r=>r.width>0&&r.height>0);
      if(!headBoxes.length){stats.arpUnknown++;continue;}
      const accidentalBoxes=col.targets.flatMap(t=>$(t.owner,'g.accid')
        .map(n=>n.getBoundingClientRect()).filter(r=>r.width>0));
      const leftHeads=Math.min(...headBoxes.map(r=>r.left));
      const left=accidentalBoxes.length?Math.min(leftHeads,...accidentalBoxes.map(r=>r.left)):leftHeads;
      const top=Math.min(...headBoxes.map(r=>r.top)), bottom=Math.max(...headBoxes.map(r=>r.bottom));
      // Do not stretch the arpeggio's wavy musical glyph. Shift its rotated
      // group in two dimensions so that it sits beside the full target pitch
      // range. The affine-aware translation above is essential here.
      if(originalChristmasSong||(latest.pieceSlug==='frosty-the-snowman'&&first===5)||
         (latest.pieceSlug==='there-s-no-place-like-home-for-the-holidays'&&first===64)||
         (latest.pieceSlug==='i-ll-be-home-for-christmas'&&first===67)||
         (latest.pieceSlug==='silver-bells'&&[0,76].includes(first))||
         (latest.pieceSlug==='the-most-wonderful-time-of-the-year'&&first===92)){
        const waves=$(glyph,'use'),wave=waves[0],next=waves[1];
        if(wave&&next){
          const a=wave.getBoundingClientRect(),b=next.getBoundingClientRect();
          const step=(b.top+b.bottom-a.top-a.bottom)/2;
          if(Math.abs(step)>.1){
            const count=Math.max(2,Math.round((bottom-top-a.height)/Math.abs(step))+1);
            const pitch=(bottom-top-a.height)/(count-1)*Math.sign(step);
            const template=wave.cloneNode(true);waves.forEach(w=>w.remove());
            for(let j=0;j<count;j++){const n=template.cloneNode(true);glyph.appendChild(n);addTranslation(n,0,j*pitch);}
            const resized=glyph.getBoundingClientRect();
            addTranslation(glyph,0,(top+bottom-resized.top-resized.bottom)/2);
            glyph.dataset.review49Span='notehead-extents';
          }
        }
      }
      const desiredRight=left-Math.max(2,staffGap*.35);
      const finalBox=glyph.getBoundingClientRect();
      const dx=desiredRight-finalBox.right;
      const dy=(top+bottom-finalBox.top-finalBox.bottom)/2;
      if(addTranslation(glyph,dx,dy)){
        usedColumns.add(col);stats.arp++;
      }else stats.arpUnknown++;
    }
    stats.arpUnknown+=Math.max(0,arpColumns.length-usedColumns.size);

    // Tuplet boundaries are authoritative in MusicXML. The old SVG wrapper
    // may contain a following note, so its bbox is NOT a tuplet bracket width.
    // Derive starts/stops by staff, voice and number, then draw the bracket
    // ONLY between the two corresponding final notehead columns. Preserve
    // number-only tuplets, and never move notes or beams a second time.
    const tupletPairs=[];
    for(let mi=0;mi<xml.length;mi++){
      const active=new Map();
      for(const source of directChildren(xml[mi],'note')){
        const staff=localContent(source,'staff','1'),voice=localContent(source,'voice','1');
        for(const mark of $(source,'notations > tuplet')){
          const key=`${staff}:${voice}:${mark.getAttribute('number')||'1'}`;
          if(mark.getAttribute('type')==='start')active.set(key,{start:source,placement:mark.getAttribute('placement')||'above'});
          else if(mark.getAttribute('type')==='stop' && active.has(key)){
            tupletPairs.push({...active.get(key),end:source,mi});active.delete(key);
          }
        }
      }
    }
    const tuples=$(svg,'g.tuplet');
    const tupleLayer=createAnnotationLayer(svg,'pl-source-tuplets');
    const assignedTuples=new Set();
    for(const pair of tupletPairs){
      const a=sourceOwners.get(pair.start),b=sourceOwners.get(pair.end);
      if(!a||!b){stats.tupletUnknown++;continue;}
      const r1=headRect(a),r2=headRect(b);
      if(!r1.width||!r2.width){stats.tupletUnknown++;continue;}
      const x1=(r1.left+r1.right)/2, x2=(r2.left+r2.right)/2;
      if(!(x2-x1>staffGap*.75)){stats.tupletUnknown++;continue;}
      let group=a.closest('g.tuplet');
      if(!group||!group.contains(b))group=tuples.find(t=>!assignedTuples.has(t)&&t.contains(a)&&t.contains(b));
      if(group)assignedTuples.add(group);
      const bracketNodes=group?$(group,'g.tupletBracket'):[];
      const numeralNodes=group?$(group,'g.tupletNum, g.num'):[];
      const externalShapes=group?Array.from(group.children).filter(n=>
        ['path','line','polyline','polygon','rect','text','use'].includes(n.localName)):[];
      // An un-beamed quarter-note tuplet has an explicit bracket; a beamed
      // triplet often has only a numeral above it. Never invent a bracket
      // for a number-only tuplet.
      const hasBracket=bracketNodes.length>0 || externalShapes.some(n=>
        !['text','use'].includes(n.localName));
      const oldNumber=(numeralNodes[0]||externalShapes.find(n=>['text','use'].includes(n.localName)))?.getBoundingClientRect();
      const oldBracket=(bracketNodes[0]||externalShapes.find(n=>!['text','use'].includes(n.localName)))?.getBoundingClientRect();
      const staff=plan.get(a)?.staff;
      const staffbox=staff?staffLineBox(staff):null;
      const above=pair.placement!=='below';
      const noteTop=Math.min(r1.top,r2.top),noteBottom=Math.max(r1.bottom,r2.bottom);
      const suggested=above?Math.min(noteTop-staffGap*2.5,(staffbox?.top??noteTop)-staffGap*1.7):
        Math.max(noteBottom+staffGap*2.5,(staffbox?.bottom??noteBottom)+staffGap*1.7);
      const initialY=oldBracket?.height>=0.5 && oldBracket.width>10 ?
        (above?oldBracket.top:oldBracket.bottom):suggested;
      if(!Number.isFinite(initialY)){stats.tupletUnknown++;continue;}
      const overhang=staffGap*.48, left=x1-overhang,right=x2+overhang;
      const hook=staffGap*.58, sign=above?1:-1;
      const center=(left+right)/2;
      // Angle the bracket with the outer notes, as in the printed edition.
      // This is a true change of the bracket's endpoint heights, NEVER a
      // scale/rotation of the numeral or of any musical glyph.
      const yDifference=((r2.top+r2.bottom)-(r1.top+r1.bottom))*.5;
      const flatTriplet=latest.pieceSlug==='rudolph-the-red-nosed-reindeer'&&first===0&&pair.mi===4&&localContent(pair.start,'voice')==='5';
      const slope=flatTriplet?0:Math.max(-staffGap*1.7,Math.min(staffGap*1.7,yDifference*.64));
      // Keep Verovio's '3' at its original vertical position. Lower/raise the
      // BRACKET instead, such that its interrupted midspan meets the *middle*
      // of the native numeral. Moving the numeral was the wrong direction.
      const nativeNumeral=numeralNodes[0]||
        (group?$(group,'g.tupletNum, g.num, g.tuplet-number')[0]:null)||
        externalShapes.find(n=>['text','use'].includes(n.localName));
      const numberBounds=nativeNumeral?.getBoundingClientRect();
      const numeralMid=numberBounds?.height>0
        ?(numberBounds.top+numberBounds.bottom)/2:null;
      const yLeft=Number.isFinite(numeralMid) ? numeralMid-slope*.5
        :initialY+(above?staffGap*.43:-staffGap*.43);
      const yRight=yLeft+slope;
      const bracketY=x=>yLeft+slope*(x-left)/Math.max(1,right-left);
      // Only replace bracket geometry. The original Verovio triplet numeral
      // has the correct glyph size and proportions; translating it is much
      // more faithful than inventing a smaller Times New Roman text glyph.
      const gapWidth=Math.min(staffGap*1.8,(right-left)*.22);
      const weight=Math.max(.85,staffGap*.085);
      let success=true;
      if(hasBracket){
        success=[
          drawAnnotationLine(svg,tupleLayer,left,yLeft,left,yLeft+sign*hook,weight),
          drawAnnotationLine(svg,tupleLayer,left,yLeft,center-gapWidth,bracketY(center-gapWidth),weight),
          drawAnnotationLine(svg,tupleLayer,center+gapWidth,bracketY(center+gapWidth),right,yRight,weight),
          drawAnnotationLine(svg,tupleLayer,right,yRight,right,yRight+sign*hook,weight)
        ].every(Boolean);
      }
      if(!success){stats.tupletUnknown++;continue;}
      let numberPlaced=false;
      if(nativeNumeral&&numberBounds&&numberBounds.width>0&&numberBounds.height>0){
        // Only center the native numeral horizontally. Keep its baseline and
        // font exactly as Verovio rendered them; bracketY was moved to meet it.
        numberPlaced=addTranslation(nativeNumeral,center-(numberBounds.left+numberBounds.right)/2,0);
      }
      // Fallback for SVG variants that truly contain no numeral element.
      // Use the measured staff space, never the bracket length, for type size.
      if(!numberPlaced){
        const numSize=Math.max(12,staffGap*1.55);
        const baseline=bracketY(center)+(above?-staffGap*.25:staffGap*1.35);
        const ct=engravingPoint(svg,center,baseline);
        if(!ct){stats.tupletUnknown++;continue;}
        const number=document.createElementNS('http://www.w3.org/2000/svg','text');
        number.setAttribute('x',String(ct.x));number.setAttribute('y',String(ct.y));
        number.setAttribute('text-anchor','middle');
        number.setAttribute('font-family','Times New Roman, serif');
        number.setAttribute('font-size',String(numSize/Math.abs(svg.getScreenCTM()?.d||1)));
        number.setAttribute('fill','#111');number.textContent='3';
        tupleLayer.appendChild(number);
      }
      if(group){
        // Hide the outdated Verovio bracket, not its original numeral or
        // the notes/beams owned by this tuplet.
        for(const deco of bracketNodes)deco.style.visibility='hidden';
        for(const deco of externalShapes){
          if(deco===nativeNumeral||nativeNumeral?.contains(deco))continue;
          if(!['text','use'].includes(deco.localName))deco.style.visibility='hidden';
        }
        for(const deco of $(group,'path, line, polygon, polyline, rect')){
          if(nativeNumeral?.contains(deco))continue;
          if(deco.closest('g.note, g.chord, g.beam, g.rest, g.artic, g.dir'))continue;
          deco.style.visibility='hidden';
        }
      }
      stats.tuplet++;
    }
    // Explicitly report those SVG tuplet groups we could not bind to
    // MusicXML start/stop events. Do not transform their unknown decorations.
    stats.tupletUnknown+=Math.max(0,tuples.length-assignedTuples.size);
    // Repeat navigation uses explicit MusicXML positions, including double bars.
    const ms=measures,screenBar=bars,firstIndex=first;
    function navigationKind(direction){
      const dt=directChildren(direction,'direction-type');
      const children=dt.flatMap(x=>Array.from(x.children));
      const words=children.filter(x=>x.localName==='words').map(x=>x.textContent||'').join(' ').toLowerCase();
      if(children.some(x=>x.localName==='segno'))return 'segno';
      if(children.some(x=>x.localName==='coda'))return 'coda';
      if(/\bd\s*\.\s*s\s*\.|dal\s+segno/i.test(words))return 'ds';
      if(/to\s+coda/i.test(words))return 'coda';
      return null;
    }
    function navigationPlan(measure,mi){
      let time=0, previousStart=0, maxTime=0;
      const notes=[], signs=[];
      for(const child of measure.children){
        const name=child.localName;
        if(name==='note'){
          const chord=directChildren(child,'chord').length>0;
          const dur=Math.max(0,Number(localContent(child,'duration','0'))||0);
          const start=chord?previousStart:time;
          const x=Number(child.getAttribute('default-x'));
          if(child.hasAttribute('default-x')&&Number.isFinite(x))notes.push({time:start,x,staff:localContent(child,'staff','1')});
          if(!chord){previousStart=start;time+=dur;maxTime=Math.max(maxTime,time);}
        }else if(name==='backup'){
          time-=Number(localContent(child,'duration','0'))||0;
        }else if(name==='forward'){
          time+=Number(localContent(child,'duration','0'))||0;
          maxTime=Math.max(maxTime,time);
        }else if(name==='direction'){
          const kind=navigationKind(child);
          if(kind){
            const offset=Number(localContent(child,'offset','0'))||0;
            signs.push({kind,mi,time:time+offset,staff:localContent(child,'staff','1'),
              explicitEnd:!!child.previousElementSibling && child.previousElementSibling.localName==='barline'});
          }
        }
      }
      const width=Number(measure.getAttribute('width'));
      if(!Number.isFinite(width)||width<=0)return [];
      return signs.map(sign=>{
        // For the start, use the first source x found at time 0 on EITHER
        // staff. The RH opening chord in measure 25 has no default-x, while
        // the LH notes at that same instant supply a genuine x=24 anchor.
        const ending=sign.explicitEnd || (maxTime>0 && sign.time>=maxTime-1e-7);
        let x=24;
        if(ending)x=width;
        else if(sign.time<=1e-7 && (sign.kind==='segno'||sign.kind==='coda')){
          // Editorial repeat-navigation symbols are positioned at the MEASURE
          // BOUNDARY, not the first note column. The original scan places the
          // Segno over m24/m25's double barline, to the left of the chord.
          x=0;
        }else {
          const atTime=notes.filter(n=>Math.abs(n.time-sign.time)<1e-6);
          if(atTime.length)x=Math.min(...atTime.map(n=>n.x));
          else {
            const times=[...new Set(notes.map(n=>n.time))].sort((a,b)=>a-b);
            const earlier=times.filter(t=>t<=sign.time);
            const prev=earlier.length?earlier[earlier.length-1]:undefined;
            const next=times.find(t=>t>=sign.time);
            const xAt=t=>Math.min(...notes.filter(n=>n.time===t).map(n=>n.x));
            if(prev!==undefined && next!==undefined && prev!==next){
              const f=(sign.time-prev)/(next-prev);
              x=xAt(prev)*(1-f)+xAt(next)*f;
            }else if(prev!==undefined)x=xAt(prev);
            else if(next!==undefined)x=xAt(next);
          }
        }
        return {...sign,ending,width,x};
      });
    }
    function navigationOwner(el){return el.closest('g.dir')||el;}
    function svgNavKind(node){
      if(node.classList.contains('segno')||node.querySelector('g.segno'))return 'segno';
      if(node.classList.contains('coda')||node.querySelector('g.coda'))return 'coda';
      // Verovio 6.3.0 emits repeat navigation symbols as bare g.repeatMark
      // groups containing an SVG <use> to its SMuFL glyph definition.
      // The user's actual system-07 SVG uses #E047-... for Segno, not g.segno.
      // E048 is Coda. Other repeatMark glyphs must NOT be repositioned.
      if(node.classList.contains('repeatMark')||node.querySelector('g.repeatMark')){
        for(const use of $(node,'use')){
          const href=use.getAttribute('href')||use.getAttributeNS('http://www.w3.org/1999/xlink','href')||'';
          if(/#E047(?:-|$)/i.test(href))return 'segno';
          if(/#E048(?:-|$)/i.test(href))return 'coda';
        }
      }
      const label=(node.textContent||'').toLowerCase().replace(/\s+/g,' ');
      if(/\bd\s*\.\s*s\s*\.|dal\s+segno/.test(label))return 'ds';
      if(/to\s+coda/.test(label))return 'coda';
      return null;
    }
    const navPlans=xml.flatMap((m,i)=>navigationPlan(m,i));
    const navCandidates=[...new Set($(svg,'g.segno, g.coda, g.dir, g.repeatMark').map(navigationOwner))]
      .filter(n=>n.closest('g.measure'));
    const navUsed=new Set();
    let navFixed=0;
    const navFailures=[];
    for(const plan of navPlans){
      const kindMatches=navCandidates.filter(n=>!navUsed.has(n)&&svgNavKind(n)===plan.kind);
      const inMeasure=kindMatches.filter(n=>n.closest('g.measure')===ms[plan.mi]);
      let choices=inMeasure;
      // Verovio can attach a sign to the adjacent measure at a double
      // barline. A uniquely typed sign anywhere in this system is safe.
      if(!choices.length && kindMatches.length===1)choices=kindMatches;
      // Older Verovio revisions can expose the symbol as an unclassified
      // g.dir. Use it only if there is exactly one such group in the measure.
      if(!choices.length){
        const unknown=navCandidates.filter(n=>!navUsed.has(n)&&!svgNavKind(n)&&
          n.closest('g.measure')===ms[plan.mi]);
        if(unknown.length===1)choices=unknown;
      }
      if(choices.length!==1){navFailures.push(`${plan.kind} m${firstIndex+plan.mi+1}: ${choices.length} candidates`);continue;}
      const owner=choices[0];
      const r=owner.getBoundingClientRect();
      const target=screenBar[plan.mi]+plan.x/plan.width*(screenBar[plan.mi+1]-screenBar[plan.mi]);
      // End instructions must fit to the left of the measure's right barline.
      // Start instructions center on the corresponding source music column.
      const aligned=plan.ending?target-r.width/2-Math.max(3,r.width*.1):target;
      const dx=aligned-(r.left+r.right)/2;
      if(Number.isFinite(dx)&&addTranslation(owner,dx)){
        navUsed.add(owner);navFixed++;
      }else navFailures.push(`${plan.kind} m${firstIndex+plan.mi+1}: SVG transform unavailable`);
    }
    // V50: To Coda is printed as [words][symbol] in this Christmas book,
    // not Verovio's default [symbol][words]. Reorder ONLY the two inline SVG
    // spans of a combined direction; preserve the rhythmic/navigation anchor.
    const rightHandCoda=(latest?.pieceSlug==='the-christmas-song' && first===35)||
      (latest?.pieceSlug==='let-it-snow-let-it-snow-let-it-snow' && first===37)||
      (latest?.pieceSlug==='rudolph-the-red-nosed-reindeer' && first===85);
    if(rightHandCoda){
      for(const mark of $(svg,'g.dir.tocoda')){
        const txt=mark.querySelector('text');
        if(!txt)continue;
        const spans=[...txt.children];
        const sign=spans.find(n=>n.classList.contains('symbol'));
        const words=spans.find(n=>n.classList.contains('rend'));
        if(sign&&words&&spans.indexOf(sign)<spans.indexOf(words)){
          txt.appendChild(sign); // actual SMuFL coda now follows "To Coda"
        }
      }
    }
    // Frosty s13 (m60–64): the printed "To Coda" text sits LEFT of the
    // coda glyph, whose optical center is exactly over the m63/m64 barline.
    // The generic navigation pass centers the entire direction group; only
    // this mark needs a second, glyph-specific alignment. This never moves
    // notes, ties, measure rules, or any other directions.
    if(latest?.pieceSlug==='frosty-the-snowman' && first===59){
      const codaMeasure=measures[4];  // measure 64 starts at screenBar[4]
      const mark=$(svg,'g.dir').find(n=>n.closest('g.measure')===codaMeasure &&
        /to\s+coda/i.test(n.textContent||''));
      const glyph=mark?.querySelector('text .symbol');
      const target=screenBar[4];
      const r=glyph?.getBoundingClientRect();
      if(r?.width>1 && Number.isFinite(target)){
        const dx=target-(r.left+r.right)/2;
        if(Math.abs(dx)<Math.max(120,staffGap*12) && addTranslation(mark,dx))
          svg.dataset.frostyCodaBarline='m63-m64';
      }
    }
    // At the Coda, the generated first-measure label (57) can overlap the
    // opening SMuFL Coda sign / CODA heading. This isn't a musical position:
    // reserve a separate horizontal slot for the measure number to the right
    // of the navigation heading. Never hide or renumber it.
    let codaNumberShifted=0;
    if(originalChristmasSong && first===56 && navPlans.some(p=>p.kind==='coda' && p.mi===0)){
      const num=measures[0]?.querySelector('g.mNum');
      if(num){
        const m=num.getBoundingClientRect();
        const heading=[...new Set([
          ...navCandidates.filter(n=>svgNavKind(n)==='coda' && n.closest('g.measure')===measures[0]),
          ...$(measures[0],'g.dir, g.tempo, g.reh').filter(n=>/\bcoda\b/i.test(n.textContent||''))
        ])].map(n=>n.getBoundingClientRect()).filter(r=>r.width>1&&r.height>1);
        if(m.width>1 && heading.length){
          const headingRight=Math.max(...heading.map(r=>r.right));
          const desiredLeft=headingRight+Math.max(7,staffGap*.75);
          const dx=desiredLeft-m.left;
          // Avoid an implausible move if a Verovio variant positions the
          // repeat sign at a very different part of the system.
          if(dx>0 && dx<staffGap*12 && addTranslation(num,dx))codaNumberShifted++;
        }
      }
    }
    context.lastNavigationReport=`navigation ${navFixed}/${navPlans.length} anchored`+
      (codaNumberShifted?' · coda measure number cleared':'')+
      (navFailures.length?` · ${navFailures.join('; ')}`:'');
    // The 8vb in the final system is a *visual* span across two measures.
    // The glyph-only MusicXML has sounding notes placed into their printed
    // register and omits Verovio's automatic octave-shift group, so draw its
    // dashed line only after both endpoint notes have their final locations.
    // Do not attach the span to the opening measure/fermata bounding boxes.
    let octaveSpansDrawn=0;
    const activeOctaves=new Map(),finishedOctaves=[];
    for(const measure of xml){
      for(const child of measure.children){
        if(child.localName==='direction'){
          for(const shift of $(child,'direction-type > octave-shift')){
            if(shift.getAttribute('size')!=='8')continue;
            const staff=localContent(child,'staff','1');
            if(shift.getAttribute('type')==='stop'){
              const span=activeOctaves.get(staff);
              if(span?.first&&span.last)finishedOctaves.push(span);
              activeOctaves.delete(staff);
            }else if(['up','down'].includes(shift.getAttribute('type'))){
              activeOctaves.set(staff,{staff,kind:shift.getAttribute('type'),first:null,last:null,notes:[]});
            }
          }
        }else if(child.localName==='note'){
          const span=activeOctaves.get(localContent(child,'staff','1'));
          if(span && child.querySelector('pitch')){
            if(!span.first)span.first=child;
            span.last=child;
            span.notes.push(child);
          }
        }
      }
    }
    for(const span of finishedOctaves){
      const a=sourceOwners.get(span.first),b=sourceOwners.get(span.last);
      const staff=plan.get(a)?.staff;
      if(!a||!b||!staff)continue;
      const ar=headRect(a),br=headRect(b),staffLines=staffLineBox(staff);
      if(!staffLines)continue;
      const x1=(ar.left+ar.right)/2,x2=(br.left+br.right)/2;
      // Frosty's final 8vb applies to a SINGLE written note. The regular
      // bracket renderer intentionally requires two distinct horizontal
      // endpoints, so it cannot display the label for this one-note shift.
      // Place the label below its mapped note instead, without manufacturing
      // an octave bracket or changing the source MusicXML.
      if(span.notes.length===1 && span.kind==='up' &&
         ((latest.pieceSlug==='frosty-the-snowman' && Number(latest.first)===109) ||
          (latest.pieceSlug==='white-christmas' && Number(latest.first)===87 && span.staff==='2'))){
        // White Christmas s23: the earlier pilot placed this 8vb correctly,
        // but printed it at the smaller pre-alignment text size (1.5 staff
        // spaces). Match the resized octave-label size used above (1.95),
        // without changing noteheads or the RH 8va.
        const whiteFinal=(latest.pieceSlug==='white-christmas' && Number(latest.first)===87 && span.staff==='2');
        const labelLayer=createAnnotationLayer(svg,'pl-single-note-8vb');
        const label=document.createElementNS('http://www.w3.org/2000/svg','text');
        const y=Math.max(br.bottom+staffGap*1.1,staffLines.bottom+staffGap*1.55)+
          (whiteFinal?staffGap*.9:0);
        const pos=engravingPoint(svg,x1,y);
        if(pos){
          label.setAttribute('x',String(pos.x));label.setAttribute('y',String(pos.y));
          label.setAttribute('text-anchor','middle');
          label.setAttribute('font-size',String(staffGap*1.95/Math.abs(svg.getScreenCTM()?.d||1)));
          label.setAttribute('font-family','Times New Roman, serif');
          label.setAttribute('font-style','italic');label.setAttribute('fill','#111');
          label.textContent='8vb';labelLayer.appendChild(label);
          if(whiteFinal){
            // Font ascenders become taller after resizing. Keep real screen-
            // space clearance below the last LH note and bass staff lines.
            const bounds=label.getBoundingClientRect();
            const minimumTop=Math.max(br.bottom+staffGap*.4,staffLines.bottom+staffGap*.55);
            if(bounds.top<minimumTop){
              const adjusted=engravingPoint(svg,x1,y+minimumTop-bounds.top);
              if(adjusted)label.setAttribute('y',String(adjusted.y));
            }
          }
          octaveSpansDrawn++;
        }else labelLayer.remove();
        continue;
      }
      // A source octave span on one onset has no horizontal note-to-note
      // length. Attach its label and short bracket to the final chord center,
      // rather than discarding it or leaving a label at an obsolete x.
      if(span.kind==='down' && span.notes.length>=1 &&
         Math.abs(x2-x1)<staffGap*.5){
        const affected=span.notes.map(note=>sourceOwners.get(note)).filter(Boolean);
        if(affected.length===span.notes.length){
          const top=Math.min(...affected.map(note=>headRect(note).top));
          let lineY=Math.min(staffLines.top-staffGap*3.2,top-staffGap*2.5);
          const layer=createAnnotationLayer(svg,'pl-single-onset-octave');
          const label=document.createElementNS('http://www.w3.org/2000/svg','text');
          const labelX=x1-staffGap*.15;
          let point=engravingPoint(svg,labelX,lineY+staffGap*.45);
          if(point){
            label.setAttribute('x',String(point.x));label.setAttribute('y',String(point.y));
            label.setAttribute('font-size',String(staffGap*1.95/Math.abs(svg.getScreenCTM()?.d||1)));
            label.setAttribute('font-family','Times New Roman, serif');
            label.setAttribute('font-style','italic');label.setAttribute('fill','#111');
            label.textContent='8va';layer.appendChild(label);
            const labelBox=label.getBoundingClientRect();
            if(labelBox.bottom>top-staffGap*.45){
              lineY-=labelBox.bottom-(top-staffGap*.45);
              point=engravingPoint(svg,labelX,lineY+staffGap*.45);
              if(point)label.setAttribute('y',String(point.y));
            }
            const start=Math.max(x1-staffGap*.1,label.getBoundingClientRect().right+staffGap*.2);
            const end=x1+staffGap*4.0;
            if(end>start+staffGap*.25){
              drawAnnotationLine(svg,layer,start,lineY,end,lineY,1.05);
              drawAnnotationLine(svg,layer,end,lineY,end,lineY+staffGap*.42,1.05);
            }
            octaveSpansDrawn++;
          } else layer.remove();
        }
        continue;
      }
      if(!(x2-x1>staffGap*1.5))continue;
      const below=span.kind==='up';
      // Octave markings must clear the actual affected noteheads, not merely
      // the staff's fifth line. E2 and similar notes can extend below the
      // bass staff; a staff-relative 8vb baseline intersects their glyphs.
      // Include every tone of a shared chord when measuring the clearance.
      const affectedHeads=[];
      for(const sourceNote of span.notes){
        const owner=sourceOwners.get(sourceNote);
        if(!owner)continue;
        const heads=$(owner,'g.notehead');
        for(const el of heads.length?heads:[owner]){
          const rect=el.getBoundingClientRect();
          if(Number.isFinite(rect.top)&&Number.isFinite(rect.bottom)&&rect.height>0)
            affectedHeads.push(rect);
        }
      }
      const lowest=Math.max(staffLines.bottom,...affectedHeads.map(r=>r.bottom));
      const highest=Math.min(staffLines.top,...affectedHeads.map(r=>r.top));
      let y=below
        ?Math.max(staffLines.bottom+staffGap*1.23,lowest+staffGap*1.20)
        :Math.min(staffLines.top-staffGap*1.25,highest-staffGap*1.20);
      const start=x1+staffGap*.32,end=x2+staffGap*.6;
      const layer=createAnnotationLayer(svg,'pl-octave-spans');
      const labelX=x1-staffGap*1.28;
      const labelY=()=>y+(below?staffGap*.19:-staffGap*.2);
      const txt=document.createElementNS('http://www.w3.org/2000/svg','text');
      let labelPos=engravingPoint(svg,labelX,labelY());
      if(!labelPos){layer.remove();continue;}
      txt.setAttribute('x',String(labelPos.x));txt.setAttribute('y',String(labelPos.y));
      txt.setAttribute('font-size',String(staffGap*1.95/Math.abs(svg.getScreenCTM()?.d||1)));
      txt.setAttribute('font-family','Times New Roman, serif');txt.setAttribute('font-style','italic');
      txt.setAttribute('fill','#111');txt.textContent=below?'8vb':'8va';layer.appendChild(txt);
      // Use the rendered font's real bounding box too: font ascenders vary
      // across macOS and Chromium, so a fixed font-size estimate is unsafe.
      const labelBounds=txt.getBoundingClientRect();
      const clearance=staffGap*.48;
      if(below && labelBounds.top<lowest+clearance)
        y+=lowest+clearance-labelBounds.top;
      else if(!below && labelBounds.bottom>highest-clearance)
        y-=labelBounds.bottom-(highest-clearance);
      labelPos=engravingPoint(svg,labelX,labelY());
      if(!labelPos){layer.remove();continue;}
      txt.setAttribute('y',String(labelPos.y));
      const lineStart=Math.max(start,txt.getBoundingClientRect().right+staffGap*.45);
      const p=engravingPoint(svg,lineStart,y),q=engravingPoint(svg,end,y);
      if(!p||!q){layer.remove();continue;}
      const line=document.createElementNS('http://www.w3.org/2000/svg','line');
      line.setAttribute('x1',String(p.x));line.setAttribute('y1',String(p.y));
      line.setAttribute('x2',String(q.x));line.setAttribute('y2',String(q.y));
      line.setAttribute('stroke','#111');line.setAttribute('stroke-width','1.05');
      line.setAttribute('vector-effect','non-scaling-stroke');
      line.setAttribute('stroke-dasharray','5 4');layer.appendChild(line);
      drawAnnotationLine(svg,layer,end,y,end,y+(below?-staffGap*.42:staffGap*.42),1.05);
      octaveSpansDrawn++;
    }
    // Native octave groups use the glyph supplier's original measure width.
    // Retire that old plane only after EVERY source octave declaration has a
    // fully rebuilt, locally bounded equivalent. Partial or unsupported spans
    // remain visible and audited; noteheads and their coordinates stay intact.
    const octaveMarks=xml.flatMap(measure=>$(measure,'direction-type > octave-shift'));
    const octaveCoverageComplete=finishedOctaves.length>0&&activeOctaves.size===0&&
      octaveSpansDrawn===finishedOctaves.length&&octaveMarks.length===finishedOctaves.length*2&&
      octaveMarks.every(mark=>mark.getAttribute('size')==='8'&&['up','down','stop'].includes(mark.getAttribute('type')));
    let nativeOctavesRetired=0;
    if(octaveCoverageComplete){
      for(const old of $(svg,'g.octave,g.octaveShift,g.ottava').filter(node=>
        !node.parentElement?.closest('g.octave,g.octaveShift,g.ottava'))){
        old.style.visibility='hidden';nativeOctavesRetired++;
      }
    }
    window.PianoOctaveAudit={sourceDeclarations:octaveMarks.length,sourceSpans:finishedOctaves.length,
      rebuiltSpans:octaveSpansDrawn,complete:octaveCoverageComplete,nativeRetired:nativeOctavesRetired};
    svg.dataset.nativeOctavesRetired=String(nativeOctavesRetired);

    const spanCounts=['slur','wedge','hairpin','octave','octaveShift','ottava','pedal','gliss','glissando']
      .map(name=>({name,count:$(svg,'g.'+name).length})).filter(a=>a.count>0);
    // Never confuse successful SVG mapping with confirmed layout. A musical
    // event lacking a final coordinate, or using provisional timing-only
    // spacing, is not yet visually verified against the scan.
    const uncertainMeasures=new Set(prov.map(n=>n-1));
    context.uncertainLayoutIDs=[...mapped].filter(([id,node])=>{
      const m=/^p0-m(\d+)-n\d+$/.exec(id);
      return (m&&uncertainMeasures.has(Number(m[1]))) ||
        explicitlyInferredEventIDs.has(id) ||
        !(noteShifts.has(node)||noteShifts.has(node.closest('g.chord')));
    }).map(([id])=>id);
    svg.dataset.sourceTupletRhythmCorrections=JSON.stringify(sourceTupletRhythmCorrections);
    svg.dataset.sourceTupletRhythmCorrectionGroups=String(sourceTupletRhythmCorrections.length);
    context.lastAttachmentReport=`layout plan: ${placed} events, ${clearances} opening clearances, `+
      `${stats.beam} beam segments + ${stats.hook} hooks, `+
      `${stats.arp} arpeggios, ${stats.tuplet} tuplet decorations, ${correctedTupletColumns} corrected source tuplet columns, `+
      `${sourceTupletRhythmCorrections.length} rhythmic tuplet groups, `+
      `${stats.single} other symbols, ${timedDynamics} timed dynamics, ${recoveredDynamicWords} rescued dynamic words, ${recovered} inferred note positions, ${recoveredGraceOffsets} grace offsets inferred (review pending) · `+
      `${accidentalColumnsImproved} accidental stacks refined, ${measuredCollisionRepairs} extra onset gaps, ${octaveSpansDrawn} octave spans · ${context.lastOpeningReport}`+
      (prov.length?` · provisional m${prov.join(',')}`:'')+
      (stats.beamUnknown||stats.arpUnknown||stats.tupletUnknown||stats.singleUnknown?
        ` · unplaced: beam ${stats.beamUnknown}, arpeggio ${stats.arpUnknown}, tuplet ${stats.tupletUnknown}, other ${stats.singleUnknown}`:'')+
      (spanCounts.length?` · deferred spans ${spanCounts.map(a=>a.name+':'+a.count).join(', ')}`:'')+
      ` · ${context.uncertainLayoutIDs.length} positions awaiting scan verification · ${context.lastNavigationReport}`;
    context.layoutCount=placed;
    return placed;
  }

  return positionFromOriginalMusicXML;
}};
