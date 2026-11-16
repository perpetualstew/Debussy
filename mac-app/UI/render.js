'use strict';
/* Piano Library 07: source-engraving coordinates determine measure and note layout; Verovio supplies glyphs.
   Swift's exact ScoreCore event ID remains authoritative for navigation.
   The UI associates MusicXML notes to the corresponding Verovio SVG elements
   per measure, staff and voice; it never infers notes merely by their x position. */
(function () {
  const status = document.getElementById('status');
  const notation = document.getElementById('notation');
  const image = document.getElementById('scan');
  const guides = document.getElementById('guide-layer');
  const staffRules = document.getElementById('staff-rules');
  let toolkit = null, latest = null, selectedID = null;
  let systemGeneration = 0, waitingForScan = false, lastRenderedGeneration = -1;
  let pendingRender = false, tries = 0, mapped = new Map(), sourceEventCount = 0;
  let lastAlignment = 'not measured', layoutCount = 0, lastLedgerReport = 'ledgers not drawn';
  let staffSizeFactor = 1, lastScaleReport = 'staff not measured';
  const pieceStaffSizes = new Map();
  let mappingProblems=[];
  let lastInputRepairCount=0, lastSupplyShort=[];
  let mappedChordGroups=0, mappedChordTones=0;
  let lastTieReport='no ties';
  let lastAttachmentReport='annotations not audited';
  let lastNavigationReport='navigation not checked';
  let lastOpeningReport='opening system symbols not calibrated';
  let uncertainLayoutIDs=[];
  // Native SVG notehead rectangles captured before scan-coordinate translations.
  // Used solely for assigning the original grace slur to its exact source pair.
  let preAlignmentHeadBoxes=new Map();
  const $ = (root, query) => Array.from(root.querySelectorAll(query));
  const report = (type, message) => {
    status.textContent = message;
    try { (window.PianoHostPost||((m)=>window.webkit?.messageHandlers?.piano?.postMessage(m)))({type,message,pieceSlug:latest?.pieceSlug,systemFirst:Number(latest?.first)}); } catch (_) {}
  };
  const directChildren = (node, tag) => node?.children ? Array.from(node.children).filter(e => e.localName === tag) : [];
  const localContent = (parent, tag, def='') => directChildren(parent,tag)[0]?.textContent?.trim() ?? def;
  const classHas = (el, cls) => el.classList?.contains(cls);
  // Explicit dependency boundary for independent engraving stages. Mutable
  // data is read at invocation, so resizing and changing systems cannot retain
  // an earlier system's note map, scan dimensions or report state.
  const engravingContext={
    get latest(){return latest;},
    get mapped(){return mapped;},
    get image(){return image;},
    get notation(){return notation;},get staffRules(){return staffRules;},
    get lastLedgerReport(){return lastLedgerReport;},set lastLedgerReport(value){lastLedgerReport=value;},
    get staffSizeFactor(){return staffSizeFactor;},
    get preAlignmentHeadBoxes(){return preAlignmentHeadBoxes;},
    get lastOpeningReport(){return lastOpeningReport;},set lastOpeningReport(value){lastOpeningReport=value;},
    get lastNavigationReport(){return lastNavigationReport;},set lastNavigationReport(value){lastNavigationReport=value;},
    get uncertainLayoutIDs(){return uncertainLayoutIDs;},set uncertainLayoutIDs(value){uncertainLayoutIDs=value;},
    get lastAttachmentReport(){return lastAttachmentReport;},set lastAttachmentReport(value){lastAttachmentReport=value;},
    get layoutCount(){return layoutCount;},set layoutCount(value){layoutCount=value;},
    get lastTieReport(){return lastTieReport;},set lastTieReport(value){lastTieReport=value;},
    $, addTranslation, createAnnotationLayer, directChildren, drawAnnotationLine, engravingPoint, headRect, headX, localContent, measureEventSourceX, noCoordinateMeasurePositions, reflowSourceInternalSignatures, registerOpeningSystem, staffGroups, get staffLineBox(){return staffLineBox;}, xmlMeasures
  };


  // Read-only evidence for the offline visual evaluator. Source event identity
  // is exposed with final head rectangles; consumers never infer identity from x.
  window.PianoEngravingSnapshot=function(){
    const rect=r=>({left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height});
    return {pieceSlug:latest?.pieceSlug,first:latest?.first,last:latest?.last,
      scan:rect(image.getBoundingClientRect()),staffSizeFactor,
      geometry:Object.fromEntries(['barlines','scanUpperStaffTopPx','scanLowerStaffTopPx','scanWidthPx','scanHeightPx','scanStaffSpacePx'].map(key=>[key,latest?.[key]])),
      staffSpacePx:Number(latest?.scanStaffSpacePx)*image.getBoundingClientRect().width/(image.naturalWidth||1)*staffSizeFactor,
      events:[...mapped].map(([event,node])=>({event,svgID:node.id,head:rect(headRect(node))})),
      ties:window.PianoTieAudit||null,boundaries:window.PianoBoundaryTieAudit||null,
      status:status.textContent,generation:systemGeneration,renderedGeneration:lastRenderedGeneration};
  };

  window.showSelection = function (id) {
    selectedID = typeof id === 'string' ? id : null;
    highlight();
    window.PianoBeatAtlas?.onSelection?.(selectedID);
  };
  window.showSystem = function (data) {
    if (!data || typeof data.xml !== 'string' || !/^pieces\/[a-z0-9-]+\/systems\/s\d+(?:-complete)?\.jpg$/.test(data.scan)) {
      report('error','Invalid system payload'); return;
    }
    if(data.sourceEngravingOverrides||data.sourceWordCorrections)data={...data,xml:window.PianoMusicXMLInput.applyScanEngraving(data.xml,data.first,data.sourceEngravingOverrides,data.sourceWordCorrections)};
    if(latest?.pieceSlug !== data.pieceSlug) {
      // System-specific scan geometry never shares a zoom calibration with
      // another piece. Preserve deliberate zoom edits only for that piece.
      if(latest?.pieceSlug)pieceStaffSizes.set(latest.pieceSlug,staffSizeFactor);
      staffSizeFactor=pieceStaffSizes.get(data.pieceSlug)??1;
      const slider=document.getElementById('staff-size');
      if(slider)slider.value=String(Math.round(staffSizeFactor*100));
      const output=document.getElementById('staff-size-value');
      if(output)output.textContent=`${Math.round(staffSizeFactor*100)}%`;
    }
    // Frosty pilot: all 23 systems have measured scan geometry. Use the
    // verified v52 source-coordinate renderer, including the final system,
    // whose one-note octave displacement is now normalized only in transient
    // engraving input. Original score, excerpts, and scans remain immutable.
    // Separate arrangement pilot: the same approved source-coordinate method
    // as Frosty, enabled only where the original scan calibration was accepted.
    // Collection-wide experiment: apply the already validated v52 alignment
    // only when this system's original scan has accepted calibration. Any
    // missing/unaccepted system remains in the original draft renderer.
    // Source MusicXML, excerpts, scans and notation glyphs are immutable.
    const pilot = data.reviewMode === 'draft' &&
      !window.PianoBulkExcludedSystems?.[data.pieceSlug]?.includes(Number(data.first));
    const calibration = pilot ? window.PianoScanCalibration?.[data.pieceSlug]?.[Number(data.first)] : null;
    const goodCalibration = !!(calibration?.accepted &&
      Array.isArray(calibration.barlines_px) &&
      calibration.barlines_px.length === (Number(data.last)-Number(data.first)+2) &&
      calibration.staff_lines_center_x?.length === 2 &&
      Number(calibration.staff_space_px) > 0 && Number(calibration.width) > 0);
    latest = goodCalibration ? {
      ...data,
      reviewMode:'aligned',
      alignmentPilot:true,
      barlines:calibration.barlines_px.map(x=>x/calibration.width),
      scanStaffSpacePx:calibration.staff_space_px,
      scanStaffTopGapPx:calibration.staff_lines_center_x[1][0]-calibration.staff_lines_center_x[0][0],
      scanUpperStaffTopPx:calibration.staff_lines_center_x[0][0],
      scanLowerStaffTopPx:calibration.staff_lines_center_x[1][0],
      scanWidthPx:calibration.width,
      scanHeightPx:calibration.height
    } : data;
    const draft = data.reviewMode === 'draft';
    document.body.classList.toggle('draft-review',draft);
    const atlasToggle=document.getElementById('atlas-toggle');
    if(atlasToggle)atlasToggle.hidden=draft;
    if(draft){
      document.body.classList.remove('atlas-open');
      document.getElementById('atlas-panel')?.setAttribute('aria-hidden','true');
    }
    // Each new system starts at the top; users can scroll down to inspect
    // the full lower staff, including anything below the final ledger line.
    const scroll = document.getElementById('score-scroll');
    if(scroll)scroll.scrollTop=0;
    selectedID = data.selected || null;
    document.body.classList.toggle('system-locked',!!data.lockedSnapshot||!!data.lockedSnapshotError);
    const zoomControl=document.getElementById('staff-size');
    if(zoomControl)zoomControl.disabled=!!data.lockedSnapshot||!!data.lockedSnapshotError;
    if(data.lockedSnapshot){
      staffSizeFactor=Number(data.lockedSnapshot.staffSizePercent)/100;
      if(zoomControl)zoomControl.value=String(Math.round(staffSizeFactor*100));
      const zoomOutput=document.getElementById('staff-size-value');
      if(zoomOutput)zoomOutput.textContent=`${Math.round(staffSizeFactor*100)}%`;
    }
    if(!draft) window.PianoBeatAtlas?.onSystem?.(data);
    window.PianoReviewPen?.onSystem?.(data);
    window.PianoPositionEditor?.onSystem?.(data);
    // Load the requested scan first. A previous system's still-cached image
    // must never be used to calculate the next system's musical positions.
    // Install onload BEFORE src (WKWebView may deliver a cached load promptly).
    const generation=++systemGeneration;
    lastRenderedGeneration=-1;
    waitingForScan=true;
    mapped.clear();
    preAlignmentHeadBoxes.clear();
    notation.textContent='';
    notation.removeAttribute('style');
    staffRules.removeAttribute('style');
    staffRules.replaceChildren();
    staffRules.removeAttribute('viewBox');
    image.onload=()=>{
      if(generation!==systemGeneration)return;
      waitingForScan=false;
      scheduleRender();
    };
    image.onerror=()=>{
      if(generation!==systemGeneration)return;
      report('error','Could not load this system scan');
    };
    image.src='../'+data.scan;
    if(!toolkit && !data.lockedSnapshot && !data.lockedSnapshotError) boot();

  };

  function makeSourceGroups(xml, first) {
    const documentXML = new DOMParser().parseFromString(xml,'application/xml');
    if (documentXML.querySelector('parsererror')) throw new Error('System MusicXML did not parse');
    const part = documentXML.querySelector('score-partwise > part');
    if (!part) throw new Error('MusicXML part missing');
    const measures = directChildren(part,'measure');
    return measures.map((measure, mi) => {
      const groups = new Map();
      let order = 0;
      for (const child of measure.children) {
        if (child.localName !== 'note') continue;
        const staff = parseInt(localContent(child,'staff','1'),10) || 1;
        const voice = localContent(child,'voice','1');
        const key = `${staff}:${voice}`;
        if (!groups.has(key)) groups.set(key,[]);
        groups.get(key).push({
          id:`p0-m${first+mi}-n${order}`,
          order,
          sourceX: Number(child.getAttribute('default-x')),
          rest:!!directChildren(child,'rest').length,
          chord:!!directChildren(child,'chord').length,
          pitch: (() => {const p=directChildren(child,'pitch')[0];
            return p ? localContent(p,'step').toLowerCase()+localContent(p,'octave') : 'rest';})()
        });
        order++;
      }
      return groups;
    });
  }
  function svgEvents(node) {
    return $(node,'g.note, g.rest, g.mRest');
  }
  // A MusicXML <chord/> entry belongs to the preceding rhythmic event. A
  // Verovio chord is not always a flat sequence of g.note nodes: depending on
  // version and source its SVG may have the noteheads directly in g.chord.
  // Compare rhythmic units first, and only then associate their component notes.
  function xmlUnits(items) {
    const units=[];
    for(const item of items){
      if(item.chord && units.length && !units[units.length-1][0].rest)
        units[units.length-1].push(item);
      else units.push([item]);
    }
    return units;
  }
  function svgUnits(layer) {
    return $(layer,'g.chord, g.note, g.rest, g.mRest').filter(el=>{
      if(el.closest('g.layer')!==layer)return false;
      // Descendants of a chord are *components*, not additional beats.
      return el.classList.contains('chord') || !el.closest('g.chord');
    }).map(node=>({node,
      children:node.classList.contains('chord')?$(node,'g.note'): [node]
    }));
  }
  function chordHeadCount(node) {
    // A .note glyph usually has its own g.notehead or direct <use>.
    // Ignore symbols such as accidentals, dots and stems when counting heads.
    const notes=$(node,'g.note');
    if(notes.length)return notes.length;
    const explicit=$(node,'g.notehead');
    if(explicit.length) return explicit.reduce((count,group)=>
      count+Math.max(1,$(group,'use').length),0);
    return $(node,'use').filter(n=>!n.closest(
      'g.accid, g.dots, g.stem, g.flag, g.artic, g.fermata, g.ledgerLines, g.tie')).length;
  }
  function isRestGlyph(node) {
    return node.classList.contains('rest')||node.classList.contains('mRest');
  }
  function pitchOf(node) {
    const p=node.getAttribute('data-pname'),o=node.getAttribute('data-oct');
    return p&&o ? p.toLowerCase()+o : null;
  }
  function candidateFits(src, targets) {
    if(src.length!==targets.length)return false;
    return src.every((item,i)=>{
      if(isRestGlyph(targets[i])!==item.rest)return false;
      const pitch=pitchOf(targets[i]);
      return !pitch || pitch===item.pitch;
    });
  }
  function unitFits(src,unit) {
    const target=unit.node, isChord=target.classList.contains('chord');
    if(src.length>1){
      if(!isChord)return false;
      if(chordHeadCount(target)!==src.length)return false;
      const pitches=unit.children.map(pitchOf);
      // Verovio may sort chord tones vertically; compare pitch multisets.
      if(pitches.length===src.length && pitches.every(Boolean))
        return [...pitches].sort().join('/')===[...src.map(x=>x.pitch)].sort().join('/');
      return true; // The chord container is structurally verified.
    }
    if(isChord)return false;
    if(src[0].rest!==isRestGlyph(target))return false;
    const p=pitchOf(target);
    return !p||p===src[0].pitch;
  }
  function attachUnits(srcItems, targets, used) {
    const units=xmlUnits(srcItems);
    if(units.length!==targets.length || targets.some(t=>used.has(t.node)))return false;
    if(!units.every((src,i)=>unitFits(src,targets[i])))return false;
    for(let i=0;i<units.length;i++) {
      const source=units[i],target=targets[i],node=target.node;
      used.add(node);
      if(source.length>1){
        mappedChordGroups++;mappedChordTones+=source.length;
        // Prefer individual note elements if their pitch data identifies them.
        // Otherwise use the shared chord owner. Both source notes still move
        // together, and selection targets the whole chord rather than the
        // wrong notehead.
        const children=target.children,claimed=new Set();
        for(const item of source){
          const possible=children.filter(el=>!claimed.has(el) && pitchOf(el)===item.pitch);
          if(possible.length===1){mapped.set(item.id,possible[0]);claimed.add(possible[0]);}
          else mapped.set(item.id,node);
        }
      }else mapped.set(source[0].id,node);
    }
    return true;
  }
  function attachPairwise(src,targets,used) {
    if(!candidateFits(src,targets)||targets.some(x=>used.has(x)))return false;
    for(let i=0;i<src.length;i++){mapped.set(src[i].id,targets[i]);used.add(targets[i]);}
    return true;
  }
  function staffGroups(measure) {
    return $(measure,'g.staff').filter(el=>el.closest('g.measure')===measure);
  }
  function bindEvents(svg, engravingXML=latest.xml) {
    mapped.clear();sourceEventCount=0;mappingProblems=[];
    mappedChordGroups=0;mappedChordTones=0;
    const sources=makeSourceGroups(engravingXML,Number(latest.first));
    const measures=$(svg,'g.measure');
    if(measures.length!==sources.length)throw Error(`Rendered ${measures.length} measures; expected ${sources.length}`);
    // The draft input preserves explicit MusicXML note IDs in Verovio's SVG.
    // This also identifies cross-staff notes and written octave-shift pitches.
    if(latest.reviewMode==='draft' && svg.querySelector('[id^="pl-m"]')){
      for(let mi=0;mi<sources.length;mi++)for(const items of sources[mi].values())for(const item of items){
        sourceEventCount++;
        const ni=item.id.match(/-n(\d+)$/)?.[1],el=svg.querySelector(`#pl-m${mi}-n${ni}`);
        if(el && (el.classList.contains('note')||isRestGlyph(el)) && item.rest===isRestGlyph(el))mapped.set(item.id,el);
        else mappingProblems.push({event:item.id,reason:'Missing explicit source note ID'});
      }
      if(mappingProblems.length)report('mapping',`Mapped ${mapped.size}/${sourceEventCount} explicit source IDs`);
      return;
    }
    // Previously excluded draft systems have explicit, stable MusicXML note IDs
    // in Verovio's SVG. Their strict staff/layer order often fails on cross-
    // staff voices even though every glyph is present. For this separate,
    // opt-in cohort ONLY, map by exact source ID after checking the complete
    // inventory, glyph class, pitch step and (outside octave-shift passages)
    // printed octave. Never use a partial ID map as a successful alignment.
    const idPilot=latest.alignmentPilot===true &&
      window.PianoSourceIDAlignmentCandidates?.[latest.pieceSlug]?.includes(Number(latest.first));
    if(idPilot){
      const all=[];
      const octaveException=engravingXML.includes('<octave-shift');
      let sourceGood=true;
      for(let mi=0;mi<sources.length;mi++){
        const measure=measures[mi];
        const svgNodes=$(measure,'g.note, g.rest, g.mRest');
        const idGroups=new Map();
        for(const n of svgNodes){
          if(n.closest('g.measure')!==measure)continue;
          const a=idGroups.get(n.id)||[];a.push(n);idGroups.set(n.id,a);
        }
        const items=[...sources[mi].values()].flat();
        for(const item of items){
          const id=`pl-m${mi}-n${item.order}`,matches=idGroups.get(id)||[];
          const match=matches.length===1?matches[0]:null;
          if(!match||isRestGlyph(match)!==item.rest){sourceGood=false;break;}
          if(!item.rest){
            const actual=pitchOf(match), expected=item.pitch;
            if(actual&&actual!==expected){
              const split=val=>/^([a-g])(\d+)$/.exec(val||'');
              const a=split(actual),e=split(expected);
              if(!octaveException||!a||!e||a[1]!==e[1]||Math.abs(Number(a[2])-Number(e[2]))!==1){
                sourceGood=false;break;
              }
            }
          }
          all.push([item,match]);
        }
        if(!sourceGood || all.filter(x=>x[0].id.startsWith(`p0-m${Number(latest.first)+mi}-`)).length!==items.length)break;
      }
      if(sourceGood && all.length && new Set(all.map(pair=>pair[1])).size===all.length){
        for(const [item,node] of all)mapped.set(item.id,node);
        sourceEventCount=all.length;
        for(const groups of sources)for(const items of groups.values())for(const unit of xmlUnits(items))
          if(unit.length>1){mappedChordGroups++;mappedChordTones+=unit.length;}
        svg.dataset.sourceIdAligned='complete';
        return;
      }
      // A malformed/incomplete ID map is never allowed to produce a partial
      // candidate. Existing conservative mapping and exclusions remain available.
      svg.dataset.sourceIdAligned='rejected';
    }
    const used=new Set();
    for(let mi=0;mi<sources.length;mi++) {
      const groups=sources[mi];
      for(const items of groups.values())sourceEventCount+=items.length;
      const staffs=staffGroups(measures[mi]);
      for(let si=0;si<staffs.length;si++) {
        const staffNumber=si+1,staff=staffs[si];
        const voices=[...groups.keys()].filter(k=>Number(k.split(':')[0])===staffNumber)
          .sort((a,b)=>Number(a.split(':')[1])-Number(b.split(':')[1]));
        const layers=$(staff,'g.layer').filter(el=>el.closest('g.staff')===staff);
        const layerUnits=layers.map(svgUnits),layerEvents=layers.map(svgEvents);
        const assigned=new Set();
        // Strict layer-order matching is safe only when the units themselves
        // agree, including whether they are single notes or entire chords.
        if(voices.length===layers.length)for(let li=0;li<voices.length;li++) {
          const key=voices[li];
          if(attachUnits(groups.get(key),layerUnits[li],used))assigned.add(key);
        }
        for(const key of voices.filter(v=>!assigned.has(v))) {
          const src=groups.get(key);
          const possibilities=layerUnits.filter(units=>
            units.length===xmlUnits(src).length &&
            units.every((u,i)=>!used.has(u.node)&&unitFits(xmlUnits(src)[i],u)));
          if(possibilities.length===1 && attachUnits(src,possibilities[0],used))assigned.add(key);
        }
        // Single layer of mixed voices (rare): only accept the complete
        // MusicXML-order signature. No positional or pitch-only guessing.
        if(voices.length>1 && layers.length===1 && assigned.size===0) {
          const src=voices.flatMap(v=>groups.get(v)).sort((a,b)=>a.order-b.order);
          if(attachUnits(src,layerUnits[0],used))voices.forEach(v=>assigned.add(v));
        }
        // Last resort for a clearly identified *individual* note outside a
        // complete voice. Do not steal members of an assigned chord.
        const leftover=voices.flatMap(v=>groups.get(v)).filter(e=>!mapped.has(e.id));
        const available=svgEvents(staff).filter(el=>!el.closest('g.chord') && !used.has(el));
        for(const src of leftover) {
          if(src.chord)continue;
          if(leftover.filter(e=>e.rest===src.rest && e.pitch===src.pitch).length!==1)continue;
          const possible=available.filter(el=>!used.has(el) && candidateFits([src],[el]));
          const verified=src.rest?possible:possible.filter(el=>pitchOf(el)===src.pitch);
          if(verified.length===1){mapped.set(src.id,verified[0]);used.add(verified[0]);}
        }
        for(const key of voices) {
          const src=groups.get(key),missing=src.filter(e=>!mapped.has(e.id));
          if(!missing.length)continue;
          mappingProblems.push({measure:Number(latest.first)+mi+1,staff:staffNumber,
            voice:key.split(':')[1],missing:missing.map(e=>e.id),total:src.length,
            layerSizes:layerEvents.map(x=>x.length),
            layerUnits:layerUnits.map(x=>x.length),
            layerChords:layerUnits.map(x=>x.filter(u=>u.node.classList.contains('chord')).length),
            svgStaffEvents:svgEvents(staff).length});
        }
      }
      const missingStaffs=[...new Set([...groups.keys()].map(k=>Number(k.split(':')[0])))].filter(n=>n>staffs.length);
      for(const n of missingStaffs)for(const [key,src] of groups.entries())if(Number(key.split(':')[0])===n)
        mappingProblems.push({measure:Number(latest.first)+mi+1,staff:n,voice:key.split(':')[1],
          missing:src.map(e=>e.id),total:src.length,layerSizes:[],layerUnits:[],layerChords:[],svgStaffEvents:0});
    }
    // The Christmas Song s12, m45: the original source contains a C-flat 4
    // half note in RH voice 6 (staff 1). Verovio's SVG assigns this crossing
    // voice to bass staff 2, although the symbol prints in the upper register.
    // The normal staff-by-staff mapper therefore leaves this one note unmapped
    // at Verovio's native x, visibly sticking out past m46's final barline.
    // Associate only this independently verified note with its source event.
    // Never hide or clip it: the note is present in the reference scan at m45.
    if(latest?.pieceSlug==='the-christmas-song' &&
       Number(latest.first)===42 && Number(latest.last)===45){
      const id='p0-m44-n17';
      const source=sources[2]?.get('1:6')?.find(n=>n.id===id &&
        n.pitch==='c4' && n.sourceX===199 && !n.chord && !n.rest);
      if(source && !mapped.has(id)){
        const measure=measures[2],bass=staffGroups(measure)[1];
        const assigned=new Set(mapped.values());
        const candidates=bass?svgEvents(bass).filter(n=>
          n.closest('g.measure')===measure &&
          n.closest('g.staff')===bass && !n.closest('g.chord') &&
          !isRestGlyph(n) && !assigned.has(n) &&
          n.getAttribute('data-pname')==='c' &&
          n.getAttribute('data-oct')==='4'):[];
        if(candidates.length===1){
          mapped.set(id,candidates[0]);
          mappingProblems=mappingProblems.map(p=>p.missing?.includes(id)
            ? {...p,missing:p.missing.filter(m=>m!==id)} : p)
            .filter(p=>!Array.isArray(p.missing)||p.missing.length);
        }
      }
    }
    if(mappingProblems.length)report('mapping',`Mapped ${mapped.size}/${sourceEventCount}; ${mappingProblems.map(p=>`m${p.measure} staff ${p.staff} voice ${p.voice} (${p.total-p.missing.length}/${p.total}; SVG note groups ${p.layerSizes.join('/')||'none'}, rhythmic groups ${p.layerUnits.join('/')||'none'}, chord groups ${p.layerChords.join('/')||'none'})`).join('; ')}`);
  }

  // The scanned raster size, not the SVG page dimensions, establishes the
  // musical scale. Verovio's staff-line geometry establishes the rendered size.
  // Change the CSS width of the *entire* SVG uniformly (never x-only stretch).
  function staffHeightPixels(svg) {
    const staff=svg.querySelector('g.measure g.staff');
    if (!staff) return null;
    const shapes=staffLineShapes(staff).map(el=>el.getBoundingClientRect())
      .filter(r=>Number.isFinite(r.top) && Number.isFinite(r.bottom));
    // Most Verovio builds output a single path for all five staff lines.
    const full=shapes.filter(r=>r.height>15 && r.height<250)
      .sort((a,b)=>b.width-a.width);
    if (full.length) return full[0].height;
    // Other builds output five separate horizontal paths.
    const ys=[];
    for (const r of shapes.filter(r=>r.height<=8)) {
      const y=(r.top+r.bottom)/2;
      if (ys.every(other=>Math.abs(other-y)>3)) ys.push(y);
    }
    ys.sort((a,b)=>a-b);
    if(ys.length>=5){
      for(let i=0;i+4<ys.length;i++){
        const gaps=[0,1,2,3].map(j=>ys[i+j+1]-ys[i+j]);
        const avg=gaps.reduce((a,b)=>a+b,0)/4;
        if(avg>3 && avg<55 && gaps.every(v=>Math.abs(v-avg)<avg*.30))
          return ys[i+4]-ys[i];
      }
    }
    return null;
  }
  function barlineCenter(measure) {
    const bars=$(measure,'g.barLine').filter(el=>el.closest('g.measure')===measure);
    if(!bars.length)return null;
    const xs=bars.map(el=>{const b=el.getBoundingClientRect();return (b.left+b.right)/2;})
      .filter(Number.isFinite);
    return xs.length?Math.max(...xs):null;
  }
  function boundaries(svg) {
    const measures=$(svg,'g.measure');
    if(!measures.length) return null;
    const result=[measures[0].getBoundingClientRect().left];
    for (const m of measures) result.push(barlineCenter(m)??NaN);
    return result.every((x,i)=>Number.isFinite(x) && (i===0||x>result[i-1]))?result:null;
  }
  function fitToScannedStaff(svg) {
    // Reset the candidate to its original uniform responsive presentation.
    svg.style.width='100%'; svg.style.height='auto'; svg.style.marginLeft='0px';
    svg.setAttribute('preserveAspectRatio','xMinYMin meet');
    const naturalHeight=staffHeightPixels(svg);
    const scanWidth=image.naturalWidth||latest?.scanWidthPx||2300;
    const space=Number(latest?.scanStaffSpacePx);
    if(!Number.isFinite(space)||space<=0||!image.getBoundingClientRect().width) return null;
    const target=4*space * (image.getBoundingClientRect().width/scanWidth)*staffSizeFactor;
    if(!Number.isFinite(naturalHeight)||naturalHeight<5){
      lastScaleReport='staff lines not detected · size unchanged';
      return null; // Don't claim a successful calibration.
    }
    const ratio=target/naturalHeight;
    const available=notation.getBoundingClientRect().width;
    svg.style.width=`${(available*ratio).toFixed(3)}px`;
    // A horizontal offset is harmless: it changes neither glyph proportions
    // nor the spacing calculated by the engraver.
    const before=boundaries(svg);
    const scan=image.getBoundingClientRect();
    if(before && latest?.barlines?.length===before.length){
      const shift=scan.left+latest.barlines[0]*scan.width-before[0];
      svg.style.marginLeft=`${shift.toFixed(3)}px`;
    }
    const actual=staffHeightPixels(svg);
    lastScaleReport=`staff ${actual?.toFixed(1)??'?'} / ${target.toFixed(1)} px`;
    return {target,actual,ratio};
  }
  function geometry(svg) {
    const bars=latest?.barlines;
    const lines=boundaries(svg);
    if(!lines||!Array.isArray(bars)||bars.length!==lines.length) return null;
    const rect=image.getBoundingClientRect();
    const expected=bars.map(n=>rect.left+n*rect.width);
    const errors=lines.map((x,i)=>Math.abs(x-expected[i]));
    const meanPx=errors.reduce((a,b)=>a+b,0)/errors.length;
    return {lines,expected,meanPx,errors};
  }
  function drawGuides(){
    guides.replaceChildren();
    const targets=latest?.barlines;
    if(!Array.isArray(targets))return;
    for(const x of targets){
      const guide=document.createElement('div');
      guide.className='guide';guide.style.left=`${x*100}%`;
      guides.appendChild(guide);
    }
  }
  function matchScore(){
    const svg=notation.querySelector('svg');if(!svg)return;
    fitToScannedStaff(svg);
    const result=geometry(svg);
    lastAlignment=result
      ? `${lastScaleReport} · mean barline difference ${result.meanPx.toFixed(1)} px`
      : `${lastScaleReport} · guides only`;
    drawGuides();
  }
  function highlight() {
    for(const node of notation.querySelectorAll('.pl-selected')) node.classList.remove('pl-selected');
    for(const node of notation.querySelectorAll('.pl-selection-halo')) node.remove();
    if (!selectedID) return;
    const event = mapped.get(selectedID);
    if (!event || !event.isConnected) {
      status.dataset.selection='missing'; return;
    }
    status.dataset.selection='visible';
    event.classList.add('pl-selected');
    // A large, prominent ring; color alone is difficult to spot at full-system zoom.
    // For notes use the notehead symbol, not the full stem bounding box.
    // Rests retain their own glyph bounding box.
    const head=event.querySelector(':scope > use, :scope > g.notehead') || event;
    const box=head.getBBox();
    if (box.width>0 && box.height>0) {
      const r = document.createElementNS('http://www.w3.org/2000/svg','rect');
      const padX=Math.max(85,box.width*.13), padY=Math.max(85,box.height*.12);
      r.setAttribute('x',String(box.x-padX));r.setAttribute('y',String(box.y-padY));
      r.setAttribute('width',String(box.width+2*padX));r.setAttribute('height',String(box.height+2*padY));
      r.setAttribute('rx','100');r.setAttribute('ry','100');r.setAttribute('class','pl-selection-halo');
      event.insertBefore(r,event.firstChild);
    }
  }
  function alignAndHighlight() {
    if (!notation.querySelector('svg')) return;
    highlight();
    const visible=mapped.has(selectedID);
    if(sourceEventCount>0) report('rendered',`${lastAlignment} · ${mapped.size}/${sourceEventCount} events mapped · selection ${visible?'visible':'not mapped'}`);
  }
  function scheduleRender() {
    if(pendingRender) return;
    pendingRender=true;
    requestAnimationFrame(()=>{ pendingRender=false; render(); });
  }
  // The corrected MusicXML preserves layout from the printed edition. Each
  // measure's width and each note's default-x are in tenths of staff spacing.
  // Those numbers, together with the scanned barline anchors, determine *where*
  // notes go. The Verovio glyphs are never expanded or compressed to fill space.
  function xmlMeasures() {
    const root=new DOMParser().parseFromString(latest.xml,'application/xml');
    const part=root.querySelector('score-partwise > part');
    if(!part || root.querySelector('parsererror'))throw Error('Invalid XML layout');
    return directChildren(part,'measure');
  }
  function headRect(node) {
    const head=node.querySelector(':scope > g.notehead, :scope > use, :scope > g.chord > g.notehead, g.notehead, g.notehead use');
    return (head||node).getBoundingClientRect();
  }
  function headX(node) {
    const b=headRect(node);
    return (b.left+b.right)/2;
  }
  function addTranslation(node, cssDx, cssDy=0) {
    const matrix=node.getScreenCTM();
    if(!matrix || !Number.isFinite(cssDx) || !Number.isFinite(cssDy))return false;
    // A group may be ROTATED (arpeggios use rotate(-90deg)), skewed, or
    // scaled. matrix.a/matrix.d can therefore be zero even though its full
    // linear transform is invertible. Convert the requested screen-space
    // displacement into the group's own coordinates via the 2x2 inverse.
    // Never scale or rotate the original musical glyph merely to reposition it.
    const determinant=matrix.a*matrix.d-matrix.b*matrix.c;
    if(!Number.isFinite(determinant) || Math.abs(determinant)<1e-12)return false;
    const dx=(matrix.d*cssDx-matrix.c*cssDy)/determinant;
    const dy=(matrix.a*cssDy-matrix.b*cssDx)/determinant;
    if(!Number.isFinite(dx) || !Number.isFinite(dy))return false;
    const existing=node.getAttribute('transform')||'';
    node.setAttribute('transform',`${existing} translate(${dx.toFixed(5)} ${dy.toFixed(5)})`);
    return true;
  }
  const {reshapeLine,staffLineShapes,staffLineBox,matchVerticalStaffDistance,captureRuleGeometry,reconstructLedgerLines,layOutRulesFromScan}=window.PianoStaffRules.create(engravingContext);

  function measureEventSourceX(measure) {
    let cursor=0, previousOnset=0;
    const entries=[], byOnset=new Map();
    for(const node of measure.children){
      if(node.localName==='backup'){
        cursor-=Number(localContent(node,'duration','0'))||0;
      }else if(node.localName==='forward'){
        cursor+=Number(localContent(node,'duration','0'))||0;
      }else if(node.localName==='note'){
        const isChord=directChildren(node,'chord').length>0;
        const at=isChord?previousOnset:cursor;
        const known=node.hasAttribute('default-x')?Number(node.getAttribute('default-x')):null;
        entries.push({node,at,known});
        if(Number.isFinite(known)){
          if(!byOnset.has(at))byOnset.set(at,[]);
          byOnset.get(at).push(known);
        }
        if(!isChord){
          previousOnset=at;
          cursor+=Number(localContent(node,'duration','0'))||0;
        }
      }
    }
    let recovered=0;
    const positions=new Map();
    // Known print columns remain authoritative. Only a missing onset may
    // borrow an x coordinate; a voice's default-x never gets overwritten.
    const anchors=[...byOnset.entries()].map(([time,xs])=>({time,
      x:xs.reduce((sum,x)=>sum+x,0)/xs.length,
      spread:Math.max(...xs)-Math.min(...xs)})).sort((a,b)=>a.time-b.time);
    for(const {node,at,known} of entries){
      if(Number.isFinite(known)){positions.set(node,known);continue;}
      const xs=byOnset.get(at)||[];
      if(xs.length){
        const min=Math.min(...xs),max=Math.max(...xs);
        // Different staves may use different accidental columns. Refuse
        // ambiguous simultaneous columns instead of guessing.
        if(max-min>4)continue;
        positions.set(node,xs.reduce((sum,x)=>sum+x,0)/xs.length);
        recovered++;continue;
      }
      // An isolated missing event (m46 LH G3 at the and of beat 3 is an
      // example) can be placed by INTERPOLATING neighboring printed onset
      // anchors. Interpolate only inside a short bounded interval: never
      // extrapolate or push existing notes around to make room.
      const prior=[...anchors].reverse().find(a=>a.time<at && a.spread<=4);
      const next=anchors.find(a=>a.time>at && a.spread<=4);
      if(!prior||!next||next.time-prior.time>12||next.x<=prior.x)continue;
      const x=prior.x+(next.x-prior.x)*(at-prior.time)/(next.time-prior.time);
      if(Number.isFinite(x)){positions.set(node,x);recovered++;}
    }
    // A small number of transcribed tuplets contain a nonmonotonic printed
    // default-x for their final event (the last note jumps back over the
    // middle note). That x is source-layout metadata, not musical content.
    // Repair it transiently for the aligned SVG; keep MusicXML immutable.
    // Only act on a complete, explicitly marked tuplet, with at least three
    // distinct rhythmic onsets in one staff/voice and a demonstrably backward
    // final coordinate. Other source x values remain authoritative.
    let correctedTupletColumns=0;
    const activeTuplets=new Map();
    for(const row of entries){
      const node=row.node;
      const staff=localContent(node,'staff','1'),voice=localContent(node,'voice','1');
      const marks=$(node,'notations > tuplet');
      for(const mark of marks){
        const key=staff+':'+voice+':'+(mark.getAttribute('number')||'1');
        if(mark.getAttribute('type')==='start'){
          activeTuplets.set(key,{at:row.at,staff,voice});
        }else if(mark.getAttribute('type')==='stop'&&activeTuplets.has(key)){
          const start=activeTuplets.get(key);activeTuplets.delete(key);
          const grouped=new Map();
          for(const event of entries){
            const n=event.node;
            if(event.at<start.at||event.at>row.at ||
                localContent(n,'staff','1')!==staff||
                localContent(n,'voice','1')!==voice||
                directChildren(n,'chord').length)continue;
            const x=positions.get(n);
            if(Number.isFinite(x))grouped.set(event.at,x);
          }
          const onsetColumns=[...grouped].sort((a,b)=>a[0]-b[0]);
          if(onsetColumns.length!==3 || onsetColumns[0][0]!==start.at ||
              onsetColumns[2][0]!==row.at)continue;
          const x0=onsetColumns[0][1],x1=onsetColumns[1][1],x2=onsetColumns[2][1];
          const step=x1-x0;
          const width=Number(measure.getAttribute('width'));
          if(!(step>12 && x2<=x1 && width>x1+step+8))continue;
          const dx=step+x1-x2;
          for(const event of entries){
            if(event.at!==row.at ||
                localContent(event.node,'staff','1')!==staff ||
                localContent(event.node,'voice','1')!==voice)continue;
            const original=positions.get(event.node);
            if(Number.isFinite(original))positions.set(event.node,original+dx);
          }
          correctedTupletColumns++;
        }
      }
    }
    // SCAN-VERIFIED TUPLET RHYTHMIC COLUMNS (Stage 16).  A quarter-note
    // triplet spans TWO beats, not three.  In a few genuine source excerpts
    // three triplet onsets occupy almost the full three-beat engraving width,
    // leaving the following beat nearly coincident with the final tuplet
    // chord.  Other source columns have an uneven middle note, and in one
    // case the identical LH/RH triplet onsets disagree by 15-32 source units.
    // Do not stretch individual glyphs or move barlines. Infer the three
    // rhythmic columns from the *existing* first/following (or first/last)
    // source anchors, and move every chord tone on the same source onset.
    // Limit automated application to the two systems confirmed against scans;
    // all other potential cases remain candidates pending scan comparison.
    const correctedTupletRhythm=[];
    const scanVerifiedTupletSystem=latest?.pieceSlug==='the-most-wonderful-time-of-the-year' &&
      ((Number(latest.first)===8 && [10,11].includes(Number(measure.getAttribute('number')))) ||
       (Number(latest.first)===20 && [22,23].includes(Number(measure.getAttribute('number')))));
    if(scanVerifiedTupletSystem){
      const sourceTuples=[],active=new Map();
      for(const row of entries){
        const n=row.node,staff=localContent(n,'staff','1'),voice=localContent(n,'voice','1');
        for(const m of $(n,'notations > tuplet')){
          const key=staff+':'+voice+':'+(m.getAttribute('number')||'1');
          if(m.getAttribute('type')==='start')active.set(key,row);
          else if(m.getAttribute('type')==='stop'&&active.has(key)){
            sourceTuples.push({start:active.get(key),end:row,staff,voice});active.delete(key);
          }
        }
      }
      // Build complete, explicit 3:2 quarter triplets, never incidental
      // decorations or broken/missing tuplets.
      const candidates=[];
      for(const span of sourceTuples){
        const row=entries.filter(e=>e.at>=span.start.at&&e.at<=span.end.at &&
          localContent(e.node,'staff','1')===span.staff&&
          localContent(e.node,'voice','1')===span.voice &&
          !directChildren(e.node,'chord').length);
        const beats=[...new Map(row.map(e=>[e.at,e])).values()].sort((a,b)=>a.at-b.at);
        if(beats.length!==3||beats[0].at!==span.start.at||beats[2].at!==span.end.at)continue;
        if(!beats.every(e=>localContent(e.node,'type')==='quarter' &&
          localContent(directChildren(e.node,'time-modification')[0],'actual-notes')==='3'&&
          localContent(directChildren(e.node,'time-modification')[0],'normal-notes')==='2'))continue;
        const dur=Number(localContent(beats[0].node,'duration','0'));
        if(!(dur>0&&beats[1].at-beats[0].at===dur&&beats[2].at-beats[1].at===dur))continue;
        const xs=beats.map(e=>positions.get(e.node));
        if(!xs.every(Number.isFinite)||!(xs[0]<xs[1]&&xs[1]<xs[2]))continue;
        const next=entries.find(e=>e.at===beats[2].at+dur&&
          localContent(e.node,'staff','1')===span.staff&&
          localContent(e.node,'voice','1')===span.voice&&
          !directChildren(e.node,'chord').length);
        const nextX=next?positions.get(next.node):null;
        candidates.push({...span,beats,xs,dur,nextX});
      }
      const getAnchor=items=>items.find(t=>t.staff==='1'&&t.voice==='1')||null;
      const anchor=getAnchor(candidates);
      const sourceWidth=Number(measure.getAttribute('width'));
      if(anchor){
        const [x0,x1,x2]=anchor.xs,d1=x1-x0,d2=x2-x1;
        // When the next beat is cramped against the third triplet note,
        // solve all THREE tuplet columns in a four-column rhythmic grid.
        // Preserve first note, first post-triplet beat and scanned barlines.
        const next=anchor.nextX;
        const cramped=Number.isFinite(next)&&next>x2&&
          next-x2<Math.min(d1,d2)*.55&&
          d1>20&&d2>20&&Math.abs(d1-d2)<Math.max(7,d1*.25)&&
          next<sourceWidth-20;
        // Otherwise, only a sufficiently skewed *middle* quarter tuplet
        // source coordinate is recovered (the two endpoints stay fixed).
        const skewed=!Number.isFinite(next)&&d1>20&&d2>20&&
          Math.abs(d1-d2)>=10&&Math.abs(d1-d2)<Math.max(d1,d2)*.6&&
          x2<sourceWidth-15;
        if(cramped||skewed){
          const target=cramped?[x0,x0+(next-x0)/3,x0+2*(next-x0)/3]:
            [x0,(x0+x2)/2,x2];
          // Source-verified simultaneous RH/LH tuplets must share onset
          // columns.  Never pull in a different, unrelated voice or staff.
          const matched=cramped?candidates.filter(t=>t.beats.every((b,i)=>b.at===anchor.beats[i].at)):
            [anchor];
          for(const t of matched){
            let moved=0;
            for(let i=0;i<3;i++){
              const at=t.beats[i].at,old=t.xs[i],shift=target[i]-old;
              if(Math.abs(shift)<.01)continue;
              for(const e of entries){
                if(e.at!==at||localContent(e.node,'staff','1')!==t.staff||
                  localContent(e.node,'voice','1')!==t.voice)continue;
                const prev=positions.get(e.node);
                if(Number.isFinite(prev)){positions.set(e.node,prev+shift);moved++;}
              }
            }
            if(moved)correctedTupletRhythm.push({
              measure:Number(measure.getAttribute('number')),staff:t.staff,voice:t.voice,
              kind:cramped?'cramped-following-beat':'uneven-interior-column',
              before:t.xs,after:target.map(x=>Math.round(x*1000)/1000),
              events:moved});
          }
        }
      }
    }
    // RHYTHMIC SOURCE-COLUMN RECOVERY: malformed engraving x metadata can
    // put a final beat outside its declared measure or collapse two distinct
    // final eighth-note onsets onto the same x.  Source onset/duration is
    // musical truth; repair only when several independent earlier coordinates
    // establish the target column.  Never modify the MusicXML or guess a
    // pitch, staff, duration, or vertical placement.  The scans must still be
    // reviewed; all adjustments are recorded for browser diagnostics.
    const rhythmCorrections=[];
    const sourceWidth=Number(measure.getAttribute('width'));
    if(sourceWidth>80){
      const sounding=entries.filter(e=>!directChildren(e.node,'grace').length &&
        !directChildren(e.node,'chord').length &&
        Number.isFinite(positions.get(e.node)));
      const byVoice=new Map();
      for(const e of sounding){
        const key=localContent(e.node,'staff','1')+':'+localContent(e.node,'voice','1');
        if(!byVoice.has(key))byVoice.set(key,[]);
        byVoice.get(key).push(e);
      }
      // Last sounding beat: three consecutive, evenly spaced source columns
      // prove the fourth x, whereas an out-of-bounds x is unreliable. This
      // also recovers the horizontal position of any notes in its chord.
      for(const [key,group] of byVoice){
        if(group.length<4)continue;
        const last=group.at(-1),prior=group.slice(-4,-1);
        const oldX=positions.get(last.node);
        if(!(oldX>sourceWidth+Math.max(4,sourceWidth*.015)))continue;
        const times=[...prior,last].map(e=>e.at),
          xs=prior.map(e=>positions.get(e.node));
        const dt=times[1]-times[0];
        if(!(dt>0&&times[2]-times[1]===dt&&times[3]-times[2]===dt))continue;
        const a=xs[1]-xs[0],b=xs[2]-xs[1],step=(a+b)/2;
        if(!(a>12&&b>12&&Math.abs(a-b)<Math.max(5,step*.16)))continue;
        const repaired=xs[2]+step,shift=repaired-oldX;
        if(!(repaired>xs[2]+12&&repaired<sourceWidth-Math.max(10,sourceWidth*.04) &&
          shift< -Math.max(18,sourceWidth*.09)))continue;
        let count=0;
        for(const e of entries){
          if(e.at!==last.at || !Number.isFinite(positions.get(e.node)) ||
             localContent(e.node,'staff','1')+':'+localContent(e.node,'voice','1')!==key)continue;
          positions.set(e.node,positions.get(e.node)+shift);count++;
        }
        if(count)rhythmCorrections.push({kind:'out-of-bounds-final-beat',
          measure:Number(measure.getAttribute('number')),staffVoice:key,
          onset:last.at,oldX,newX:repaired,events:count});
      }
      // Different onsets at the end of a measure must NOT share one x. A
      // same-beat bass note and RH rest may share their column, but the
      // subsequent eighth chord must follow them.  If the last two columns
      // collapse and a third independent source column precedes them, move
      // only the *earlier* (penultimate) onset halfway into the available
      // interval. Keep the final chord and barline exactly as they were.
      const onsetMap=new Map();
      for(const e of entries){
        const x=positions.get(e.node);
        if(!Number.isFinite(x)||directChildren(e.node,'grace').length)continue;
        if(!onsetMap.has(e.at))onsetMap.set(e.at,[]);
        onsetMap.get(e.at).push({e,x});
      }
      const columns=[...onsetMap].map(([at,items])=>{
        const ordered=items.map(x=>x.x).sort((a,b)=>a-b);
        return {at,items,x:ordered[Math.floor((ordered.length-1)/2)],
          spread:ordered.at(-1)-ordered[0]};
      }).sort((a,b)=>a.at-b.at);
      if(columns.length>=4){
        const [before,penultimate,terminal]=columns.slice(-3);
        const collapsed=Math.abs(terminal.x-penultimate.x)<1 &&
          penultimate.spread<4 && terminal.spread<4;
        const available=terminal.x-before.x;
        if(collapsed && terminal.at>penultimate.at &&
           penultimate.at-before.at===terminal.at-penultimate.at &&
           available>Math.max(35,sourceWidth*.15) &&
           terminal.x<sourceWidth-Math.max(14,sourceWidth*.035)){
          const desired=before.x+available*.5;
          const dx=desired-penultimate.x;
          if(dx< -Math.max(10,sourceWidth*.035)){
            for(const {e} of penultimate.items)
              positions.set(e.node,positions.get(e.node)+dx);
            rhythmCorrections.push({kind:'collapsed-trailing-onsets',
              measure:Number(measure.getAttribute('number')),
              onset:penultimate.at,nextOnset:terminal.at,
              oldX:penultimate.x,newX:desired,finalX:terminal.x,
              events:penultimate.items.length});
          }
        }
      }
    }
    // SCAN-PROVEN VOICE-ONSET COLUMN RECOVERY (Stage 17).  Distinguish an
    // *actual* malformed rhythmic source column from intentional independent
    // voice offsets used for seconds, accidentals and other engraving detail.
    // Two unlocked Rudolph measures have been checked against their scans.
    // Interpolate the collapsed three-beat voice across its declared printed
    // measure width, or borrow a unique, corroborated simultaneous voice
    // column. Never change timing, note identity, pitch or original MusicXML.
    const correctedVoiceOnsets=[];
    const measureNumber=Number(measure.getAttribute('number'));
    const rudolph=latest?.pieceSlug==='rudolph-the-red-nosed-reindeer';
    const event=(staff,voice,at,step,oct)=>entries.find(e=>
      e.at===at && localContent(e.node,'staff','1')===staff &&
      localContent(e.node,'voice','1')===voice &&
      localContent(directChildren(e.node,'pitch')[0],'step','')===step &&
      localContent(directChildren(e.node,'pitch')[0],'octave','')===oct &&
      !directChildren(e.node,'chord').length);
    if(rudolph && Number(latest.first)===20 && measureNumber===22 &&
       sourceWidth===229){
      const triple=[event('1','1',0,'C','5'),
        event('1','1',6,'B','4'),event('1','1',12,'A','4')];
      const lowF=event('2','6',12,'F','3');
      const voice=entries.filter(e=>localContent(e.node,'staff','1')==='1'&&
        localContent(e.node,'voice','1')==='1'&&
        !directChildren(e.node,'chord').length);
      const firstX=triple[0]?positions.get(triple[0].node):NaN;
      const sourceCollapsed=triple.every((e,i)=>e && e.at===i*6 &&
        Number(e.node.getAttribute('default-x'))===12 &&
        localContent(e.node,'type')==='quarter' &&
        Number(localContent(e.node,'duration','0'))===6);
      const fSharp=lowF && localContent(directChildren(lowF.node,'pitch')[0],'alter','0')==='1' &&
        !lowF.node.hasAttribute('default-x') &&
        Number(localContent(lowF.node,'duration','0'))===6;
      if(voice.length===3 && sourceCollapsed && fSharp && firstX===12){
        const target=(at)=>firstX+(sourceWidth-firstX)*at/18;
        let changed=0;
        for(const e of [...triple,lowF]){
          const to=target(e.at),from=positions.get(e.node);
          if(!Number.isFinite(from))continue;
          if(Math.abs(to-from)>.01){positions.set(e.node,to);changed++;}
        }
        if(changed===3)correctedVoiceOnsets.push({kind:'collapsed-quarter-onsets',
          measure:22,first:latest.first,sourceWidth,
          sourceXs:[12,12,12],recoveredXs:[0,6,12].map(target),
          durationPerBeat:6,events:changed,
          includesMissingSourceLHFinalNote:true});
      }
    }
    if(rudolph && Number(latest.first)===70 && measureNumber===73 &&
       sourceWidth===284){
      const b=event('1','1',4,'B','4');
      const c=event('1','2',4,'C','4');
      const d=event('2','5',4,'D','2');
      const onsetNote=entries.filter(e=>e.at===4 &&
        localContent(e.node,'staff','1')==='1'&&
        localContent(e.node,'voice','2')==='2'&&
        localContent(e.node,'type')==='half');
      if(b&&c&&d && Number(b.node.getAttribute('default-x'))===180 &&
         Number(c.node.getAttribute('default-x'))===155 &&
         Number(d.node.getAttribute('default-x'))===156 &&
         localContent(b.node,'type')==='quarter' &&
         Number(localContent(b.node,'duration','0'))===2 &&
         onsetNote.length>=3 &&
         onsetNote.filter(e=>Number(e.node.getAttribute('default-x'))===155).length>=2){
        const from=positions.get(b.node),to=positions.get(c.node);
        if(Number.isFinite(from)&&Number.isFinite(to)&&from-to===25){
          positions.set(b.node,to);
          correctedVoiceOnsets.push({kind:'corroborated-simultaneous-half-note',
            measure:73,first:latest.first,sourceWidth,oldX:from,newX:to,
            independentBassAnchor:156,events:1});
        }
      }
    }
    // STAGE 18 — SOURCE-CORROBORATED SAME-ONSET NOTE COLUMN. An accidental
    // source coordinate may be stale from an earlier beat even when the two
    // other independently transcribed voices place the actual beat correctly.
    // Preserve intentional small chord/accidental offsets: only the exact
    // scan-reviewed source signature, simultaneous same-staff half-note, and
    // corroborating bass onset may trigger the recovered source-time column.
    // No canonical MusicXML, time, duration, or vertical position is altered.
    if(latest?.pieceSlug==='the-most-wonderful-time-of-the-year' &&
       Number(latest.first)===12 && measureNumber===13 && sourceWidth===364){
      const early=event('1','1',12,'G','4');
      const sameStaff=event('1','2',12,'D','4');
      const bass=event('2','5',12,'E','2');
      const following=event('1','1',15,'C','5');
      const known=(e)=>e?Number(e.node.getAttribute('default-x')):NaN;
      if(early && sameStaff && bass && following &&
         known(early)===100 && known(sameStaff)===224 &&
         known(bass)===213 && known(following)===254 &&
         localContent(early.node,'type')==='eighth' &&
         Number(localContent(early.node,'duration','0'))===3 &&
         localContent(sameStaff.node,'type')==='half' &&
         Number(localContent(sameStaff.node,'duration','0'))===12 &&
         localContent(bass.node,'type')==='quarter' &&
         Number(localContent(bass.node,'duration','0'))===9 &&
         Number.isFinite(positions.get(early.node)) &&
         positions.get(early.node)===100 &&
         positions.get(sameStaff.node)===224 &&
         positions.get(bass.node)===213){
        // Align the two voices on their shared beat. The source's remaining
        // rhythmic columns and all final scan-calibrated barlines stay fixed.
        positions.set(early.node,positions.get(sameStaff.node));
        correctedVoiceOnsets.push({kind:'corroborated-stale-eighth-column',
          measure:13,first:latest.first,sourceWidth,
          onset:12,originalX:100,recoveredX:224,bassOnsetX:213,
          followingEighthX:254,events:1});
      }
    }
    return {positions,recovered,correctedTupletColumns,correctedTupletRhythm,rhythmCorrections,correctedVoiceOnsets};
  }
  // MusicXML occasionally contains a printed measure width but NO note x
  // coordinates (notably measure 47). In that case do not abandon the entire
  // measure to Verovio's compact layout. Spread rhythmic onset groups across
  // its scanned barline interval using their NATURAL Verovio x ordering.
  // This is a visibly provisional substitute, not a recovery of source data.
  function noCoordinateMeasurePositions(measure, mi, firstIndex, screenBar, mapped, originalX) {
    const nodes=directChildren(measure,'note');
    if(!nodes.length||nodes.some(n=>n.hasAttribute('default-x')))return null;
    const byTime=new Map(), onsetOf=new Map();
    let cursor=0,prev=0,idx=0;
    for(const child of measure.children){
      if(child.localName==='backup')cursor-=Number(localContent(child,'duration','0'))||0;
      else if(child.localName==='forward')cursor+=Number(localContent(child,'duration','0'))||0;
      else if(child.localName==='note'){
        const chord=directChildren(child,'chord').length>0;
        const at=chord?prev:cursor;
        const event=mapped.get(`p0-m${firstIndex+mi}-n${idx++}`);
        const owner=event?.closest('g.chord')||event;
        const ox=owner?(originalX.get(event) ?? originalX.get(owner)):null;
        if(Number.isFinite(ox)){
          if(!byTime.has(at))byTime.set(at,[]);
          byTime.get(at).push(ox);
          onsetOf.set(child,at);
        }
        if(!chord){prev=at;cursor+=Number(localContent(child,'duration','0'))||0;}
      }
    }
    if(byTime.size<2)return null;
    const med=xs=>{const a=[...xs].sort((a,b)=>a-b);return a[Math.floor((a.length-1)/2)];};
    const rows=[...byTime].map(([time,xs])=>({time,x:med(xs)})).sort((a,b)=>a.time-b.time);
    // The median eliminates voice-specific accidental offsets for notes at
    // the same attack. Enforce monotonicity to avoid reversing any notes.
    for(let i=1;i<rows.length;i++)rows[i].x=Math.max(rows[i].x,rows[i-1].x+.001);
    const xmin=rows[0].x,xmax=rows[rows.length-1].x;
    const width=screenBar[mi+1]-screenBar[mi], sourceWidth=Number(measure.getAttribute('width'));
    if(!(xmax>xmin)||!(width>25)||!(sourceWidth>0))return null;
    const gap=Number(latest.scanStaffSpacePx||17)*image.getBoundingClientRect().width/(image.naturalWidth||2300)*staffSizeFactor;
    const ordinaryPad=Math.min(width*.16,Math.max(12,gap*1.5));
    let leftPad=ordinaryPad;
    // Measure 47 begins a system and its original x coordinates are ALL
    // absent. A provisional first note must clear the printed clef and key;
    // merely reserving a barline margin caused a clef/note collision.
    if(mi===0){
      const currentMeasure=$(notation,'g.measure')[mi];
      const leftEdge=screenBar[mi];
      const signatures=currentMeasure?$(currentMeasure,'g.clef, g.keySig'):[];
      const occupied=signatures.map(g=>g.getBoundingClientRect()).filter(r=>
        Number.isFinite(r.right) && r.left>=leftEdge-75 && r.left<leftEdge+Math.min(width*.38,150));
      if(occupied.length){
        leftPad=Math.max(leftPad,Math.max(...occupied.map(r=>r.right))-leftEdge+gap*1.15);
      }
      // In system 13 the scan's first notehead falls roughly one fifth
      // of the way into its first measure; clef geometry alone is insufficient
      // because the accidental/chord has its own horizontal footprint.
      leftPad=Math.max(leftPad,width*.22);
      leftPad=Math.min(leftPad,width*.38);
    }
    const rightPad=Math.min(width*.16,Math.max(12,gap*1.5));
    if(leftPad+rightPad>width*.75){leftPad=width*.35;}
    const positions=new Map();
    for(const [node,at] of onsetOf){
      const x=rows.find(r=>r.time===at)?.x;
      if(!Number.isFinite(x))continue;
      const target=leftPad+(x-xmin)/(xmax-xmin)*(width-leftPad-rightPad);
      positions.set(node, target/width*sourceWidth);
    }
    return positions;
  }
  // All annotation endpoints are SCREEN coordinates. Convert them back to
  // the outer SVG's coordinate space, so Copy SVG includes the repairs and
  // resizing the viewer never introduces a second independent coordinate map.
  function engravingPoint(svg,x,y) {
    const ctm=svg.getScreenCTM();
    if(!ctm)return null;
    const p=new DOMPoint(x,y).matrixTransform(ctm.inverse());
    return Number.isFinite(p.x)&&Number.isFinite(p.y)?p:null;
  }
  function drawAnnotationLine(svg,layer,x1,y1,x2,y2,width) {
    const p=engravingPoint(svg,x1,y1),q=engravingPoint(svg,x2,y2);
    if(!p||!q)return false;
    const line=document.createElementNS('http://www.w3.org/2000/svg','line');
    Object.entries({x1:p.x,y1:p.y,x2:q.x,y2:q.y}).forEach(([key,value])=>
      line.setAttribute(key,String(value)));
    line.setAttribute('stroke','#111');line.setAttribute('fill','none');
    line.setAttribute('stroke-width',String(width));
    line.setAttribute('stroke-linecap','butt');
    line.setAttribute('vector-effect','non-scaling-stroke');
    layer.appendChild(line);return true;
  }
  function createAnnotationLayer(svg,name) {
    const group=document.createElementNS('http://www.w3.org/2000/svg','g');
    group.setAttribute('class',name);
    group.setAttribute('pointer-events','none');
    svg.appendChild(group);return group;
  }
  // Keep the original brace glyph (including its characteristic curves), but
  // register its right edge and full height to the scan's two grand staves.
  // Verovio's system-start line is subsequently replaced by the scan barline.
  function registerOpeningSystem(svg,barX,gap) {
    const system=svg.querySelector('g.system');
    if(!system)return {braces:0,signatures:0};
    let signatures=0, braces=0;
    const first=system.querySelector('g.measure');
    const staffGroupsAtStart=first ? staffGroups(first):[];
    const groups=staffGroupsAtStart.map(staff=>$(staff,'g.clef, g.keySig, g.meterSig')
      .filter(g=>!g.parentElement?.closest('g.clef, g.keySig, g.meterSig')));
    const boxes=groups.flat().map(g=>g.getBoundingClientRect()).filter(r=>r.width>1);
    if(boxes.length){
      const minLeft=Math.min(...boxes.map(r=>r.left));
      const move=Math.max(0,barX+Math.max(2,gap*.65)-minLeft);
      // Moving the signature block must not change internal clef/key spacing.
      if(move<gap*7){
        for(const group of groups)for(const node of group)
          if(addTranslation(node,move))signatures++;
      }
    }
    const brace=system.querySelector(':scope > g.grpSym');
    if(brace){
      const r=brace.getBoundingClientRect(),parent=brace.parentNode,ctm=parent?.getScreenCTM();
      const grand=staffGroupsAtStart.map(st=>staffLineBox(st));
      if(ctm&&r.height>2&&Math.abs(ctm.a)>1e-8&&Math.abs(ctm.d)>1e-8&&grand.every(Boolean)){
        const wantTop=grand[0].top, wantBottom=grand[grand.length-1].bottom;
        const stretch=(wantBottom-wantTop)/r.height;
        const tx=(barX-Math.max(2,gap*.25)-r.right)/ctm.a;
        const ty=(wantTop-ctm.f-stretch*(r.top-ctm.f))/ctm.d;
        if(stretch>.4&&stretch<2.2 && Number.isFinite(tx)&&Number.isFinite(ty)){
          const wrap=document.createElementNS('http://www.w3.org/2000/svg','g');
          wrap.setAttribute('class','pl-opening-brace');
          wrap.setAttribute('transform',`matrix(1 0 0 ${stretch.toFixed(7)} ${tx.toFixed(5)} ${ty.toFixed(5)})`);
          parent.insertBefore(wrap,brace);wrap.appendChild(brace);braces++;
        }
      }
    }
    return {braces,signatures};
  }
  // Staff-aware layout repair. This event is encoded on RH staff 1 but
  // Verovio emits its glyph under LH staff 2. Its musical identity, source x,
  // and the comparable C4 heads in RH are verified; move only the complete
  // note/accidental/stem group vertically, never the source XML or its pitch.
  function relocateVerifiedCrossStaffGlyphs(svg){
    if(latest?.pieceSlug!=='the-christmas-song'||Number(latest.first)!==42)return 0;
    const note=mapped.get('p0-m44-n17');
    if(!note||note.getAttribute('data-pname')!=='c'||note.getAttribute('data-oct')!=='4')return 0;
    const measures=$(svg,'g.measure'),targetStaff=staffGroups(measures[2])[0];
    if(!targetStaff||note.closest('g.staff')===targetStaff)return 0;
    const references=measures.flatMap(m=>{
      const rh=staffGroups(m)[0];
      return rh?$(rh,'g.note').filter(n=>
        n.getAttribute('data-pname')==='c'&&n.getAttribute('data-oct')==='4'&&
        n.closest('g.staff')===rh):[];
    });
    if(!references.length)return 0;
    const sample=references.map(n=>{const r=headRect(n);return (r.top+r.bottom)/2;})
      .filter(Number.isFinite).sort((a,b)=>a-b);
    if(!sample.length)return 0;
    const goal=sample[Math.floor(sample.length/2)],head=headRect(note);
    const dy=goal-(head.top+head.bottom)/2;
    const gap=Math.max(3,staffHeightPixels(svg)/4);
    if(!Number.isFinite(dy)||Math.abs(dy)<gap || Math.abs(dy)>Math.max(gap*14,Math.abs(staffLineBox(staffGroups(measures[2])[1]).top-staffLineBox(targetStaff).top)*1.1))return 0;
    if(!addTranslation(note,0,dy))return 0;
    note.dataset.sourceStaffPlacement='1';
    svg.dataset.crossStaffRelocated='p0-m44-n17';
    return 1;
  }

  // A source-ID mapping can be complete yet place a cross-staff glyph at
  // Verovio's chosen staff rather than the source's printed staff. Recover
  // vertical geometry ONLY when all members of an SVG chord/beam share one
  // unambiguous staff destination and their pitch-based shifts agree. Move
  // whole owners so stems and beams remain attached; never modify score XML.
  function relocateSourceIDCrossStaff(svg){
    if(svg.dataset.sourceIdAligned!=='complete')return 0;
    const measures=$(svg,'g.measure'),source=xmlMeasures();
    const firstAttrs=source[0]?.querySelector('attributes');
    const clefs=firstAttrs?[...firstAttrs.querySelectorAll(':scope > clef')]:[];
    // This mapping is valid only for a conventional treble-over-bass pair.
    // Any clef change requires a separate, clef-aware implementation.
    const initial=clefs.map(c=>[localContent(c,'sign'),localContent(c,'line')]);
    if(initial.length!==2||initial[0].join(':')!=='G:2'||initial[1].join(':')!=='F:4' ||
      source.some((m,i)=>i>0&&m.querySelector('attributes > clef')))return 0;
    const src=new Map(),pitches=new Map(),owners=new Map();
    for(let mi=0;mi<source.length;mi++){
      const notes=directChildren(source[mi],'note');
      for(let ni=0;ni<notes.length;ni++){
        const note=notes[ni],id=`pl-m${mi}-n${ni}`;
        const staff=Number(localContent(note,'staff','1'));
        const pitch=note.querySelector(':scope > pitch');
        const step=localContent(pitch,'step').toUpperCase();
        const octave=Number(localContent(pitch,'octave',''));
        if((staff!==1&&staff!==2)||!pitch||!['C','D','E','F','G','A','B'].includes(step)||!Number.isInteger(octave))continue;
        src.set(id,staff);pitches.set(id,{step,octave});
      }
    }
    const candidates=[];
    for(let mi=0;mi<measures.length;mi++){
      const staffNodes=staffGroups(measures[mi]);
      const targetBoxes=staffNodes.map(staffLineBox);
      if(staffNodes.length!==2||targetBoxes.some(r=>!r))continue;
      const relevant=$(measures[mi],'g.note').filter(n=>
        /^pl-m\d+-n\d+$/.test(n.id)&&src.has(n.id));
      for(const note of relevant){
        const sourceStaff=src.get(note.id),svgStaff=staffNodes.indexOf(note.closest('g.staff'))+1;
        if(!svgStaff||sourceStaff===svgStaff)continue;
        const beam=note.closest('g.beam'),chord=note.closest('g.chord');
        const container=beam||chord||note;
        if(owners.has(container))continue;
        const children=container===note?[note]:$(container,'g.note').filter(x=>x.closest('g.beam')===beam || !beam);
        // No cross-staff guessing: every note in a moved beam/chord must have
        // an ID and agree on the same new staff and the same old SVG staff.
        const safe=children.length>0&&children.every(x=>src.get(x.id)===sourceStaff &&
          staffNodes.indexOf(x.closest('g.staff'))+1===svgStaff && pitches.has(x.id));
        if(!safe){owners.set(container,false);continue;}
        const shifts=[];
        for(const child of children){
          const {step,octave}=pitches.get(child.id);
          const index='CDEFGAB'.indexOf(step);
          const base=sourceStaff===1?4*7+2:2*7+4; // E4 or G2, bottom line.
          const dia=octave*7+index-base;
          const lines=targetBoxes[sourceStaff-1],gap=(lines.bottom-lines.top)/4;
          const targetY=lines.bottom-dia*gap/2;
          const rect=headRect(child);
          const actualY=(rect.top+rect.bottom)/2;
          if(!Number.isFinite(targetY)||!Number.isFinite(actualY)){shifts.length=0;break;}
          shifts.push(targetY-actualY);
        }
        if(!shifts.length){owners.set(container,false);continue;}
        const y=shifts.reduce((a,b)=>a+b,0)/shifts.length;
        const gap=(targetBoxes[sourceStaff-1].bottom-targetBoxes[sourceStaff-1].top)/4;
        if(shifts.some(v=>Math.abs(v-y)>gap*.65) || Math.abs(y)>gap*25){
          owners.set(container,false);continue;
        }
        owners.set(container,{sourceStaff,y,children});
      }
    }
    let moved=0;
    for(const [container,data] of owners){
      if(!data||!addTranslation(container,0,data.y))continue;
      data.children.forEach(n=>{n.dataset.sourceStaffPlacement=String(data.sourceStaff);});
      moved+=data.children.length;
    }
    if(moved)svg.dataset.sourceIDCrossStaffMoved=String(moved);
    return moved;
  }

  // Non-opening signatures are score events: they belong to the measured
  // boundary, not Verovio's automatically justified x-coordinate. Keep this
  // pilot restricted to three independently identified scan examples; broad
  // application requires an explicit MusicXML timing/ownership audit.
  function registerVerifiedInternalSignatures(svg){
    const bars=latest?.barlines;
    if(!bars?.length||!image.naturalWidth)return 0;
    const scan=image.getBoundingClientRect(),measureGroups=$(svg,'g.measure');
    const space=Math.max(3,staffHeightPixels(svg)/4);
    const xAt=i=>scan.left+bars[i]*scan.width;
    const rules={
      'have-yourself-a-merry-little-christmas':{first:55,measure:57,kind:'keySig',edge:'left'},
      'there-s-no-place-like-home-for-the-holidays':{first:64,measure:66,kind:'clef',edge:'right'}
    };
    const rule=rules[latest.pieceSlug];
    if(!rule||Number(latest.first)!==rule.first)return 0;
    const mi=rule.measure-Number(latest.first)-1;
    if(mi<0||mi>=measureGroups.length)return 0;
    const measure=measureGroups[mi];let fixed=0;
    for(const staff of staffGroups(measure)){
      // The scanned Home-for-the-Holidays clef belongs on the LH staff only.
      if(rule.kind==='clef'&&staff!==staffGroups(measure)[1])continue;
      const nodes=$(staff,'g.'+rule.kind).filter(n=>!n.parentElement?.closest('g.'+rule.kind));
      if(nodes.length!==1)continue;
      const node=nodes[0],box=node.getBoundingClientRect();
      if(!(box.width>1))continue;
      const target=rule.edge==='left' ? xAt(mi)+space*.35 : xAt(mi+1)-box.width-space*.35;
      const dx=target-box.left;
      if(Math.abs(dx)<space*.2)continue;
      if(Math.abs(dx)>Math.max(350,scan.width*.5))continue;
      if(addTranslation(node,dx)){node.dataset.scanSignaturePlacement=rule.edge;fixed++;}
    }
    svg.dataset.internalSignaturesPositioned=String(fixed);
    return fixed;
  }

  // BATCH REPAIR: source-driven interior key/time changes. These glyphs are
  // siblings of note groups in Verovio's original SVG; notehead reflow does
  // not move them. Only handle an explicit attributes event at a measure's
  // BEGINNING with a single matching signature per staff. Keep existing
  // special-case/courtesy signatures and all opening signatures unchanged.
  // Never move notes to make room; leave uncertain/colliding symbols for review.
  function reflowSourceInternalSignatures(svg){
    if(!latest?.barlines?.length || !image.naturalWidth)return 0;
    const ms=xmlMeasures(), measureGroups=$(svg,'g.measure');
    if(ms.length!==measureGroups.length||latest.barlines.length!==ms.length+1)return 0;
    const scan=image.getBoundingClientRect();
    const gap=Number(latest.scanStaffSpacePx||17)*scan.width/
      (image.naturalWidth||latest.scanWidthPx||2300)*staffSizeFactor;
    if(!(gap>2&&Number.isFinite(gap)))return 0;
    let fixed=0;
    for(let mi=1;mi<ms.length;mi++){
      const source=ms[mi],attributes=directChildren(source,'attributes');
      // Attributes after a sounding event could indicate an internal change,
      // not the left boundary. Those require a separate source-time mapping.
      const firstMusical=[...source.children].findIndex(n=>
        ['note','backup','forward','direction'].includes(n.localName));
      for(const [xmlName,svgName] of [['key','keySig'],['time','meterSig']]){
        const hasChange=attributes.some(a=>[...a.children].some(c=>c.localName===xmlName)
          && (firstMusical<0 || [...source.children].indexOf(a)<firstMusical));
        if(!hasChange)continue;
        const bar=scan.left+latest.barlines[mi]*scan.width;
        const target=bar+gap*.32;
        if(!Number.isFinite(target))continue;
        for(const staff of staffGroups(measureGroups[mi])){
          const groups=$(staff,'g.'+svgName).filter(n=>n.closest('g.staff')===staff &&
            !n.parentElement?.closest('g.'+svgName));
          if(groups.length!==1)continue;
          const el=groups[0],r=el.getBoundingClientRect();
          if(!(r.width>1&&Number.isFinite(r.left)))continue;
          // The source noteheads have already been aligned to the scan.
          // A real signature must fit BEFORE the first sounding event; do
          // not obscure a notehead to make a visually ambiguous 'fix'.
          const notes=$(staff,'g.note,g.chord,g.rest').filter(n=>
            n.closest('g.staff')===staff &&
            !n.parentElement?.closest('g.note,g.chord,g.rest'));
          const firstNote=Math.min(...notes.map(n=>headRect(n).left).filter(Number.isFinite));
          if(Number.isFinite(firstNote)&&target+r.width+gap*.24>firstNote)continue;
          if(Math.abs(r.left-target)<gap*.20)continue;
          if(Math.abs(r.left-target)>scan.width*.98)continue;
          if(addTranslation(el,target-r.left)){
            el.dataset.sourceSignaturePlacement='measure-boundary';
            el.dataset.sourceMeasure=String(Number(latest.first)+mi+1);
            fixed++;
          }
        }
      }
    }
    svg.dataset.sourceSignaturesRepositioned=String(fixed);
    return fixed;
  }

  // UNIVERSAL GEOMETRY COVERAGE — stage 1 of the complete reflow.
  // Every ink-bearing class is inventoried BEFORE note placement and checked
  // AFTER the attachment passes. This detects the architectural hole where a
  // native span can survive at obsolete coordinates even when all notes map.
  // Do not mistake this coverage audit for proof of musical/scan correctness.
  const universalNamedClasses=new Set([
    'mNum','note','chord','rest','clef','keySig','keyAccid','meterSig',
    'accid','dots','stem','flag','beam','tuplet','tupletNum','arpeg',
    'artic','fermata','ornam','trill','dir','dynam','tempo','harm','lyric',
    'reh','slur','tie','wedge','hairpin','octave','octaveShift','ottava',
    'pedal','gliss','glissando','breath','caesura','space','barLine',
    'staff','layer','ledgerLines','notehead','multiRest','repeatMark',
    'ending','bracketSpan','phrase','mordent','trillMark','tupletBracket',
    'bTrem','mRest'
  ]);
  const universalIndependent=new Set([
    'mNum','clef','keySig','meterSig','arpeg','tuplet','artic','fermata',
    'ornam','trill','dir','dynam','tempo','harm','lyric','reh',
    'slur','tie','wedge','hairpin','octave','octaveShift','ottava',
    'pedal','gliss','glissando','breath','caesura','repeatMark','ending',
    'bracketSpan','phrase','mordent','trillMark'
  ]);
  const universalSpans=new Set([
    'slur','tie','wedge','hairpin','octave','octaveShift','ottava',
    'pedal','gliss','glissando','ending','bracketSpan','phrase'
  ]);
  function beginUniversalCoverage(svg){
    const measures=$(svg,'g.measure');
    const scan=image.getBoundingClientRect();
    const native=measures.map(m=>{
      const r=m.getBoundingClientRect();return {left:r.left,right:r.right};
    });
    const target=(latest.barlines||[]).map(f=>scan.left+f*scan.width);
    if(target.length!==measures.length+1)throw Error('Universal layout audit: measure anchor count mismatch');
    const rows=[];
    const measureIndex=new Map(measures.map((m,i)=>[m,i]));
    // Inventory all named groups (including nested symbols) and independent
    // roots. Graphics not classified by any known parent remain observable.
    for(const node of $(svg,'g.measure g')){
      const measure=node.closest('g.measure'),mi=measureIndex.get(measure);
      if(mi===undefined)continue;
      const cls=(node.getAttribute('class')||'').split(/\s+/)[0];
      if(!cls)continue;
      const r=node.getBoundingClientRect();
      rows.push({node,cls,mi,x:r.left,y:r.top,w:r.width,h:r.height,
        independent:universalIndependent.has(cls)&&!node.parentElement?.closest(
          'g.note,g.chord,g.rest,g.beam,g.tuplet,g.slur,g.tie,g.fermata,g.dir,g.dynam,g.artic,g.ornam,g.harm,g.keySig,g.meterSig,g.clef,g.octave,g.pedal,g.gliss,g.ending')});
    }
    const primitives=$(svg,'g.measure path, g.measure line, g.measure rect, g.measure polygon, g.measure polyline, g.measure use, g.measure text, g.measure circle, g.measure ellipse')
      .filter(n=>!n.closest('defs'));
    const primitiveClasses=new Map();
    for(const n of primitives){
      const owner=n.closest('g[class]');const name=(owner?.getAttribute('class')||'').split(/\s+/)[0]||'(unclassified)';
      primitiveClasses.set(name,(primitiveClasses.get(name)||0)+1);
    }
    return {rows,native,target,primitiveClasses,scanWidth:scan.width};
  }
  // SEMANTIC-ANCHOR REFLOW, stage 2. Native dynamics and printed words are
  // independent SVG groups; they MUST receive the same source-time displacement
  // as their corresponding notes, not retain an unrelated Verovio x position.
  // Instead of assigning the nearest graphical note, use the source MusicXML
  // rhythmic cursor and original -> final event coordinates for the same STAFF.
  // Strict one-to-one direction ownership and a bounded final measure are
  // prerequisites. Ambiguities are left visible and recorded for review.
  function reflowSourceTimedIndependentDirections(svg,snapshot){
    const xml=xmlMeasures(),measures=$(svg,'g.measure');
    const first=Number(latest.first),scan=image.getBoundingClientRect();
    const target=(latest.barlines||[]).map(v=>scan.left+scan.width*v);
    const gap=Number(latest.scanStaffSpacePx||17)*scan.width/
      (image.naturalWidth||latest.scanWidthPx||2300)*staffSizeFactor;
    const report={matched:0,moved:0,stationaryVerified:0,preexistingVerified:0,
      ambiguous:[],sourceDirectionCounts:0};
    // The 74 immutable landmark systems are from these four initial pieces.
    // Their already-approved geometry must not be altered by this new pilot.
    const protectedPieces=new Set(['the-christmas-song','christmas-time-is-here',
      'frosty-the-snowman','have-yourself-a-merry-little-christmas']);
    if(protectedPieces.has(latest.pieceSlug))return report;
    if(!snapshot||xml.length!==measures.length||target.length!==measures.length+1)return report;
    const native=new Map(snapshot.rows.map(e=>[e.node,e]));
    const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
    for(let mi=0;mi<xml.length;mi++){
      const source=xml[mi],notes=[],directions=[];
      let cursor=0,previousOnset=0,ni=0;
      for(const child of source.children){
        if(child.localName==='backup')cursor-=Number(localContent(child,'duration','0'))||0;
        else if(child.localName==='forward')cursor+=Number(localContent(child,'duration','0'))||0;
        else if(child.localName==='note'){
          const chord=directChildren(child,'chord').length>0;
          const onset=chord?previousOnset:cursor;
          const id=`p0-m${first+mi}-n${ni++}`;
          const before=preAlignmentHeadBoxes.get(id),after=mapped.get(id);
          if(before && after?.isConnected){
            const rect=headRect(after);
            const originalX=(before.left+before.right)/2;
            const newX=(rect.left+rect.right)/2;
            if(Number.isFinite(originalX)&&Number.isFinite(newX))
              notes.push({time:onset,staff:localContent(child,'staff','1'),
                oldX:originalX,newX,dx:newX-originalX,id});
          }
          if(!chord){previousOnset=onset;cursor+=Number(localContent(child,'duration','0'))||0;}
        }else if(child.localName==='direction'){
          const type=directChildren(child,'direction-type')[0];
          const dynamic=!!type?.querySelector('dynamics');
          const word=normalize(type?.querySelector('words')?.textContent);
          if(dynamic||word)directions.push({time:cursor+(Number(localContent(child,'offset','0'))||0),
            staff:localContent(child,'staff','1'),dynamic,word});
        }
      }
      if(!notes.length||!directions.length)continue;
      const topLevel=sel=>$(measures[mi],sel).filter(g=>g.closest('g.measure')===measures[mi]&&
        !g.parentElement?.closest(sel));
      const dynamicGlyphs=topLevel('g.dynam');
      const nativeWords=topLevel('g.dir');
      const used=new Set();
      for(const sourceDirection of directions){
        let candidates=[];
        if(sourceDirection.dynamic){
          // A printed dynamic glyph normally has no textContent. Match only
          // against unclaimed glyphs, retaining MusicXML/DOM direction order.
          candidates=dynamicGlyphs.filter(g=>!used.has(g)&&!normalize(g.textContent));
        }else{
          // 'dim.' and 'cresc.' are g.dynam in Verovio; other words are g.dir.
          candidates=[...dynamicGlyphs,...nativeWords].filter(g=>
            !used.has(g)&&normalize(g.textContent)===sourceDirection.word);
        }
        // Repeated words require native DOM ordering; refuse a cross-class or
        // unrecognized text match rather than silently guessing source owners.
        if(!candidates.length){
          report.ambiguous.push({measure:first+mi+1,type:'unmatched-direction',
            word:sourceDirection.word||'(dynamic)'});continue;
        }
        const glyph=candidates[0];used.add(glyph);
        const before=native.get(glyph),r=glyph.getBoundingClientRect();
        if(!before||!(before.w>1&&before.h>1)||!(r.width>1&&r.height>1))continue;
        const staffNotes=notes.filter(n=>n.staff===sourceDirection.staff);
        if(!staffNotes.length){
          report.ambiguous.push({measure:first+mi+1,type:'no-source-staff-anchor',
            word:sourceDirection.word||'(dynamic)'});continue;
        }
        const distinct=[...new Set(staffNotes.map(n=>n.time))].sort((a,b)=>a-b)
          .map(time=>{
            const at=staffNotes.filter(n=>n.time===time);
            // Median is stable even for chord tones and simultaneous voices.
            const shifts=at.map(n=>n.dx).sort((a,b)=>a-b);
            return {time,dx:shifts[Math.floor(shifts.length/2)]};
          });
        const t=sourceDirection.time;
        const exact=distinct.find(n=>Math.abs(n.time-t)<1e-7);
        const beforeTime=[...distinct].reverse().find(n=>n.time<t),
          afterTime=distinct.find(n=>n.time>t);
        const shift=exact?.dx??(beforeTime&&afterTime
          ? beforeTime.dx+(afterTime.dx-beforeTime.dx)*(t-beforeTime.time)/(afterTime.time-beforeTime.time)
          : (beforeTime||afterTime)?.dx);
        if(!Number.isFinite(shift))continue;
        // The canonical source direction remains within its own measure.
        // Optical text can extend slightly over an edge but may not be moved
        // wholesale across neighboring measures by an uncertain anchor.
        const expectedLeft=before.x+shift;
        if(expectedLeft<target[mi]-gap*2.5 ||
           expectedLeft>target[mi+1]+gap*2.5){
          report.ambiguous.push({measure:first+mi+1,type:'outside-source-measure',
            word:sourceDirection.word||'(dynamic)',shift:+shift.toFixed(2)});continue;
        }
        const existingMove=r.left-before.x;
        const tolerance=Math.max(.75,gap*.08);
        let state='already-reflowed';
        if(Math.abs(existingMove-shift)<=tolerance){
          report.preexistingVerified++;
        }else if(Math.abs(existingMove)<=tolerance){
          if(Math.abs(shift)<=tolerance){
            state='source-aligned-unchanged';report.stationaryVerified++;
          }else if(addTranslation(glyph,shift)){
            state='source-time-reflow';report.moved++;
          }else{
            report.ambiguous.push({measure:first+mi+1,type:'translation-failed'});continue;
          }
        }else{
          // An existing optical correction is NOT overwritten speculatively.
          report.ambiguous.push({measure:first+mi+1,type:'preexisting-optical-offset',
            word:sourceDirection.word||'(dynamic)',existingMove:+existingMove.toFixed(2),
            sourceShift:+shift.toFixed(2)});continue;
        }
        glyph.dataset.universalAnchor=state;
        glyph.dataset.sourceAnchorTime=String(t);
        glyph.dataset.sourceAnchorStaff=sourceDirection.staff;
        glyph.dataset.sourceAnchorDelta=shift.toFixed(3);
        report.matched++;
      }
      report.sourceDirectionCounts+=directions.length;
    }
    svg.dataset.universalTimedDirections=String(report.matched);
    svg.dataset.universalTimedDirectionsMoved=String(report.moved);
    window.PianoSemanticDirectionAudit=report;
    return report;
  }

  // SOURCE ENDPOINT INVENTORY, shared by ties and slurs. Source boundaries
  // are matched to SVG curves through ORIGINAL note locations (the geometry
  // in which Verovio emitted the native shapes), never through their currently
  // shifted x positions. A mismatch is recorded, never silently translated.
  function inspectSourceAnchoredSpans(svg,snapshot){
    const xml=xmlMeasures(),first=Number(latest.first),measures=$(svg,'g.measure');
    const gap=Number(latest.scanStaffSpacePx||17)*image.getBoundingClientRect().width/
      (image.naturalWidth||latest.scanWidthPx||2300)*staffSizeFactor;
    const report={sourceBoundaryEndpoints:0,visibleNativeTies:0,
      matchedBoundaryEndpoints:0,unmatchedBoundaryEndpoints:[],
      sourceSlurPairs:0,matchedSlurPairs:0,unmatchedSlurPairs:[]};
    if(!snapshot||!measures.length||!(gap>2))return report;
    const rows=snapshot.rows;
    const sourcePairs=sourceTiePairs();
    const alreadyPaired=new Set(sourcePairs.map(p=>p.startID));
    const matchedStops=new Set(sourcePairs.map(p=>p.endID));
    const endpoints=[];
    for(let mi=0;mi<xml.length;mi++){
      let ni=0;
      for(const note of directChildren(xml[mi],'note')){
        const id=`p0-m${first+mi}-n${ni++}`;
        const marks=directChildren(note,'tie').length?directChildren(note,'tie'):
          $(note,'notations > tied');
        const add=(kind)=>{
          const before=preAlignmentHeadBoxes.get(id),after=mapped.get(id);
          if(!before||!after?.isConnected)return;
          if(kind==='start'&&alreadyPaired.has(id))return;
          if(kind==='stop'&&matchedStops.has(id))return;
          endpoints.push({id,mi,kind,before,after});
        };
        // Cross-system boundaries only. Same-system curves are already
        // handled by reflowTies and grace slurs by reflowGraceSlurs.
        if(mi===xml.length-1&&marks.some(m=>m.getAttribute('type')==='start'))add('start');
        if(mi===0&&marks.some(m=>m.getAttribute('type')==='stop'))add('stop');
      }
    }
    report.sourceBoundaryEndpoints=endpoints.length;
    const candidates=rows.filter(e=>e.cls==='tie'&&e.w>2&&e.h>1&&
      e.node.isConnected&&getComputedStyle(e.node).visibility!=='hidden');
    report.visibleNativeTies=candidates.length;
    report.nativeTieEvidence=candidates.map(c=>{
      const ranks=endpoints.filter(e=>e.mi===c.mi).map(end=>{
        const noteY=(end.before.top+end.before.bottom)/2;
        const yGap=Math.abs(noteY-(c.y+c.h/2));
        const noteX=end.kind==='start'?end.before.right:end.before.left;
        const tieX=end.kind==='start'?c.x:c.x+c.w;
        const xGap=Math.abs(noteX-tieX);
        return {sourceEvent:end.id,side:end.kind,xGap:+xGap.toFixed(1),
          yGap:+yGap.toFixed(1),xStaffSpaces:+(xGap/gap).toFixed(2),
          yStaffSpaces:+(yGap/gap).toFixed(2)};
      }).sort((a,b)=>a.yStaffSpaces-b.yStaffSpaces||a.xStaffSpaces-b.xStaffSpaces);
      return {measure:first+c.mi+1,tieX:+c.x.toFixed(1),tieY:+c.y.toFixed(1),
        candidates:ranks.slice(0,3)};
    });
    const scored=[];
    for(const end of endpoints){
      for(const c of candidates){
        if(c.mi!==end.mi)continue;
        const centerY=(end.before.top+end.before.bottom)/2;
        const tieY=c.y+c.h/2;
        const dy=Math.abs(centerY-tieY);
        const targetX=end.kind==='start'?end.before.right:end.before.left;
        const shapeX=end.kind==='start'?c.x:c.x+c.w;
        const dx=Math.abs(targetX-shapeX);
        // Original native tie must visibly belong to this original note.
        // A wide bracket, a grace slur or an unrelated tie is not accepted.
        if(dy>gap*1.35||dx>gap*3.2)continue;
        scored.push({end,c,score:dy/gap+dx/gap*.28});
      }
    }
    scored.sort((a,b)=>a.score-b.score);
    const claimedNative=new Set(),claimedSource=new Set();
    for(const x of scored){
      if(claimedNative.has(x.c.node)||claimedSource.has(x.end.id))continue;
      // Require a second independent candidate to be distinctly worse,
      // otherwise a chord's identical tie layers can be interchanged.
      const competitors=scored.filter(z=>!claimedNative.has(z.c.node)&&
        !claimedSource.has(z.end.id)&&
        (z.end.id===x.end.id||z.c.node===x.c.node));
      if(competitors.length>1 && competitors[1].score-x.score<.32)continue;
      claimedNative.add(x.c.node);claimedSource.add(x.end.id);
      const evidence={event:x.end.id,measure:first+x.end.mi+1,
        side:x.end.kind,sourceOriginalGap:+(x.score).toFixed(3),nativeId:x.c.node.id||''};
      // This is VERIFIED OWNERSHIP, not yet verified curved geometry.
      // Preserve the native shape until its endpoint reconstruction is proven.
      x.c.node.dataset.sourceTieCandidate=x.end.id;
      report.matchedBoundaryEndpoints++;
    }
    for(const end of endpoints)if(!claimedSource.has(end.id))
      report.unmatchedBoundaryEndpoints.push({event:end.id,measure:first+end.mi+1,side:end.kind});
    // Count slur source start/stop pairs with exact source events. Collection
    // policy: only source grace-note slurs are expected; non-grace source slurs
    // receive explicit review, never indiscriminate native-path stretching.
    const pending=new Map(),pairs=[];
    for(let mi=0;mi<xml.length;mi++){
      let ni=0;
      for(const note of directChildren(xml[mi],'note')){
        const id=`p0-m${first+mi}-n${ni++}`;
        for(const sl of $(note,'notations > slur')){
          const key=localContent(note,'staff','1')+':'+
            localContent(note,'voice','1')+':'+(sl.getAttribute('number')||'1');
          if(sl.getAttribute('type')==='start')pending.set(key,{id,mi,
            grace:directChildren(note,'grace').length>0});
          if(sl.getAttribute('type')==='stop'&&pending.has(key)){
            const start=pending.get(key);pending.delete(key);
            pairs.push({...start,endID:id,stopMi:mi});
          }
        }
      }
    }
    report.sourceSlurPairs=pairs.length;
    const visibleSlurs=rows.filter(e=>e.cls==='slur'&&e.w>2&&e.h>1&&
      e.node.isConnected&&getComputedStyle(e.node).visibility!=='hidden');
    const claimedSlurs=new Set();
    for(const pair of pairs){
      const a=preAlignmentHeadBoxes.get(pair.id),b=preAlignmentHeadBoxes.get(pair.endID);
      if(!a||!b||pair.mi!==pair.stopMi){
        report.unmatchedSlurPairs.push({start:pair.id,end:pair.endID,reason:'cross-system-or-unmapped'});continue;
      }
      const midX=(a.right+b.left)/2,midY=(a.top+a.bottom+b.top+b.bottom)/4;
      const scores=visibleSlurs.filter(e=>e.mi===pair.mi&&!claimedSlurs.has(e.node))
        .map(e=>({e,score:Math.abs((e.x+e.w/2)-midX)/gap+
          Math.abs((e.y+e.h/2)-midY)/gap*.4})).sort((x,y)=>x.score-y.score);
      if(scores.length && scores[0].score<4 &&
        (scores.length===1||scores[1].score-scores[0].score>.32)){
        const found=scores[0].e;claimedSlurs.add(found.node);
        found.node.dataset.sourceSlurCandidate=pair.id;
        report.matchedSlurPairs++;
      }else report.unmatchedSlurPairs.push({start:pair.id,end:pair.endID,
        reason:pair.grace?'ambiguous-grace-curve':'unverified-non-grace-curve'});
    }
    window.PianoSemanticSpanAudit=report;
    return report;
  }

  function finishUniversalCoverage(svg,snapshot){
    if(!snapshot)return null;
    const space=Number(latest.scanStaffSpacePx||17)*snapshot.scanWidth/(image.naturalWidth||latest.scanWidthPx||2300)*staffSizeFactor;
    const counts={},outstanding=[],unclassified=[];
    let totalOutstanding=0;const outstandingByClass={};
    const measures=$(svg,'g.measure');
    for(const [cls,count] of snapshot.primitiveClasses){
      if(!universalNamedClasses.has(cls))unclassified.push({className:cls,primitiveCount:count});
    }
    for(const e of snapshot.rows){
      if(!e.node.isConnected)continue;
      counts[e.cls]=(counts[e.cls]||0)+1;
      if(!e.independent||!(e.w>1&&e.h>1))continue;
      if(getComputedStyle(e.node).visibility==='hidden'||getComputedStyle(e.node).display==='none')continue;
      const r=e.node.getBoundingClientRect();
      if(!(r.width>1&&r.height>1))continue;
      const original=snapshot.native[e.mi];
      const nw=original.right-original.left;
      const tw=snapshot.target[e.mi+1]-snapshot.target[e.mi];
      const measureChanged=Math.abs(nw-tw)>Math.max(5,space*.5) ||
        Math.abs(original.left-snapshot.target[e.mi])>Math.max(5,space*.5);
      if(!measureChanged)continue;
      const change=Math.hypot(r.left-e.x,r.top-e.y);
      if(change>Math.max(.6,space*.07))continue; // positioned or rebuilt elsewhere
      // Opening clefs/signatures may ALREADY occupy their correct scanned
      // opening zone. Their static location is not automatically a defect.
      const opening=e.mi===0&&['clef','keySig','meterSig'].includes(e.cls);
      if(opening&&r.left>=snapshot.target[0]-space*1.5 &&
         r.right<snapshot.target[1]-space*.3)continue;
      if(e.cls==='mNum' && e.mi===0 &&
        Math.abs(r.left-snapshot.target[0])<space*2.2)continue;
      const place=e.node.dataset.universalAnchor;
      if(place)continue;
      // A stationary symbol in an altered measure is a reflow REVIEW FLAG,
      // not something we conceal with an unverified generic x translation.
      totalOutstanding++;outstandingByClass[e.cls]=(outstandingByClass[e.cls]||0)+1;
      if(outstanding.length<100)outstanding.push({className:e.cls,measure:Number(latest.first)+e.mi+1,
        x:Math.round(r.left),targetL:Math.round(snapshot.target[e.mi]),
        targetR:Math.round(snapshot.target[e.mi+1]),span:universalSpans.has(e.cls)});
    }
    const result={pieceSlug:latest.pieceSlug,first:Number(latest.first),last:Number(latest.last),
      groups:snapshot.rows.length,graphics:[...snapshot.primitiveClasses.values()].reduce((a,b)=>a+b,0),
      classes:counts,unclassified,unchangedIndependents:outstanding,
      outstanding:totalOutstanding,outstandingByClass,unclassifiedTypes:unclassified.length,
      boundaryReflowed:Number(svg.dataset.universalTrailingSignatures||0),
      timedDirections:window.PianoSemanticDirectionAudit||null,
      sourceSpans:window.PianoSemanticSpanAudit||null};
    svg.dataset.universalCoverage='observed';
    svg.dataset.universalUnresolved=String(totalOutstanding);
    svg.dataset.universalUnclassified=String(unclassified.length);
    window.PianoUniversalLayoutAudit=result;
    return result;
  }
  // Source-driven boundary anchoring, shared across ALL pieces. A trailing
  // <attributes> after the LAST musical event is a courtesy change at the
  // closing barline, not a first-onset signature. Keep glyph proportions,
  // vertical position, and printed note coordinates unchanged.
  function reflowUniversalTrailingAttributes(svg){
    const source=xmlMeasures(),measureNodes=$(svg,'g.measure'),scan=image.getBoundingClientRect();
    const target=(latest.barlines||[]).map(f=>scan.left+f*scan.width);
    if(target.length!==source.length+1)return 0;
    const gap=Number(latest.scanStaffSpacePx||17)*scan.width/(image.naturalWidth||latest.scanWidthPx||2300)*staffSizeFactor;
    if(!(gap>2))return 0;
    let moved=0;
    for(let mi=0;mi<source.length;mi++){
      const children=[...source[mi].children];
      const lastSounding=Math.max(-1,...children.map((n,i)=>['note','backup','forward'].includes(n.localName)?i:-1));
      const trailing=children.filter((n,i)=>n.localName==='attributes'&&i>lastSounding);
      // Do not treat initial system attributes (or an empty first measure)
      // as courtesy signs at the right edge.
      if(lastSounding<0||!trailing.length)continue;
      for(const [kind,svgClass] of [['key','keySig'],['time','meterSig']]){
        if(!trailing.some(a=>directChildren(a,kind).length))continue;
        const staffs=staffGroups(measureNodes[mi]);
        if(staffs.length!==2)continue;
        const elements=[];
        for(const staff of staffs){
          const candidates=$(staff,'g.'+svgClass).filter(n=>n.closest('g.staff')===staff &&
            !n.parentElement?.closest('g.'+svgClass));
          // Avoid incorrectly moving a time/key change from the start.
          if(candidates.length!==1){elements.length=0;break;}
          elements.push(candidates[0]);
        }
        if(elements.length!==2)continue;
        const right=target[mi+1];
        const desired=right+gap*.28;
        // Courtesy signature is past the ending barline in the scan. It may
        // extend beyond the invisible system SVG page box; preserve overflow.
        const possible=elements.every((el,si)=>{
          const r=el.getBoundingClientRect(),notes=$(staffs[si],'g.note,g.rest')
            .filter(n=>n.closest('g.staff')===staffs[si]);
          const lastNote=Math.max(-Infinity,...notes.map(n=>headRect(n).right));
          return r.width>1&&r.width<gap*5 && Number.isFinite(desired) &&
            right-lastNote>gap*.35 && desired+r.width<scan.right+gap*7;
        });
        if(!possible)continue;
        for(const el of elements){
          const old=el.getBoundingClientRect();
          if(addTranslation(el,desired-old.left)){
            el.dataset.universalAnchor='trailing-'+kind;
            moved++;
          }
        }
      }
      // A staff-specific clef printed AFTER the last sounding event belongs
      // immediately before the closing boundary. It must not retain the glyph
      // supplier's old measure width, which can strand it outside the system.
      const staffs=staffGroups(measureNodes[mi]);
      for(const attribute of trailing)for(const clef of directChildren(attribute,'clef')){
        const number=Number(clef.getAttribute('number')||'1'),staff=staffs[number-1];
        if(!staff)continue;
        const candidates=$(staff,'g.clef').filter(n=>n.closest('g.staff')===staff&&!n.parentElement?.closest('g.clef'));
        if(candidates.length!==1)continue;
        const el=candidates[0],box=el.getBoundingClientRect();
        const desired=target[mi+1]-gap*.60-box.width;
        const lastNote=Math.max(-Infinity,...$(staff,'g.note,g.rest').map(n=>headRect(n).right));
        if(!(box.width>1&&box.width<gap*4&&desired>lastNote+gap*.35))continue;
        if(addTranslation(el,desired-box.left)){el.dataset.universalAnchor='trailing-clef';moved++;}
      }
    }
    svg.dataset.universalTrailingSignatures=String(moved);
    return moved;
  }

  // POSITIONING ENGINE V21
  // A fresh Verovio SVG is mapped onto a single immutable coordinate plan.
  // Musical objects move exactly once. Decorations are then constructed from
  // that plan; no subsequent pass modifies a note or a scan barline.
  const positionFromOriginalMusicXML=window.PianoSourceLayout.create(engravingContext);

  // Verovio stores ties as standalone measure-level SVG paths. Repositioning
  // note/chord groups using MusicXML default-x does NOT carry their ties along.
  // Internal and boundary ties share exact event identities; they are rebuilt
  // after every coordinate plan, including when native SVG curves are absent.
  const {sourceTiePairs,reflowTies,reflowFullScoreBoundaryTies}=
    window.PianoTieEngine.create(engravingContext);

  // A pedal bracket is an independent multi-measure SVG path in Verovio.
  // Once measure widths are calibrated, its original endpoints no longer
  // describe the printed span. Redraw only fully bounded MusicXML pedal-line
  // pairs; never stretch a native path, guess a missing stop, or alter notes.
  function reflowPedalBraces(svg){
    if(!latest?.barlines || !image.naturalWidth)return;
    const xml=xmlMeasures(),scan=image.getBoundingClientRect();
    if(latest.barlines.length!==xml.length+1 || !scan.width)return;
    const starts=new Map(),pairs=[];
    for(let mi=0;mi<xml.length;mi++){
      for(const direction of directChildren(xml[mi],'direction')){
        const staff=localContent(direction,'staff','1');
        for(const pedal of $(direction,'direction-type > pedal')){
          if(pedal.getAttribute('line')!=='yes')continue;
          const key=staff+':'+(pedal.getAttribute('number')||'1');
          const kind=pedal.getAttribute('type');
          if(kind==='start')starts.set(key,{mi,staff});
          if(kind==='stop' && starts.has(key)){
            const start=starts.get(key);starts.delete(key);
            if(mi>start.mi)pairs.push({start:start.mi,end:mi,staff});
          }
        }
      }
    }
    if(!pairs.length)return;
    const gap=Number(latest.scanStaffSpacePx)*scan.width/(image.naturalWidth||latest.scanWidthPx||2300)*staffSizeFactor;
    const bars=latest.barlines.map(x=>scan.left+x*scan.width);
    if(!(gap>3&&gap<90))return;
    const layer=createAnnotationLayer(svg,'pl-aligned-pedal-braces');
    let drawn=0;
    for(const span of pairs){
      const lastMeasure=$(svg,'g.measure')[span.end];
      const staff=staffGroups(lastMeasure)[Number(span.staff)-1];
      const lines=staff&&staffLineBox(staff);
      if(!lines)continue;
      const x1=bars[span.start]+gap*2.3;
      const x2=bars[span.end+1]-gap*2.5;
      const y=lines.bottom+gap*3.0;
      if(!(x2-x1>gap*8&&Number.isFinite(y)))continue;
      // Three-stroke pedal line: short descending entrance, horizontal brace,
      // and a short raised exit. Coordinates are in the final scan frame.
      const width=Math.max(.9,gap*.09);
      if(!drawAnnotationLine(svg,layer,x1,y-gap*.46,x1,y,width))continue;
      drawAnnotationLine(svg,layer,x1,y,x2,y,width);
      drawAnnotationLine(svg,layer,x2,y,x2,y-gap*.46,width);
      drawn++;
    }
    if(drawn===pairs.length){
      // Only hide the old Verovio spans after every pair was reconstructed.
      $(svg,'g.pedal').forEach(node=>node.style.visibility='hidden');
      svg.dataset.pedalBraces='scan-anchored';
      svg.dataset.pedalBracesCount=String(drawn);
      lastAttachmentReport+=` · ${drawn} pedal bracket(s) scan-positioned`;
    }else layer.remove();
  }

  // Frosty m99: the courtesy 4/4 is engraved at the far end of the native
  // Verovio system, outside the scan width. Its vertical register is correct,
  // but its x coordinate must be anchored just beyond the SCANNED closing
  // barline rather than to the obsolete Verovio staff box.
  function reflowFrostyCourtesyTime(svg){
    if(latest?.pieceSlug!=='frosty-the-snowman'||Number(latest.first)!==94||
       Number(latest.last)!==98||!latest.barlines?.length)return;
    const scan=image.getBoundingClientRect();
    const bar=scan.left+latest.barlines.at(-1)*scan.width;
    const gap=Number(latest.scanStaffSpacePx)*scan.width/(image.naturalWidth||latest.scanWidthPx||2300)*staffSizeFactor;
    const last=$(svg,'g.measure').at(-1);
    let moved=0;
    for(const staff of staffGroups(last)){
      const sig=staff.querySelector('g.meterSig');
      if(!sig)continue;
      const box=sig.getBoundingClientRect();
      const x=bar+gap*.32;
      if(!(box.width>1&&x+box.width<=scan.right+gap*1.5))continue;
      if(addTranslation(sig,x-box.left))moved++;
    }
    if(moved===2){
      svg.dataset.frostyCourtesyTime='aligned-after-m99';
    }
  }

  function trimFrostyWarningRules(svg){
    if(latest?.pieceSlug!=='frosty-the-snowman'||![35,94].includes(Number(latest.first)))return;
    const scan=image.getBoundingClientRect(),bar=scan.left+latest.barlines.at(-1)*scan.width;
    const gap=Number(latest.scanStaffSpacePx)*scan.width/(image.naturalWidth||latest.scanWidthPx)*staffSizeFactor;
    const boxes=$(svg,'g.meterSig').map(n=>n.getBoundingClientRect()).filter(r=>r.width>1&&r.left>=bar-gap*.2);
    const matrix=staffRules.getScreenCTM();
    if(boxes.length!==2||!matrix)return;
    const right=Math.max(...boxes.map(r=>r.right))+gap*.25;
    const x=new DOMPoint(right,0).matrixTransform(matrix.inverse()).x;
    for(const line of staffRules.querySelectorAll('.pl-warning-staff-extension'))line.setAttribute('x2',String(x));
    staffRules.dataset.warningStaffExtension=String((right-bar)/Math.abs(matrix.a));
  }

  function extendBeginningWarningKey(svg){
    if(!((latest?.pieceSlug==='it-s-beginning-to-look-a-lot-like-christmas'&&Number(latest.first)===42)||(latest?.pieceSlug==='white-christmas'&&Number(latest.first)===17)))return;
    const scan=image.getBoundingClientRect(),bar=scan.left+latest.barlines.at(-1)*scan.width;
    const gap=Number(latest.scanStaffSpacePx)*scan.width/(image.naturalWidth||latest.scanWidthPx)*staffSizeFactor;
    const boxes=$(svg,'g.keySig').map(n=>n.getBoundingClientRect()).filter(r=>r.width>1&&r.left>=bar-gap*.2);
    const matrix=staffRules.getScreenCTM();if(boxes.length!==2||!matrix)return;
    const x=new DOMPoint(Math.max(...boxes.map(r=>r.right))+gap*.25,0).matrixTransform(matrix.inverse()).x;
    const lines=[...staffRules.querySelectorAll(':scope > line')].filter(n=>n.getAttribute('y1')===n.getAttribute('y2')&&!n.classList.contains('pl-ledger-line')).slice(0,10);
    for(const original of lines){const line=original.cloneNode(true);line.setAttribute('x1',original.getAttribute('x2'));line.setAttribute('x2',String(x));line.classList.add('pl-warning-key-extension');staffRules.appendChild(line);}
  }

  function finishRudolphWarningMeters(svg){
    if(!((latest?.pieceSlug==='rudolph-the-red-nosed-reindeer'&&[70,94].includes(Number(latest.first)))||(latest?.pieceSlug==='we-wish-you-the-merriest'&&Number(latest.first)===53)))return;
    const scan=image.getBoundingClientRect(),bar=scan.left+latest.barlines.at(-1)*scan.width;
    const gap=Number(latest.scanStaffSpacePx)*scan.width/(image.naturalWidth||latest.scanWidthPx)*staffSizeFactor;
    const matrix=staffRules.getScreenCTM();if(!matrix)return;
    const custom=Number(latest.first)===94||latest.pieceSlug==='we-wish-you-the-merriest';
    const boxes=custom?$(staffRules,'.pl-source-cross-system-courtesy').map(n=>n.getBoundingClientRect()):
      $(svg,'g.meterSig').map(n=>n.getBoundingClientRect()).filter(r=>r.width>1&&r.left>=bar-gap*.2);
    if(boxes.length!==(custom?1:2))return;
    const x=new DOMPoint(Math.max(...boxes.map(r=>r.right))+gap*.25,0).matrixTransform(matrix.inverse()).x;
    if(custom){for(const line of staffRules.querySelectorAll('.pl-cross-system-courtesy-extension')){line.setAttribute('x2',String(x));line.classList.add('pl-rudolph-warning-extension');}}
    else{
      const lines=[...staffRules.querySelectorAll(':scope > line')].filter(n=>n.getAttribute('y1')===n.getAttribute('y2')&&!n.classList.contains('pl-ledger-line')).slice(0,10);
      for(const original of lines){const line=original.cloneNode(true);line.setAttribute('x1',original.getAttribute('x2'));line.setAttribute('x2',String(x));line.classList.add('pl-rudolph-warning-extension');staffRules.appendChild(line);}
    }
  }

  // Collection-wide accidental clearance for source-identified grace pairs.
  // A grace head, slash, stem and its accidental are one engraved unit; when
  // its destination chord has an accidental, scan-aligned placement can put
  // the grace unit on top of that accidental. Slide ONLY the whole grace
  // glyph left (before reconstructing its slur), retaining the destination,
  // its accidental and all notehead/staff coordinates unchanged. If there is
  // not enough space before the calibrated measure boundary, leave the
  // remainder explicitly flagged rather than crossing the barline.
  function clearGraceMainAccidentalCollisions(svg){
    if(!latest?.barlines?.length || !image.naturalWidth)return 0;
    // These four pieces have separately approved source-aligned landmarks.
    // Their renderer geometry must remain completely unchanged by this pass.
    if(['the-christmas-song','christmas-time-is-here',
      'frosty-the-snowman','have-yourself-a-merry-little-christmas'].includes(latest.pieceSlug))return 0;
    const ms=xmlMeasures(),first=Number(latest.first),scan=image.getBoundingClientRect();
    if(latest.barlines.length!==ms.length+1)return 0;
    const space=Number(latest.scanStaffSpacePx||17)*scan.width/
      (image.naturalWidth||latest.scanWidthPx||2300)*staffSizeFactor;
    if(!(Number.isFinite(space)&&space>2))return 0;
    const minGap=Math.max(.65,space*.12);
    const barGap=Math.max(.55,space*.065);
    let moved=0,partial=0;
    for(let mi=0;mi<ms.length;mi++){
      const pending=new Map();let ni=0;
      const boundary=scan.left+latest.barlines[mi]*scan.width;
      for(const note of directChildren(ms[mi],'note')){
        const id=`p0-m${first+mi}-n${ni++}`;
        const prefix=`${localContent(note,'staff','1')}:${localContent(note,'voice','1')}:`;
        for(const slur of $(note,'notations > slur')){
          const key=prefix+(slur.getAttribute('number')||'1');
          if(slur.getAttribute('type')==='start'){
            pending.set(key,{id,isGrace:directChildren(note,'grace').length>0});
            continue;
          }
          if(slur.getAttribute('type')!=='stop'||!pending.has(key))continue;
          const start=pending.get(key);pending.delete(key);
          if(!start.isGrace)continue;
          const a=mapped.get(start.id),b=mapped.get(id);
          if(!a?.isConnected||!b?.isConnected)continue;
          const grace=a.closest('g.chord')||a,main=b.closest('g.chord')||b;
          if(grace===main||grace.closest('g.measure')!==main.closest('g.measure') ||
            grace.closest('g.staff')!==main.closest('g.staff'))continue;
          const r=grace.getBoundingClientRect();
          const accidentals=$(main,'g.accid').map(n=>n.getBoundingClientRect())
            .filter(x=>x.width>1&&x.height>1&&Number.isFinite(x.left));
          if(!accidentals.length || !(r.width>1&&Number.isFinite(r.right)))continue;
          const accidentLeft=Math.min(...accidentals.map(x=>x.left));
          const need=r.right+minGap-accidentLeft;
          if(!(need>.35))continue;
          // Do not drag the grace note past the barline or an earlier
          // sounding note in the same staff and measure.
          let room=Math.max(0,r.left-(boundary+barGap));
          for(const other of $(grace.closest('g.staff'),'g.note,g.rest')){
            const owner=other.closest('g.chord')||other;
            if(owner===grace||owner===main ||
              owner.closest('g.measure')!==grace.closest('g.measure'))continue;
            const q=owner.getBoundingClientRect();
            if(q.width>1&&q.right<=r.left&&q.right>=boundary &&
              q.bottom>r.top&&q.top<r.bottom)
              room=Math.min(room,Math.max(0,r.left-q.right-minGap));
          }
          const shift=Math.min(need,room,space*3);
          if(!(shift>.35)||!addTranslation(grace,-shift)){
            partial++;continue;
          }
          const residual=Math.max(0,need-shift);
          grace.dataset.graceAccidentalClearance=shift.toFixed(2);
          grace.dataset.graceAccidentalResidual=residual.toFixed(2);
          moved++;
          if(residual>.55)partial++;
        }
      }
    }
    svg.dataset.graceAccidentalClearances=String(moved);
    svg.dataset.graceAccidentalUnresolved=String(partial);
    if(moved||partial)lastAttachmentReport+=` · ${moved} grace/accidental clearances, ${partial} constrained`;
    return moved;
  }

  // Scan-reviewed New Year's Eve grace groups need room after the key or
  // barline as well as before their destination whole note. Preserve each
  // onset's LH column when reserving that room; slurs and ledgers follow.
  function clearNewYearGraceOpenings(svg){
    if(latest?.pieceSlug!=='what-are-you-doing-new-year-s-eve')return;
    const first=Number(latest.first),scan=image.getBoundingClientRect(),space=Number(latest.scanStaffSpacePx)*scan.width/(image.naturalWidth||latest.scanWidthPx)*staffSizeFactor;
    const reviewed=new Set([4,6,8,12,16,28,30,32,56]),events=window.PianoMusicSemantics.eventsFromXML(latest.xml,first),records=[];
    for(const [mi,m] of xmlMeasures().entries()){
      if(!reviewed.has(first+mi))continue;
      const notes=directChildren(m,'note');
      for(let ni=0;ni<notes.length;ni++){
        const n=notes[ni];if(!n.querySelector('grace')||localContent(n,'staff')!=='2')continue;
        const next=notes.findIndex((q,j)=>j>ni&&!q.querySelector('grace')&&localContent(q,'voice')===localContent(n,'voice')&&localContent(q,'staff')==='2');
        const g=mapped.get(`p0-m${first+mi}-n${ni}`),main=mapped.get(`p0-m${first+mi}-n${next}`);if(!g||!main)continue;
        const owner=main.closest('g.chord')||main,grace=g.closest('g.chord')||g;
        let safe=scan.left+latest.barlines[mi]*scan.width+space*.45;
        if(mi===0){for(const sig of $(grace.closest('g.staff'),'g.clef,g.keySig')){const r=sig.getBoundingClientRect();if(r.width>1)safe=Math.max(safe,r.right+space*.4);}}
        const old=grace.getBoundingClientRect();if(old.left<safe)addTranslation(grace,safe-old.left);
        const r=grace.getBoundingClientRect(),h=headRect(main),delta=Math.max(0,r.right+space*.35-h.left);
        if(delta){const e=events.find(e=>e.id===`p0-m${first+mi}-n${next}`),owners=new Set([owner]);for(const other of events){if(other.measure===first+mi&&other.staff==='2'&&Math.abs(other.onset-e.onset)<1e-7){const el=mapped.get(other.id);if(el)owners.add(el.closest('g.chord')||el);}}for(const o of owners)addTranslation(o,delta);}
        grace.dataset.scanGraceClearance='verified';records.push({grace:`p0-m${first+mi}-n${ni}`,main:`p0-m${first+mi}-n${next}`,safe,shift:delta});
      }
    }
    if(first===40){
      const grace=mapped.get('p0-m40-n3'),main=mapped.get('p0-m40-n4');
      if(grace&&main){const r=grace.getBoundingClientRect(),h=headRect(main);addTranslation(grace,h.left-space*.3-r.right);}
    }
    window.PianoNewYearGraceAudit=records;
  }

  // Grace-note slurs use the final scan-aligned notehead positions. Old
  // Verovio slurs are standalone measure children and do not follow notes
  // when their x coordinates are reflowed.
  function reflowGraceSlurs(svg){
    if(!latest)return;
    const xml=xmlMeasures(),first=Number(latest.first)||0;
    const pairs=[],pending=new Map();
    for(let mi=0;mi<xml.length;mi++){
      let ni=0;
      for(const note of directChildren(xml[mi],'note')){
        const id=`p0-m${first+mi}-n${ni++}`;
        const keyPrefix=`${localContent(note,'staff','1')}:${localContent(note,'voice','1')}:`;
        for(const sl of $(note,'notations > slur')){
          const key=keyPrefix+(sl.getAttribute('number')||'1');
          if(sl.getAttribute('type')==='start')pending.set(key,{id,mi,grace:!!directChildren(note,'grace').length,placement:sl.getAttribute('placement')});
          else if(sl.getAttribute('type')==='stop' && pending.has(key)){
            const start=pending.get(key);pending.delete(key);
            if(start.grace && start.mi===mi)pairs.push({...start,endID:id});
          }
        }
      }
    }
    // MusicXML voices are serialized in streams separated by <backup>. A
    // slur stop in voice 1 may therefore precede a grace-slur start in voice
    // 2 in document order. In the scan for New Year's Eve m27, there is ONE
    // below-placed grace arc from G#4 to the following A4 chord tone, but the
    // two source slur numbers (1/6) both stop on an EARLIER A4 in voice 1.
    // Neither source stop is a valid musical endpoint. Recover the single
    // scan-verified grace arc through the same universal endpoint reflow as
    // normal grace slurs, without editing canonical MusicXML or hiding native
    // slurs belonging to other measures. Reject this case if any of its exact
    // source semantics drift; do not generalize backwards slur tags blindly.
    if(latest.pieceSlug==='what-are-you-doing-new-year-s-eve'&&first===24){
      const measure=xml[2],notes=measure&&directChildren(measure,'note');
      const grace=notes?.[9],chord=notes?.[11],early=notes?.[1],firstTone=notes?.[10];
      const pitch=n=>{
        const p=n?.querySelector('pitch');
        return p?`${localContent(p,'step','')}:${localContent(p,'alter','0')}:${localContent(p,'octave','')}`:'';
      };
      const marks=(n,type)=>$(n,'notations > slur').filter(x=>x.getAttribute('type')===type)
        .map(x=>x.getAttribute('number')||'1').sort().join(',');
      if(measure?.getAttribute('number')==='27'&&notes.length===18&&
         !!grace?.querySelector('grace')&&pitch(grace)==='G:1:4'&&
         localContent(grace,'voice','')==='2'&&localContent(grace,'staff','')==='1'&&
         !grace.hasAttribute('default-x')&&marks(grace,'start')==='1,6'&&
         $(grace,'notations > slur').some(x=>x.getAttribute('number')==='6'&&x.getAttribute('placement')==='below')&&
         !!chord?.querySelector('chord')&&pitch(chord)==='A:0:4'&&
         localContent(chord,'voice','')==='2'&&localContent(chord,'staff','')==='1'&&
         chord.getAttribute('default-x')==='143'&&
         pitch(firstTone)==='F:0:4'&&localContent(firstTone,'voice','')==='2'&&
         pitch(early)==='A:0:4'&&localContent(early,'voice','')==='1'&&
         marks(early,'stop')==='1,6'){
        pairs.push({id:'p0-m26-n9',endID:'p0-m26-n11',mi:2,grace:true,
          placement:'below',recovery:'scan-verified-inverted-source-slur'});
      }else{
        svg.dataset.scanGraceRecovery='source-signature-not-matched';
      }
    }
    if(!pairs.length)return;
    const originals=$(svg,'g.slur'),measures=$(svg,'g.measure');
    const drawing=svg.querySelector('svg.definition-scale')||svg;
    const ctm=drawing.getScreenCTM();if(!ctm)return;
    const inv=ctm.inverse(),ns='http://www.w3.org/2000/svg';
    const space=latest.reviewMode==='draft'?staffHeightPixels(svg)/4:Number(latest.scanStaffSpacePx)*image.getBoundingClientRect().width/
      (image.naturalWidth||latest.scanWidthPx||2300)*staffSizeFactor;
    if(!Number.isFinite(space)||space<2)return;
    const layer=document.createElementNS(ns,'g');
    layer.setAttribute('class','pl-grace-slurs');
    layer.setAttribute('fill','currentColor');
    const point=(x,y)=>new DOMPoint(x,y).matrixTransform(inv);
    const fmt=p=>`${p.x.toFixed(3)} ${p.y.toFixed(3)}`;
    let repaired=0;
    const claimed=new Set();
    for(const pair of pairs){
      const from=mapped.get(pair.id),to=mapped.get(pair.endID);
      if(!from?.isConnected||!to?.isConnected)continue;
      const a=headRect(from),b=headRect(to);
      const x1=a.right-space*.12,x2=b.left+space*.22;
      if(!(x2-x1>space*.28))continue;
      // A grace slur's MusicXML placement remains authoritative after scan alignment.
      // The previous renderer incorrectly forced ALL aligned grace slurs above.
      const below=pair.placement==='below';
      const y1=below?a.bottom-space*.05:a.top+space*.05,y2=below?b.bottom-space*.05:b.top+space*.05;
      const rise=Math.min(space*1.25,Math.max(space*.62,(x2-x1)*.13));
      const c1=x1+(x2-x1)*.26,c2=x1+(x2-x1)*.75;
      const thick=latest.reviewMode==='draft'?Math.max(.55,space*.10):Math.max(1.35,space*.185);
      const p1=point(x1,y1),p2=point(x2,y2);
      const curve=below?Math.max(y1,y2)+rise:Math.min(y1,y2)-rise;
      const inner=curve+(below?-thick:thick);
      const q1=point(c1,curve),q2=point(c2,curve);
      const r2=point(c2,inner),r1=point(c1,inner);
      const path=document.createElementNS(ns,'path');
      path.setAttribute('d',`M${fmt(p1)} C${fmt(q1)} ${fmt(q2)} ${fmt(p2)} C${fmt(r2)} ${fmt(r1)} ${fmt(p1)} Z`);
      path.setAttribute('data-start-event',pair.id);
      path.setAttribute('data-end-event',pair.endID);
      path.setAttribute('data-source-placement',below?'below':'above');
      if(pair.recovery){
        path.setAttribute('data-scan-verified-recovery',pair.recovery);
        svg.dataset.scanGraceRecovery=pair.recovery;
      }
      layer.appendChild(path);
      // Verovio can emit several zero-geometry placeholder slurs alongside a
      // single visible curve. Claiming the first/closest placeholder leaves
      // that original curve on the obsolete x coordinates. Only a REAL ink-
      // bearing native slur may be hidden after its source grace arc is rebuilt.
      const candidates=originals.filter(x=>{
        if(x.closest('g.measure')!==measures[pair.mi]||claimed.has(x))return false;
        const r=x.getBoundingClientRect();
        return r.width>1&&r.height>1&&getComputedStyle(x).visibility!=='hidden';
      });
      if(candidates.length){
        // Match against the OLD Verovio notehead positions, i.e. the
        // coordinate system in which the original slur was engraved. When
        // two acciaccature occur in one measure, first-unclaimed is wrong.
        const oldA=preAlignmentHeadBoxes.get(pair.id);
        const oldB=preAlignmentHeadBoxes.get(pair.endID);
        const centerX=oldA&&oldB?(oldA.right+oldB.left)/2:null;
        const centerY=oldA&&oldB?(oldA.top+oldA.bottom+oldB.top+oldB.bottom)/4:null;
        const ranked=candidates.map(node=>{
          const r=node.getBoundingClientRect();
          const x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;
          const score=Number.isFinite(centerX)&&Number.isFinite(centerY)?
            Math.abs(x-centerX)+Math.abs(y-centerY)*.5:0;
          return {node,score};
        }).sort((a,b)=>a.score-b.score);
        const chosen=ranked[0].node;
        claimed.add(chosen);chosen.style.visibility='hidden';
        path.setAttribute('data-original-slur-id',chosen.id||'unidentified');
      }
      repaired++;
    }
    if(repaired){drawing.appendChild(layer);lastAttachmentReport+=` · ${repaired} grace slurs repositioned`;}
  }

  // Three-stroke tremolos are a *music-font glyph*, not three hand-built
  // quadrilaterals. This contour is Noto Music's Unicode U+1D169 (combining
  // tremolo 3), extracted as an SVG outline under SIL OFL 1.1; see
  // README-V38.md. The exact glyph is used without changing its proportions.
  // Apply only one uniform scale and one translation after note relocation.
  // The source XML continues to encode <tremolo type="single">3</tremolo>.
  // These are the exact three Noto Music glyph contours, individually
  // shifted on the font-y axis (+65/0/-65 units). This restores the visible
  // air between the ink-boosted slashes; no new strokes are drawn, and the
  // font's 298-unit glyph width and diagonal angles remain unmodified.
  // Reconstruct EVERY source-encoded three-stroke single-note tremolo from
  // its FINAL notehead/stem, regardless of piece or measure. The earlier
  // Christmas-Time-only routine left other arrangements' tremolo glyphs in
  // their obsolete Verovio coordinate space after scan alignment.
  //
  // A canonical MusicXML <tremolo type="single">3</tremolo> is the only
  // supported predicate. No inferred tremolos or source edits are made.
  // Unmapped or ambiguous events remain visible in the old engraving and
  // are explicitly audited, not silently dropped.
  const THREE_STROKE_FONT_GLYPH='M50 704V780L348 933V857ZM50 513V589L348 742V666ZM50 322V398L348 551V475Z';
  function reflowFinalTremolos(svg){
    const ms=xmlMeasures(),first=Number(latest?.first)||0;
    const drawing=svg.querySelector('svg.definition-scale')||svg;
    const ctm=drawing.getScreenCTM();if(!ctm)return;
    const inv=ctm.inverse(),ns='http://www.w3.org/2000/svg';
    const space=Number(latest.scanStaffSpacePx||17)*image.getBoundingClientRect().width/
      (image.naturalWidth||latest.scanWidthPx||2300)*staffSizeFactor;
    if(!Number.isFinite(space)||space<3)return;
    const layer=document.createElementNS(ns,'g');
    layer.setAttribute('class','pl-font-tremolos');
    layer.setAttribute('data-engraving-scope','all-source-systems');
    layer.setAttribute('fill','#111');
    const fmt=n=>Number(n.toFixed(6));
    let count=0,expected=0;const records=[],unresolved=[];
    for(let mi=0;mi<ms.length;mi++){
      const notes=directChildren(ms[mi],'note');
      for(let ni=0;ni<notes.length;ni++){
        const note=notes[ni],ornament=note.querySelector('notations > ornaments > tremolo');
        if(!ornament)continue;
        const sourceId=`p0-m${first+mi}-n${ni}`;
        const kind=ornament.getAttribute('type');
        const strokes=ornament.textContent.trim();
        if(kind!=='single'||strokes!=='3'){
          unresolved.push({sourceId,reason:`unsupported tremolo ${kind||'none'}/${strokes}`});
          continue;
        }
        expected++;
        const el=mapped.get(sourceId);
        const owner=el?.closest('g.chord')||el;
        if(!owner){unresolved.push({sourceId,reason:'source note not mapped'});continue;}
        const heads=($(owner,'g.note').length?$(owner,'g.note').map(headRect):[headRect(owner)])
          .filter(r=>r.width>0&&r.height>0);
        if(!heads.length){unresolved.push({sourceId,reason:'no visible notehead'});continue;}
        const up=localContent(note,'stem',localContent(note,'staff','1')==='1'?'up':'down')==='up';
        const tremWrapper=owner.closest('g.bTrem');
        const stem=owner.querySelector('g.stem path, g.stem line, g.stem rect')||
          tremWrapper?.querySelector('g.stem path, g.stem line, g.stem rect');
        const r=stem?.getBoundingClientRect();
        const hasStem=r&&r.height>space*1.25;
        const x=hasStem?(r.left+r.right)/2:
          (up?Math.max(...heads.map(h=>h.right))-.08*space:
            Math.min(...heads.map(h=>h.left))+.08*space);
        const headEdge=up?Math.min(...heads.map(h=>h.top)):
          Math.max(...heads.map(h=>h.bottom));
        const tipY=hasStem?(up?r.top:r.bottom):headEdge+(up?-2.5:2.5)*space;
        const pose=window.PianoLayoutGeometry?.threeStrokeGlyphPose?.(x,tipY,space,up);
        if(!pose){unresolved.push({sourceId,reason:'no validated glyph pose'});continue;}
        const {scale:glyphScale,x0,y0}=pose;
        const a=inv.a*glyphScale,b=inv.b*glyphScale;
        const c=-inv.c*glyphScale,d=-inv.d*glyphScale;
        const e=inv.a*x0+inv.c*y0+inv.e;
        const f=inv.b*x0+inv.d*y0+inv.f;
        if(![a,b,c,d,e,f].every(Number.isFinite)){
          unresolved.push({sourceId,reason:'nonfinite glyph transform'});continue;
        }
        const glyph=document.createElementNS(ns,'path');
        glyph.setAttribute('d',THREE_STROKE_FONT_GLYPH);
        glyph.setAttribute('transform',`matrix(${[a,b,c,d,e,f].map(fmt).join(' ')})`);
        const inkBoost=window.PianoLayoutGeometry?.tremoloInkBoostPx?.(space)||2;
        glyph.setAttribute('stroke','#111');
        glyph.setAttribute('stroke-width',String(fmt(inkBoost/glyphScale)));
        glyph.setAttribute('stroke-linejoin','round');
        glyph.setAttribute('paint-order','stroke fill');
        glyph.setAttribute('data-native-engraving-glyph','U+1D169');
        glyph.setAttribute('data-source-tremolo-event',sourceId);
        glyph.setAttribute('data-ink-boost-screen-px',String(fmt(inkBoost)));
        layer.appendChild(glyph);
        const stemless=latest.pieceSlug==='we-wish-you-the-merriest'&&[91,92].includes(first+mi)&&localContent(note,'type')==='whole';
        if(stemless)glyph.dataset.sourceStemlessTremolo='true';
        if(!hasStem&&!stemless){
          const p1=new DOMPoint(x,headEdge).matrixTransform(inv);
          const p2=new DOMPoint(x,tipY).matrixTransform(inv);
          const stemLine=document.createElementNS(ns,'path');
          stemLine.setAttribute('d',`M${fmt(p1.x)} ${fmt(p1.y)} L${fmt(p2.x)} ${fmt(p2.y)}`);
          stemLine.setAttribute('fill','none');stemLine.setAttribute('stroke','#111');
          stemLine.setAttribute('stroke-width',String(fmt(Math.max(1,space*.09)/(Math.hypot(ctm.a,ctm.b)||1))));
          layer.insertBefore(stemLine,glyph);
        }
        // Hide only the native tremolo contour, never its chord/notehead/
        // stem wrapper, and only AFTER a replacement glyph is constructed.
        const old=[...$(owner,'g.trem, g.tremolo'),
          ...(tremWrapper?$(tremWrapper,'g.trem, g.tremolo'):[]),
          // Verovio's SMuFL tremolo is ordinarily a bare <use> directly
          // inside g.bTrem, alongside its chord. Hiding the wrapper would
          // also erase notes; only the glyph itself may be retired.
          ...(tremWrapper?[...tremWrapper.children].filter(n=>n.localName==='use'):[])];
        for(const original of new Set(old))original.style.visibility='hidden';
        count++;
        records.push({sourceId,measureIndex:mi,staff:localContent(note,'staff','1'),
          stem:up?'up':'down',nativeReplaced:new Set(old).size,hasStem:!!hasStem});
      }
    }
    if(count){drawing.appendChild(layer);lastAttachmentReport+=` · ${count} source-anchored tremolos`;}
    if(unresolved.length){lastAttachmentReport+=` · ${unresolved.length} tremolo geometry review flags`;}
    svg.dataset.sourceTremoloExpected=String(expected);
    svg.dataset.sourceTremoloRendered=String(count);
    svg.dataset.sourceTremoloAudit=JSON.stringify({records,unresolved});
    window.PianoSourceTremoloAudit={piece:latest?.pieceSlug,first,count,expected,records,unresolved};
  }

  // Attach the existing LH fermata in m88 to the top B3 chord tone. Verovio's
  // original fermata is not a child of the note and can retain an obsolete
  // global position after all noteheads move. This translation preserves its
  // original outline, scale and musical semantics.
  function reflowFinalBassFermata(svg){
    if(latest?.pieceTitle!=='Christmas Time Is Here')return;
    const first=Number(latest.first)||0,mi=88-first-1;
    if(mi<0||mi>=xmlMeasures().length)return;
    const notes=directChildren(xmlMeasures()[mi],'note');
    const index=notes.findIndex(n=>localContent(n,'staff','1')==='2' &&
      localContent(n.querySelector('pitch'),'step','')==='B' &&
      localContent(n.querySelector('pitch'),'octave','')==='3' &&
      !!n.querySelector('notations > fermata'));
    if(index<0)return;
    const mappedNote=mapped.get(`p0-m${first+mi}-n${index}`);
    if(!mappedNote)return;
    const owner=mappedNote.closest('g.chord')||mappedNote;
    const tone=mappedNote.classList.contains('note')?mappedNote:
      $(owner,'g.note').find(n=>n.getAttribute('data-pname')==='b'&&n.getAttribute('data-oct')==='3');
    const head=headRect(tone||mappedNote);
    if(!head.width||!head.height)return;
    const measure=$(svg,'g.measure')[mi],staves=measure&&staffGroups(measure);
    const bass=staves?.[1];if(!bass)return;
    const candidates=$(measure,'g.fermata').filter(f=>f.getBoundingClientRect().width>0);
    const onBass=candidates.filter(f=>f.closest('g.staff')===bass);
    const trebleBox=staves[0].getBoundingClientRect(),bassBox=bass.getBoundingClientRect();
    const dividingY=(trebleBox.top+bassBox.top)*.5;
    // A measure-level fermata can sit *above* the bass staff rather than
    // inside its bounds; split the two staffs midway between their tops.
    const belowDividingLine=candidates.filter(f=>{
      const r=f.getBoundingClientRect();
      return (r.top+r.bottom)/2>dividingY;
    });
    const pool=onBass.length?onBass:(belowDividingLine.length?belowDividingLine:candidates);
    const targetCx=(head.left+head.right)/2;
    const glyph=pool.reduce((a,b)=>{
      const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();
      const score=r=>Math.abs((r.left+r.right)/2-targetCx)+
        .45*Math.abs((r.top+r.bottom)/2-head.top);
      return score(ra)<=score(rb)?a:b;
    });
    const r=glyph.getBoundingClientRect();
    const space=Number(latest.scanStaffSpacePx||17)*image.getBoundingClientRect().width/
      (image.naturalWidth||latest.scanWidthPx||2300)*staffSizeFactor;
    const dx=targetCx-(r.left+r.right)/2;
    const dy=head.top-Math.max(2,space*.31)-r.bottom;
    if(Number.isFinite(dx+dy)&&addTranslation(glyph,dx,dy))
      lastAttachmentReport+=' · LH fermata positioned above B3';
  }

  // The C-major change in m65 is semantically present in the source, but
  // Verovio does not consistently engrave its single-flat cancellation in a
  // system excerpt. Keep the original key and supply the missing B-natural
  // cancel signs at the source's scanned measure boundary, on BOTH staves.
  // This is a key signature, not an accidental on a sounding note.
  function reflowKeyCancellation(svg){
    if(latest?.pieceTitle!=='Christmas Time Is Here')return;
    const first=Number(latest.first)||0,mi=65-first-1;
    if(mi<0 || mi>=xmlMeasures().length)return;
    const measure=$(svg,'g.measure')[mi];if(!measure)return;
    const source=xmlMeasures()[mi],key=source.querySelector('attributes > key');
    if(!key || localContent(key,'fifths','')!=='0')return;
    const staff=staffGroups(measure),scan=image.getBoundingClientRect();
    if(staff.length<2)return;
    const x=scan.left+Number(latest.barlines[mi])*scan.width;
    const gap=Number(latest.scanStaffSpacePx||17)*(scan.width/(image.naturalWidth||2300))*staffSizeFactor;
    if(!Number.isFinite(gap)||gap<3)return;
    const draw=svg.querySelector('svg.definition-scale')||svg;
    const glyph=svg.querySelector('defs g[id^="E261"]');
    const ns='http://www.w3.org/2000/svg',layer=document.createElementNS(ns,'g');
    layer.setAttribute('class','pl-key-change-c-major');
    const desiredX=x+Math.max(gap*.8,8);
    for(let si=0;si<2;si++){
      const existing=$(staff[si],'g.keySig use').filter(u=>
        (u.getAttribute('href')||u.getAttribute('xlink:href')||'').includes('E261') &&
        u.getBoundingClientRect().width>1);
      if(existing.length){
        const old=existing[0].getBoundingClientRect();
        const keyGroup=existing[0].closest('g.keySig')||existing[0];
        if(Number.isFinite(old.left) && addTranslation(keyGroup,desiredX-old.left))continue;
      }
      const box=staffLineBox(staff[si]);if(!box)continue;
      const y=box.top+gap*(si===0?2:3);
      const at=engravingPoint(draw,desiredX,y);if(!at)continue;
      if(glyph){
        const g=document.createElementNS(ns,'use');
        const href='#'+glyph.id;
        g.setAttribute('href',href);
        g.setAttributeNS('http://www.w3.org/1999/xlink','href',href);
        // Native Verovio music-font glyph in its own immutable form.
        const a=draw.getScreenCTM();
        const scale=.72 * gap/(180*Math.hypot(a.a,a.b));
        if(Number.isFinite(scale) && scale>0.01 && scale<4){
          g.setAttribute('transform',`translate(${at.x} ${at.y}) scale(${scale})`);
          layer.appendChild(g);
          continue;
        }
      }
      // Fallback only if this Verovio build provides no E261 definition.
      const shape=document.createElementNS(ns,'path');
      const points=[
        ['M',desiredX-gap*.25,y-gap*.75],['L',desiredX-gap*.25,y+gap*.65],
        ['M',desiredX+gap*.27,y-gap*1.06],['L',desiredX+gap*.27,y+gap*.34],
        ['M',desiredX-gap*.25,y-gap*.1],['L',desiredX+gap*.27,y-gap*.28],
        ['M',desiredX-gap*.25,y+gap*.43],['L',desiredX+gap*.27,y+gap*.25]
      ];
      const coords=points.map(([c,x0,y0])=>{
        const p=engravingPoint(draw,x0,y0);return p?`${c}${p.x} ${p.y}`:'';
      }).join(' ');
      shape.setAttribute('d',coords);
      shape.setAttribute('fill','none');shape.setAttribute('stroke','#111');
      shape.setAttribute('stroke-width','1.65');shape.setAttribute('vector-effect','non-scaling-stroke');
      layer.appendChild(shape);
    }
    if(layer.children.length)draw.appendChild(layer);
  }

  function calibrateDraft(svg,input){
    const scanGeometry=window.PianoScanCalibration?.[latest.pieceSlug]?.[latest.first];
    if(window.PianoEnableDraftCalibration!==true || !scanGeometry?.accepted)return 'not calibrated';
    // Native octave spans need endpoint-aware repositioning before this path can
    // move their notes. Retain raw notation until that support is verified.
    if(input.xml.includes('<octave-shift'))return 'octave-span calibration pending';
    const raw=svg.outerHTML;
    const saved=latest;
    try {
      latest={...latest,barlines:scanGeometry.barlines_px.map(x=>x/scanGeometry.width),
        scanStaffSpacePx:scanGeometry.staff_space_px,
        scanStaffTopGapPx:scanGeometry.staff_lines_center_x[1][0]-scanGeometry.staff_lines_center_x[0][0]};
      bindEvents(svg,input.xml);
      const supply=window.PianoMusicXMLInput.supply(svg,input.xml,latest.first);
      if(supply.length || mapped.size!==sourceEventCount)throw Error('Incomplete glyph mapping');
      fitToScannedStaff(svg);
      matchVerticalStaffDistance(svg);
      const upper=staffLineBox(staffGroups(svg.querySelector('g.measure'))[0]);
      const desiredTop=scanGeometry.staff_lines_center_x[0][0]*image.getBoundingClientRect().width/scanGeometry.width;
      if(upper)svg.style.marginTop=(desiredTop-(upper.top-notation.getBoundingClientRect().top))+'px';
      const rules=captureRuleGeometry(svg);
      if(!rules)throw Error('Staff geometry unavailable');
      positionFromOriginalMusicXML(svg);
      relocateVerifiedCrossStaffGlyphs(svg);
      registerVerifiedInternalSignatures(svg);
      reflowTies(svg);reflowGraceSlurs(svg);
      if(!layOutRulesFromScan(rules,svg))throw Error('Rule registration unavailable');
      svg.dataset.calibration='scan-barlines-and-source-positions';
      return 'scan geometry trial · '+lastAttachmentReport;
    }catch(error){
      notation.innerHTML=raw;staffRules.replaceChildren();
      return 'raw notation retained: '+error.message;
    }finally{latest=saved;}
  }

  // Draft imports sometimes emit empty tie groups (notably whole-note chords).
  // Reconstruct only explicit MusicXML ties, using pitch AND exact temporal
  // adjacency. Cross-voice continuations are legal; differing pitches are not.
  function renderDraftTies(svg) {
    bindEvents(svg);
    const ms=xmlMeasures(),events=[];let divisions=1,base=0;
    for(let mi=0;mi<ms.length;mi++){
      let cursor=0,last=0,extent=0,ni=0;
      for(const c of Array.from(ms[mi].children)){
        if(c.localName==='attributes'&&localContent(c,'divisions'))divisions=Number(localContent(c,'divisions'));
        if(c.localName==='backup'||c.localName==='forward')cursor+=Number(localContent(c,'duration','0'))/divisions*(c.localName==='backup'?-1:1);
        if(c.localName!=='note')continue;
        const id=`p0-m${Number(latest.first)+mi}-n${ni++}`;
        const grace=directChildren(c,'grace').length>0,chord=directChildren(c,'chord').length>0;
        const duration=Number(localContent(c,'duration','0'))/divisions,onset=chord?last:cursor;
        if(!chord){last=cursor;if(!grace)cursor+=duration;}extent=Math.max(extent,onset+duration);
        const pitch=directChildren(c,'pitch')[0];if(!pitch||grace)continue;
        const marks=directChildren(c,'tie'),visual=$(c,'notations > tied');
        const key=[localContent(c,'staff','1'),localContent(pitch,'step'),localContent(pitch,'alter','0'),localContent(pitch,'octave')].join(':');
        const rank=Number(localContent(pitch,'octave'))*7+'CDEFGAB'.indexOf(localContent(pitch,'step'));
        events.push({id,mi,key,rank,onset:base+onset,localOnset:onset,end:base+onset+duration,
          start:marks.some(t=>t.getAttribute('type')==='start'),stop:marks.some(t=>t.getAttribute('type')==='stop'),
          orientation:visual.find(t=>t.getAttribute('orientation'))?.getAttribute('orientation'),stem:localContent(c,'stem')});
      }
      base+=extent;
    }
    const pairs=[],used=new Set();
    for(const a of events.filter(e=>e.start)){
      const bs=events.filter(b=>b.stop&&b.key===a.key&&Math.abs(b.onset-a.end)<1e-7&&!used.has(b.id));
      if(bs.length===1){pairs.push({a,b:bs[0]});used.add(bs[0].id);}
      else if(!bs.length&&a.mi===ms.length-1&&Math.abs(a.end-base)<1e-7)pairs.push({a,b:null});
    }
    for(const b of events.filter(e=>e.stop&&e.mi===0&&Math.abs(e.localOnset)<1e-7&&!used.has(e.id)))pairs.push({a:null,b});
    const drawing=svg.querySelector('svg.definition-scale')||svg,screen=drawing.getScreenCTM();if(!screen)return;
    const inverse=screen.inverse(),ns='http://www.w3.org/2000/svg',layer=document.createElementNS(ns,'g');layer.setAttribute('class','pl-draft-ties');layer.setAttribute('fill','currentColor');
    const point=(x,y)=>new DOMPoint(x,y).matrixTransform(inverse),fmt=p=>`${p.x.toFixed(3)} ${p.y.toFixed(3)}`;
    let drawn=0;
    for(const {a,b} of pairs){
      const ae=a&&mapped.get(a.id),be=b&&mapped.get(b.id);if((a&&!ae?.isConnected)||(b&&!be?.isConnected))continue;
      const ar=ae&&headRect(ae),br=be&&headRect(be),ref=a||b,r=ar||br,space=Math.max(3,r.height*1.1);
      const chord=events.filter(e=>e.mi===ref.mi&&e.key.split(':')[0]===ref.key.split(':')[0]&&Math.abs(e.onset-ref.onset)<1e-7);
      const lo=Math.min(...chord.map(e=>e.rank)),hi=Math.max(...chord.map(e=>e.rank));
      const orientation=a?.orientation||b?.orientation;
      const side=orientation==='over'?-1:orientation==='under'?1:hi>lo?(ref.rank>(hi+lo)/2?-1:1):(ref.stem==='down'?-1:1);
      const staff=ae?.closest('g.staff'),edge=staff&&staffLineBox(staff);
      const x1=ar?ar.right+space*.12:br.left-space*2.3,x2=br?br.left-space*.12:Math.max(ar.right+space*2.3,(edge?.right||ar.right)-space*.35);
      if(x2-x1<space*.4)continue;
      const y=r=>side===1?r.bottom-r.height*.15:r.top+r.height*.15;
      const y1=y(ar||br),y2=y(br||ar),w=x2-x1,curve=Math.min(space*1.3,Math.max(space*.65,w*.055)),weight=Math.max(.55,space*.10);
      const p1=point(x1,y1),p2=point(x2,y2),c1=point(x1+w*.3,y1+side*curve),c2=point(x2-w*.3,y2+side*curve),i1=point(x1+w*.3,y1+side*(curve+weight)),i2=point(x2-w*.3,y2+side*(curve+weight));
      const path=document.createElementNS(ns,'path');path.setAttribute('d',`M${fmt(p1)} C${fmt(c1)} ${fmt(c2)} ${fmt(p2)} C${fmt(i2)} ${fmt(i1)} ${fmt(p1)} Z`);
      path.dataset.startEvent=a?.id||'incoming';path.dataset.endEvent=b?.id||'outgoing';layer.appendChild(path);drawn++;
    }
    // Preserve engine geometry if mapping is incomplete; never hide an unmatched curve.
    if(drawn===pairs.length&&drawn){$(svg,'g.tie').forEach(g=>g.style.visibility='hidden');drawing.appendChild(layer);}
    else if(latest.pieceSlug==='rudolph-the-red-nosed-reindeer' && Number(latest.first)===55){
      // A missing unrelated glyph mapping must not suppress the expressly
      // notated long B4 tie from m57 to m58. Retain all native other ties.
      const bStart=events.find(e=>e.mi===1&&e.key==='1:B:0:4'&&e.start);
      const target=[...layer.children].find(p=>p.dataset.startEvent===bStart?.id);
      if(target){drawing.appendChild(target);svg.dataset.rudolphB57Tie='preserved';}
    }
    svg.dataset.semanticTiePairs=String(pairs.length);svg.dataset.semanticTiesDrawn=String(drawn===pairs.length?drawn:0);
  }

  // Review corrections use source-event identities and relative glyph bounds,
  // so they remain valid when the viewport or engraving scale changes.
  function renderDraftOptical(svg){
    bindEvents(svg);
    // V52 optical corrections: use the original scan rather than Verovio's
    // uncalibrated vertical stacking. Only touch the annotated systems.
    if(latest.pieceSlug==='silver-bells' && Number(latest.first)===0){
      const octave=svg.querySelector('g.octave');
      const upper=$(svg,'g.fermata').sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top)[0];
      if(octave&&upper){
        const o=octave.getBoundingClientRect(),f=upper.getBoundingClientRect();
        if(o.width>1&&f.width>1){
          // Print: 8va and its bracket ABOVE the RH fermata; LH fermata
          // remains exactly where Verovio put it. Leave a real gap.
          const gap=Math.max(2,Math.min(o.height,f.height)*.22);
          const desiredOctaveTop=Math.min(o.top,f.top);
          const desiredFermataTop=desiredOctaveTop+o.height+gap;
          const ody=desiredOctaveTop-o.top,fdy=desiredFermataTop-f.top;
          if(Math.abs(ody)<Math.max(120,staffHeightPixels(svg))&&Math.abs(fdy)<Math.max(120,staffHeightPixels(svg))){
            addTranslation(octave,0,ody);
            addTranslation(upper,0,fdy);
            svg.dataset.silverOctaveFermata='8va-above-fermata';
          }
        }
      }
    }
    if(latest.pieceSlug==='let-it-snow-let-it-snow-let-it-snow'&&Number(latest.first)===37){
      const measures=$(svg,'g.measure');
      const measure=measures[1]; // actual printed m39 in system m38–41
      // Verovio can attach the <direction> from XML m38 to SVG m39 due to its
      // +6 tick offset. Locate the REAL glyph rather than moving 'To Coda'.
      const mark=measure?.querySelector('g.dir.tocoda') || measures[0]?.querySelector('g.dir.tocoda');
      const sign=mark?.querySelector('tspan.symbol');
      const text=mark?.querySelector('text');
      const words=text&&[...text.children].find(n=>n.classList.contains('rend'));
      // Ensure words first, symbol second, before measuring the glyph.
      if(sign&&words&&[...text.children].indexOf(sign)<[...text.children].indexOf(words))text.appendChild(sign);
      // Verovio's barLine is a set of VERTICAL paths; its getBoundingClientRect()
      // commonly has width === 0. V51's b.width>0 test erroneously skipped
      // this entire alignment, even though the barline is perfectly valid.
      const bar=measure?.querySelector('g.barLine path');
      const glyph=sign?.querySelector('tspan')||sign;
      if(glyph&&bar){
        const r=glyph.getBoundingClientRect(),b=bar.getBoundingClientRect();
        const x=(b.left+b.right)/2; // exact m39 right-hand barline
        const dx=x-(r.left+r.right)/2;
        if(r.width>1&&Number.isFinite(x)&&Math.abs(dx)<Math.max(250,svg.getBoundingClientRect().width*.25)
          &&addTranslation(mark,dx)){
          const after=glyph.getBoundingClientRect();
          if(Math.abs((after.left+after.right)/2-x)<1.5)
            svg.dataset.snowCodaCrosshair='barline-aligned';
        }
      }
    }
    if(latest.pieceSlug==='white-christmas'&&Number(latest.first)===64){
      const measure=$(svg,'g.measure')[2]; // m67, system m65–67
      const dyn=measure?.querySelector('g.dynam');
      const sub=[...(measure?.querySelectorAll('g.dir')||[])].find(n=>/\bsub\./.test(n.textContent||''));
      if(dyn&&sub){
        const d=dyn.getBoundingClientRect(),r=sub.getBoundingClientRect();
        if(d.width>1&&r.width>1){
          // Preserve both semantic score directions. The baseline of "sub."
          // stays put; shift mf down to it and place sub. to the right of mf.
          const dy=(r.top+r.bottom-d.top-d.bottom)/2;
          const gap=Math.max(3,d.height*.25);
          if(Math.abs(dy)<120&&addTranslation(dyn,0,dy)&&addTranslation(sub,d.right+gap-r.left))
            svg.dataset.whiteMfsSub='single-baseline';
        }
      }
    }
    const rules={
      'frosty-the-snowman':[[105,9,10]],
      'there-s-no-place-like-home-for-the-holidays':[[16,11,12],[17,6,7],[40,7,8],[48,9,10]],
      'i-ll-be-home-for-christmas':[[12,2,3],[46,7,9]],
      'i-ve-got-my-love-to-keep-me-warm':[[20,0,1],[36,0,1]]
    };
    let adjusted=0;
    const event=(m,n)=>mapped.get(`p0-m${m-1}-n${n}`);
    for(const [m,ni,other] of rules[latest.pieceSlug]||[]){
      const note=event(m,ni),reference=event(m,other);
      const accidental=note?.querySelector('g.accid'),next=reference?.querySelector('g.accid');
      if(!accidental||!next)continue;
      const a=accidental.getBoundingClientRect(),b=next.getBoundingClientRect(),head=headRect(note);
      const dx=b.left-head.width*.35-a.right;
      if(dx<0 && addTranslation(accidental,dx))adjusted++;
    }
    // V50 m36: two native, UN-SCALED sharp glyphs in separate horizontal
    // columns. The low C-sharp is the outer sign, D-sharp the inner sign.
    // Bounds are read from the real glyphs after the engine has engraved them;
    // never stretch, resize, or repaint an accidental as a decorative overlay.
    if(latest.pieceSlug==='i-ve-got-my-love-to-keep-me-warm'){
      const c=event(36,0)?.querySelector('g.accid');
      const d=event(36,1)?.querySelector('g.accid');
      const cn=event(36,0),dn=event(36,1);
      if(c&&d&&cn&&dn&&[c,d].every(x=>x.getBoundingClientRect().width>0)){
        const cb=c.getBoundingClientRect(),db=d.getBoundingClientRect();
        const hc=headRect(cn),hd=headRect(dn);
        const gap=Math.max(1.5,Math.min(hc.height,hd.height)*.18);
        const nearest=Math.min(hc.left,hd.left)-gap*.45;
        const targetD=nearest-db.width;
        const targetC=targetD-gap-cb.width;
        // Do not collapse the signs or push them through the measure barline.
        const bar=cn.closest('g.measure')?.getBoundingClientRect();
        if(!bar||targetC>=bar.left+1){
          addTranslation(d,targetD-db.left);
          addTranslation(c,targetC-cb.left);
          adjusted++;
        }
      }
    }
    if(latest.pieceSlug==='i-ll-be-home-for-christmas'){
      const whole=event(19,3),melody=event(19,0),bass=event(19,4);
      if(whole&&melody&&bass){
        const a=headRect(whole),b=headRect(bass),d=headRect(melody);
        const owner=whole.closest('g.chord')||whole,dx=(b.left+b.right-a.left-a.right)/2;
        const staff=whole.closest('g.staff');
        // Native ledger lines are siblings of the chord, not chord children.
        // Move their short segments with the whole-note column as well.
        for(const line of $(staff,'g.ledgerLines path')){
          const r=line.getBoundingClientRect();
          if(r.width<a.width*3 && r.left<=a.right && r.right>=a.left)addTranslation(line,dx);
        }
        addTranslation(owner,dx);
        const flat=event(19,2)?.querySelector('g.accid');
        if(flat){const head=headRect(event(19,2)),box=flat.getBoundingClientRect();addTranslation(flat,head.left-head.width*.3-box.right);}
        const target=(b.left+b.right)/2+a.width*1.30;
        addTranslation(melody,target-(d.left+d.right)/2);
        adjusted++;
      }
    }
    const separated={
      'it-s-beginning-to-look-a-lot-like-christmas':[[6,11,5]]
    };
    for(const [m,ni,other] of separated[latest.pieceSlug]||[]){
      const note=event(m,ni),reference=event(m,other);if(!note||!reference)continue;
      const a=headRect(note),b=headRect(reference),dx=b.right+b.width*.25-a.left;
      if(dx>0 && addTranslation(note,dx))adjusted++;
    }
    const courtesyRules={
      'white-christmas':{20:'keySig'},
      'frosty-the-snowman':{39:'meterSig',98:'meterSig'},
      'rudolph-the-red-nosed-reindeer':{73:'meterSig'},
      'it-s-beginning-to-look-a-lot-like-christmas':{45:'keySig'}
    };
    const courtesyKind=courtesyRules[latest.pieceSlug]?.[Number(latest.last)];
    if(courtesyKind){
      // Verovio imports an end-of-measure key declaration at the measure's
      // beginning. Move its native glyphs to the printed courtesy position.
      const last=$(svg,'g.measure').at(-1),staffs=staffGroups(last);
      const space=staffHeightPixels(svg)/4,scan=image.getBoundingClientRect();
      const finalBar=(latest.barlines?.length && scan.width>0)
        ? scan.left+latest.barlines.at(-1)*scan.width : NaN;
      let placed=0;
      for(const staff of staffs){
        const symbol=staff.querySelector('g.'+courtesyKind);
        if(!symbol)continue;
        const box=symbol.getBoundingClientRect();
        if(!(box.width>1&&Number.isFinite(finalBar)))continue;
        // The closing courtesy signature is printed AFTER the last scanned
        // barline. A native staff bbox is not the calibrated end of the page:
        // its right edge can be hundreds of pixels past the original scan.
        const wanted=finalBar+space*.38;
        if(wanted+box.width>scan.right+space*1.2)continue;
        if(addTranslation(symbol,wanted-box.left))placed++;
      }
      // Do not move a native barline: the scan-registered rule has already
      // replaced it, and is the sole authority for measure boundaries.
      if(placed){
        svg.dataset.courtesyKeyPosition='scan-barline-right';
        svg.dataset.courtesySignatureKind=courtesyKind;
        svg.dataset.courtesySymbolsPositioned=String(placed);
      }
    }
    svg.dataset.reviewSpacingAdjustments=String(adjusted);
  }

  // Have Yourself m9–12: Verovio's autogenerated measure number "9" overlaps
  // the opening "Gentle Latin groove" expression after source-coordinate
  // placement. Move only the expression right by the necessary visual
  // clearance; keep the measure number, notes, and calibrated rules fixed.
  // This is a display-only adjustment. MusicXML remains authoritative.
  function reflowGentleLatinGroove(svg){
    if(latest?.pieceSlug!=='have-yourself-a-merry-little-christmas' ||
       Number(latest.first)!==8)return;
    const m=svg.querySelector('g.measure');
    const number=m?.querySelector('g.mNum');
    const label=[...(m?.querySelectorAll('g.dir')||[])].find(g=>
      /gentle latin groove/i.test(g.textContent||''));
    if(!number||!label)return;
    const n=number.getBoundingClientRect(),l=label.getBoundingClientRect();
    if(!(n.width>0&&l.width>0))return;
    if(l.top>=n.bottom||n.top>=l.bottom)return;
    const gap=Math.max(8,staffHeightPixels(svg)*0.22);
    const move=n.right+gap-l.left;
    if(move>0 && move<80 && addTranslation(label,move)){
      svg.dataset.gentleLatinGroove='measure-number-cleared';
    }
  }

  // This edition's Coda in Home for the Holidays is correctly indexed by
  // the library as measures 57–68, but its canonical MusicXML labels the
  // separately printed Coda section 1–12. Change SVG *display labels only*
  // after engraving/alignment: no MusicXML rewriting or Verovio re-spacing.
  function relabelHomeCoda(svg){
    if(latest?.pieceSlug!=='there-s-no-place-like-home-for-the-holidays'||Number(latest.first)<56)return;
    const first=Number(latest.first)+1;
    const m=svg.querySelector('g.measure');
    if(!m)return;
    const label=m.querySelector('g.mNum');
    if(label){
      const leaf=[...label.querySelectorAll('tspan')].filter(n=>n.children.length===0).pop();
      if(leaf){leaf.textContent=String(first);svg.dataset.homeCodaNumber=String(first);}
    }else if(first===57){
      // Verovio suppresses the number 1 at the start of an isolated Coda.
      // Place 57 to the right of the Coda sign, above the treble staff.
      const staff=[...m.querySelectorAll('g.staff')].find(n=>n.closest('g.measure')===m);
      const sr=staff?.getBoundingClientRect(), matrix=svg.getScreenCTM();
      if(!sr||!matrix)return;
      const gap=staffHeightPixels(svg)/4;
      const coda=[...svg.querySelectorAll('g.coda,g.repeatMark')].filter(n=>n.getBoundingClientRect().width>1)
        .map(n=>n.getBoundingClientRect()).sort((a,b)=>a.left-b.left)[0];
      const px=Math.max(sr.left+gap*3.2, (coda?.right??sr.left)+gap*1.1);
      const py=sr.top-gap*1.2;
      const at=new DOMPoint(px,py).matrixTransform(matrix.inverse());
      const fontPx=Math.max(14,gap*1.75);
      const fontScale=Math.hypot(matrix.a,matrix.b)||1;
      const ns='http://www.w3.org/2000/svg';
      const group=document.createElementNS(ns,'g');group.setAttribute('class','mNum pl-continuous-coda-number');
      const text=document.createElementNS(ns,'text');
      text.setAttribute('x',at.x);text.setAttribute('y',at.y);
      text.setAttribute('font-family','Times New Roman, serif');text.setAttribute('font-size',fontPx/fontScale);
      text.textContent='57';group.appendChild(text);svg.appendChild(group);
      svg.dataset.homeCodaNumber='57';
    }
  }

  function renderReview49(svg){
    if(!svg)return;
    const space=staffHeightPixels(svg)/4;
    const event=(k,n)=>mapped.get(`p0-m${k-1}-n${n}`);
    if(latest.pieceSlug==='the-christmas-song'){
      const a=event(55,4),f=event(55,10);
      if(a&&f){const x=headRect(a),y=headRect(f);addTranslation(a,(y.left+y.right-x.left-x.right)/2);}
    }
    if(latest.pieceSlug==='christmas-time-is-here'){
      const mi=80-Number(latest.first),measure=$(svg,'g.measure')[mi];
      if(mi>=0&&measure)for(const d of $(measure,'g.dynam'))addTranslation(d,space*.8,space*1.5);
    }
    if(latest.pieceSlug==='frosty-the-snowman'&&Number(latest.last)===113){
      for(const g of $(svg,'g.octave')){
        for(const line of $(g,'path,line,polyline'))line.style.visibility='hidden';
        for(const label of $(g,'text,use')){
          const box=label.getBoundingClientRect(),ctm=label.getScreenCTM();if(!ctm||!box.width)continue;
          const center=new DOMPoint(box.left,box.top).matrixTransform(ctm.inverse());
          label.setAttribute('transform',(label.getAttribute('transform')||'')+` translate(${center.x} ${center.y}) scale(1.45) translate(${-center.x} ${-center.y})`);
        }
        g.dataset.review49='large-label-without-bracket';
      }
    }
    svg.dataset.review49='applied';
  }
  function renderDraft(){
    if(!latest||!toolkit||waitingForScan||!image.complete||!image.naturalWidth)return;
    try {
      // Newer unverified scores do not have the two finished pieces' exact
      // source-position calibration. Do NOT apply their bespoke geometry or
      // fabricate aligned barlines. Render the real score in Verovio instead.
      // Do not inherit v52 draft settings when returning from a draft-only
      // system. WKWebView previously shared this toolkit with aligned mode.
      toolkit.resetOptions();
      toolkit.setOptions({header:'none',footer:'none',pageWidth:3200,pageHeight:1600,
        pageMarginTop:45,pageMarginBottom:35,pageMarginLeft:30,pageMarginRight:30,
        scale:Math.round(30*staffSizeFactor),unit:9,octaveAlternativeSymbols:true,spacingLinear:0.4,spacingNonLinear:0.7,
        svgAdditionalAttribute:['note@pname','note@oct'],breaks:'none',noJustification:true,
        adjustPageHeight:true,svgViewBox:true});
      const input=window.PianoMusicXMLInput.prepare(latest.xml, {collectionDraft:true,first:latest.first,pieceSlug:latest.pieceSlug, initialTimeVisible:window.PianoScanCalibration?.[latest.pieceSlug]?.[latest.first]?.initialTimeVisible, showHarmony:window.PianoShowHarmony===true,printedOctaveOverrides:latest.printedOctaveOverrides});
      if(!toolkit.loadData(input.xml))throw Error('Verovio rejected draft score');
      notation.innerHTML=toolkit.renderToSVG(1,{});
      const svg=notation.querySelector('svg');
      if(!svg)throw Error('Verovio produced no score SVG');
      svg.setAttribute('preserveAspectRatio','xMinYMin meet');
      svg.dataset.printedOctaveCorrections=String(input.printedOctaveCorrections||0);
      staffRules.replaceChildren();
      document.getElementById('guide-layer')?.replaceChildren();
      // The isolated coda occupies only the right quarter of its raw page.
      // Its padded scan keeps that width; keep native engraving at the same scale.
      if(latest.pieceSlug==='i-ll-be-home-for-christmas' && Number(latest.first)===62){
        svg.style.width='26.5%';svg.dataset.partialSystemScale='0.265';
      }
      const calibration=calibrateDraft(svg,input);
      renderDraftOptical(notation.querySelector("svg"));
      renderDraftTies(notation.querySelector("svg"));
      reflowGraceSlurs(notation.querySelector("svg"));
      renderReview49(svg);
      relabelHomeCoda(svg);
      const supply=window.PianoMusicXMLInput.supply(notation.querySelector('svg'),input.xml,latest.first);
      window.PianoPositionEditor?.onRendered?.();
      window.PianoAttachmentAudit?.inspect?.(latest,{alignmentReport:lastAttachmentReport, uncertainIDs:uncertainLayoutIDs});
      svg.dataset.supplyWarnings=JSON.stringify(supply);
      normalizeMeasureLabels(notation.querySelector('svg'));
    lastRenderedGeneration=systemGeneration;
      report('rendered',`${latest.pieceTitle} · ${supply.length ? supply.length+' glyph-count discrepancies' : 'complete glyph supply'} · provisional score · m${latest.first+1}–${latest.last+1} · ${calibration}`);
    } catch(err) {
      staffRules.replaceChildren();
      notation.textContent='Draft notation failed: '+String(err);
      report('error','Draft notation: '+String(err));
    }
  }
  // Lock snapshots bypass the engraving engine completely. The source
  // note/rest mapping is serialized alongside the approved SVG, preserving
  // selection and navigation without recomputing the appearance.
  function renderLocked(){
    if(latest.lockedSnapshotError){
      notation.textContent='LOCK INTEGRITY ERROR: '+latest.lockedSnapshotError;
      staffRules.replaceChildren();
      report('error','Locked system protected: '+latest.lockedSnapshotError);
      return;
    }
    const frozen=latest.lockedSnapshot;
    if(!frozen)return;
    const ratio=image.getBoundingClientRect().width/Number(frozen.viewportWidth);
    if(!(ratio>0&&ratio<10)){report('error','Locked system cannot scale to this window');return;}
    notation.innerHTML=frozen.svg;
    // Source-position transformations contain literal CSS pixel offsets. Keep
    // the approved composition at its captured width and scale the COMPLETE
    // engraving, not its constituent glyphs, when the window is resized.
    notation.style.width=`${frozen.viewportWidth}px`;
    notation.style.height=`${frozen.notationHeight*ratio}px`;
    notation.style.transform=`scale(${ratio})`;
    notation.style.transformOrigin='top left';
    notation.style.top=`${6*ratio-6}px`;
    staffRules.replaceChildren();
    for(const name of [...staffRules.getAttributeNames()]){
      if(name!=='id'&&name!=='class'&&name!=='aria-hidden')staffRules.removeAttribute(name);
    }
    for(const [name,value] of Object.entries(frozen.staffRulesAttributes||{})){
      if(name!=='id'&&name!=='class'&&name!=='aria-hidden')staffRules.setAttribute(name,value);
    }
    staffRules.innerHTML=frozen.staffRules||'';
    staffRules.style.width=`${frozen.viewportWidth}px`;
    staffRules.style.height=`${frozen.paneHeight}px`;
    staffRules.style.transform=`scale(${ratio})`;
    staffRules.style.transformOrigin='top left';
    const svg=notation.querySelector('svg');
    if(!svg){report('error','Locked system snapshot has no SVG');return;}
    mapped.clear();
    for(const node of svg.querySelectorAll('[data-pl-lock-events]')){
      let ids=[];
      try{ids=JSON.parse(node.getAttribute('data-pl-lock-events')||'[]');}catch(_){}
      for(const id of ids)if(typeof id==='string')mapped.set(id,node);
    }
    if(mapped.size!==Number(frozen.mappedEvents)){
      notation.textContent='LOCK INTEGRITY ERROR: note mapping incomplete';
      report('error','Locked system note map incomplete; refused to re-engrave');return;
    }
    normalizeMeasureLabels(notation.querySelector('svg'));
    lastRenderedGeneration=systemGeneration;
    drawGuides();
    highlight();
    window.PianoBeatAtlas?.onMapping?.(new Set(mapped.keys()),mapped.size,[],[]);
    report('rendered',`LOCKED · saved approved rendering · ${mapped.size} mapped events · m${latest.first+1}–${latest.last+1}`);
  }

  // Called by AppKit only when the user checks Lock. No existing lock can be
  // silently regenerated or overwritten by renderer changes or resizing.
  window.captureSystemLock=function(){
    if(!latest||latest.lockedSnapshot||latest.lockedSnapshotError||waitingForScan||
       pendingRender||lastRenderedGeneration!==systemGeneration)
      throw Error('System is not fully rendered and ready to lock');
    const svg=notation.querySelector('svg');
    if(!svg||(latest.reviewMode!=='draft'&&!mapped.size))throw Error('Rendered SVG or source event mapping missing');
    const idsByNode=new Map();
    for(const [id,node] of mapped){
      if(!node?.isConnected||!svg.contains(node))throw Error('A mapped source event is detached');
      if(!idsByNode.has(node))idsByNode.set(node,[]);
      idsByNode.get(node).push(id);
    }
    // Mark cloned nodes by path rather than mutating visible notation.
    const clone=svg.cloneNode(true);
    const originals=[...svg.querySelectorAll('*')];
    const copies=[...clone.querySelectorAll('*')];
    if(originals.length!==copies.length)throw Error('SVG clone lost musical nodes');
    const indexes=new Map(originals.map((el,i)=>[el,i]));
    for(const [node,ids] of idsByNode){
      const target=node===svg?clone:copies[indexes.get(node)];
      if(!target)throw Error('Could not snapshot a musical event');
      target.setAttribute('data-pl-lock-events',JSON.stringify(ids));
    }
    clone.querySelectorAll('.pl-selection-halo').forEach(el=>el.remove());
    clone.querySelectorAll('.pl-selected').forEach(el=>el.classList.remove('pl-selected'));
    return {pieceSlug:latest.pieceSlug,first:Number(latest.first),last:Number(latest.last),
      svg:new XMLSerializer().serializeToString(clone),
      staffRules:staffRules.innerHTML,
      staffRulesAttributes:Object.fromEntries([...staffRules.attributes].map(a=>[a.name,a.value])),
      staffSizePercent:Math.round(staffSizeFactor*100),
      viewportWidth:image.getBoundingClientRect().width,
      notationHeight:notation.getBoundingClientRect().height,
      paneHeight:document.getElementById('notation-pane').getBoundingClientRect().height,
      mappedEvents:mapped.size};
  };

  function normalizeMeasureLabels(svg){
    if(latest?.lockedSnapshot||!svg)return;
    const measures=$(svg,'g.measure'),numbers=$(svg,'g.mNum');
    for(const number of numbers){
      const index=measures.indexOf(number.closest('g.measure'));
      const local=index>=0?index:(numbers.length===1?0:-1);
      if(local<0)continue;
      const label=number.querySelector('text');if(!label)continue;
      const leaves=[...label.querySelectorAll('tspan')].filter(n=>!n.querySelector('tspan'));
      if(leaves.length===1)leaves[0].textContent=String(Number(latest.first)+local+1);
      else label.textContent=String(Number(latest.first)+local+1);
      number.dataset.sourceMeasureIndex=String(Number(latest.first)+local);
    }
    svg.dataset.measureIndexBase=String(Number(latest.first)+1);
  }

  function render(){
    if(!latest||waitingForScan||!image.complete||!image.naturalWidth)return;
    window.PianoUniversalLayoutAudit=null;
    window.PianoSemanticDirectionAudit=null;
    window.PianoSemanticSpanAudit=null;
    if(latest.lockedSnapshot||latest.lockedSnapshotError){renderLocked();return;}
    if(!toolkit)return;
    if(latest.reviewMode==='draft'){renderDraft();return;}
    try{
      // Verovio remains a *glyph supplier*. The original edition's preserved
      // MusicXML x coordinates, not Verovio's system justification, determine
      // event placement. Rendering a single unforced system is sufficient.
      // Make every aligned system independent of the renderer mode visited
      // immediately before it (e.g. Frosty s04 -> s05 versus s06 -> s05).
      toolkit.resetOptions();
      toolkit.setOptions({header:'none',footer:'none',pageWidth:3200,pageHeight:1000,
        pageMarginTop:20,pageMarginBottom:20,pageMarginLeft:20,pageMarginRight:20,
        scale:28,unit:9,octaveAlternativeSymbols:false,breaks:'none',noJustification:true,adjustPageHeight:true,
        svgViewBox:true,spacingLinear:0.4,spacingNonLinear:0.7,
        svgAdditionalAttribute:['note@pname','note@oct']});
      // Sanitize *only the temporary engraving input*. Original XML and
      // source-event IDs remain the Beat Atlas's immutable data.
      const prepared=window.PianoMusicXMLInput.prepare(latest.xml,{pieceSlug:latest.pieceSlug,first:latest.first,collectionDraft:latest.alignmentPilot===true,normalizeOctaveShifts:(latest.pieceSlug==='frosty-the-snowman'&&Number(latest.first)===109)||(latest.pieceSlug==='silver-bells'&&Number(latest.first)===0),initialTimeVisible:window.PianoScanCalibration?.[latest.pieceSlug]?.[latest.first]?.initialTimeVisible,showHarmony:window.PianoShowHarmony===true,printedOctaveOverrides:latest.printedOctaveOverrides});
      lastInputRepairCount=prepared.removed;
      if(!toolkit.loadData(prepared.xml))throw Error('Verovio rejected MusicXML');
      notation.innerHTML=toolkit.renderToSVG(1,{});
      const svg=notation.querySelector('svg');if(!svg)throw Error('Engraved SVG missing');
      svg.setAttribute('preserveAspectRatio','xMinYMin meet');
      svg.dataset.printedOctaveCorrections=String(prepared.printedOctaveCorrections||0);
      fitToScannedStaff(svg);
      // Match glyph IDs and temporary octave-shifted pitches against the
      // SAME transient MusicXML Verovio received. Source event ordering and
      // IDs are unchanged, while Beat Atlas and tie musical identities still
      // read immutable latest.xml. Otherwise the printed E2 under the final
      // 8vb is sought as E1 and silently left unmapped.
      bindEvents(svg,prepared.xml);
      uncertainLayoutIDs=[];
      // With a completely verified transient source-ID map, count supply by
      // stable note ID instead of SVG staff ownership (cross-staff notes may
      // legitimately appear under their voice's other staff).
      lastSupplyShort=window.PianoMusicXMLInput.supply(svg,
        svg.dataset.sourceIdAligned==='complete'?prepared.xml:latest.xml,latest.first);
      mappingProblems.push(...lastSupplyShort);
      matchVerticalStaffDistance(svg);
      // Preserve Verovio's original grace-note positions before the noteheads
      // are moved. Legacy slurs have NOT moved yet: pairing them by arbitrary
      // DOM order can attach one grace note's curve to the next grace note.
      preAlignmentHeadBoxes=new Map([...mapped].map(([id,node])=>{
        const r=headRect(node);
        return [id,{left:r.left,right:r.right,top:r.top,bottom:r.bottom}];
      }));
      const originalRules=captureRuleGeometry(svg);
      const universalCoverage=beginUniversalCoverage(svg);
      positionFromOriginalMusicXML(svg);
      relocateVerifiedCrossStaffGlyphs(svg);
      relocateSourceIDCrossStaff(svg);
      registerVerifiedInternalSignatures(svg);
      reflowSourceInternalSignatures(svg);
      reflowTies(svg);
      if(!reflowFullScoreBoundaryTies(svg)){
        window.PianoBoundaryTieAudit={expected:null,drawn:0,unresolved:[{reason:'Full score required for cross-system tie verification'}]};
      }
      clearGraceMainAccidentalCollisions(svg);
      clearNewYearGraceOpenings(svg);
      reflowGraceSlurs(svg);
      reflowFinalTremolos(svg);
      reflowFinalBassFermata(svg);
      const rulesOK=layOutRulesFromScan(originalRules,svg);
      reflowKeyCancellation(svg);
      reflowPedalBraces(svg);
      reflowFrostyCourtesyTime(svg);
      reflowUniversalTrailingAttributes(svg);
      trimFrostyWarningRules(svg);
      extendBeginningWarningKey(svg);
      finishRudolphWarningMeters(svg);
      renderReview49(svg);
      reflowGentleLatinGroove(svg);
      relabelHomeCoda(svg);
      const semanticDirectionResult=reflowSourceTimedIndependentDirections(svg,universalCoverage);
      const semanticSpanResult=inspectSourceAnchoredSpans(svg,universalCoverage);
      const universalResult=finishUniversalCoverage(svg,universalCoverage);
      lastAlignment=rulesOK
        ? `source-coordinate layout · ${layoutCount} events · scan-aligned rules · ${lastLedgerReport} · ${lastTieReport} · ${lastAttachmentReport}` 
        : `source-coordinate layout · ${layoutCount} events · staff-rule detection failed`;
      if(universalResult?.outstanding || universalResult?.unclassifiedTypes){
        lastAlignment+=` · geometry review flags ${universalResult.outstanding}`+
          (universalResult.unclassifiedTypes?` · unknown graphic classes ${universalResult.unclassifiedTypes}`:'');
        svg.dataset.universalReviewRequired='yes';
      }
      drawGuides();
      highlight();
      window.PianoPositionEditor?.onRendered?.();
      window.PianoAttachmentAudit?.inspect?.(latest,{alignmentReport:lastAttachmentReport, uncertainIDs:uncertainLayoutIDs});
      window.PianoBeatAtlas?.onMapping?.(new Set(mapped.keys()), sourceEventCount, mappingProblems, uncertainLayoutIDs);
      const repairs=`${lastInputRepairCount} duplicate chord-beam declarations normalized, `+
        `${prepared.octaveNotes||0} printed-register octave notes, ${prepared.printedOctaveCorrections||0} scan-evidenced octave corrections, ${prepared.octaveDirections||0} octave directions detached`;
      const shortage=lastSupplyShort.length ? ` · SVG shortages: ${lastSupplyShort.map(p=>`m${p.measure} staff ${p.staff} ${p.actual}/${p.expected}`).join(', ')}` : ' · complete glyph supply';
      normalizeMeasureLabels(notation.querySelector('svg'));
    lastRenderedGeneration=systemGeneration;
      report('rendered',`${lastAlignment} · ${mapped.size}/${sourceEventCount} mapped · ${mappedChordGroups} chords (${mappedChordTones} tones) · ${repairs}${shortage}`);
    }catch(err){
      // Keep raw Verovio output for inspection instead of a blank pane.
      staffRules.replaceChildren();
      notation.querySelector('#error')?.remove();
      const error=document.createElement('div');error.id='error';
      error.textContent='Positioning failed; raw notation retained: '+String(err);
      notation.appendChild(error);
      report('error',`Engraving: ${err}`);
      console.error('Piano Library layout failure',err);
    }
  }
  function boot() {
    if(toolkit || latest?.lockedSnapshot || latest?.lockedSnapshotError) return;
    try {
      if(!window.verovio?.toolkit) throw Error('Verovio JavaScript not loaded');
      const t=new window.verovio.toolkit();
      if(typeof t.getVersion==='function')t.getVersion();
      toolkit=t;
      report('ready','Engraver ready');
      scheduleRender();
    } catch(err) {
      if(++tries<150) setTimeout(boot,100);
      else report('error','Local engraving engine failed: '+err.message);
    }
  }
  // The native AppKit bridge owns the clipboard: navigator.clipboard is not
  // reliably available inside WKWebView file:// origins.
  const copySVGButton=document.getElementById('atlas-export-svg');
  let copyResetTimer=null;
  window.pianoRendererSVGCopyDidFinish=function(success){
    if(copyResetTimer)clearTimeout(copyResetTimer);
    copySVGButton.disabled=false;
    copySVGButton.textContent=success?'Copied ✓':'Copy failed';
    copyResetTimer=setTimeout(()=>{copySVGButton.textContent='Copy SVG';copyResetTimer=null;},2400);
  };
  copySVGButton.addEventListener('click',()=>{
    const svg=notation.querySelector('svg');
    if(!svg){report('error','No SVG has been engraved yet');return;}
    // Keep the actual Verovio DOM (including chord/layer hierarchy and the
    // source-coordinate transformations) so remaining problems can be analyzed
    // instead of inferring the SVG structure from a screenshot.
    const content=new XMLSerializer().serializeToString(svg);
    const bridge=window.webkit?.messageHandlers?.piano;
    if(!bridge){window.pianoRendererSVGCopyDidFinish(false);return;}
    if(copyResetTimer){clearTimeout(copyResetTimer);copyResetTimer=null;}
    copySVGButton.disabled=true;
    copySVGButton.textContent='Copying…';
    try { bridge.postMessage({type:'copyRendererSVG',svg:content,system:Number(latest.first)+1}); }
    catch(error){window.pianoRendererSVGCopyDidFinish(false);report('error','Could not copy SVG: '+error);}
  });
  document.getElementById('guides').addEventListener('change',e=>document.body.classList.toggle('show-guides',e.target.checked));
  document.getElementById('staff-size').addEventListener('input',e=>{
    staffSizeFactor=Number(e.target.value)/100;
    document.getElementById('staff-size-value').textContent=`${e.target.value}%`;
    scheduleRender();
  });
  let resizePending=false;
  window.addEventListener('resize',()=>{
    if(resizePending)return;
    resizePending=true;
    requestAnimationFrame(()=>{resizePending=false;scheduleRender();});
  });
  boot();
})();
