'use strict';
/* Scan geometry owns staff rules, ledger lines, repeat barlines and volta spans. */
window.PianoStaffRules={create(context){
  function reshapeLine(node, targetLeftPx, targetRightPx) {
    const {$, latest, image, notation, staffRules, staffSizeFactor, addTranslation, directChildren, localContent, staffGroups, xmlMeasures}=context;
    // ONLY for geometric staff lines and beam rules, never note/clef glyphs.
    // A horizontal line may become longer without changing its line weight.
    const r=node.getBoundingClientRect();
    if(r.width<2 || !(targetRightPx>targetLeftPx))return;
    const k=(targetRightPx-targetLeftPx)/r.width;
    if(!Number.isFinite(k)||k<=0.04||k>40)return;
    const parent=node.parentNode, m=parent?.getScreenCTM();
    if(!m||Math.abs(m.a)<1e-8)return;
    const point=new DOMPoint(r.left,r.top).matrixTransform(m.inverse());
    const t=(1-k)*point.x+(targetLeftPx-r.left)/m.a;
    const holder=document.createElementNS('http://www.w3.org/2000/svg','g');
    holder.setAttribute('class','pl-rule-geometry');
    holder.setAttribute('transform',`matrix(${k.toFixed(7)} 0 0 1 ${t.toFixed(5)} 0)`);
    parent.insertBefore(holder,node);
    holder.appendChild(node);
  }
  function staffLineShapes(staff) {
    const {$, latest, image, notation, staffRules, staffSizeFactor, addTranslation, directChildren, localContent, staffGroups, xmlMeasures}=context;
    const eligible=$(staff,'path, line, polyline, rect').filter(el => {
      if(el.closest('g.layer, g.note, g.rest, g.beam, g.clef, g.keySig, g.meterSig, g.barLine, g.tie, g.slur, g.harm, g.ledgerLines'))return false;
      return el.closest('g.staff')===staff;
    });
    // A staff bounding box includes notes. Once the notes spread to the scan's
    // original width it can be *much* larger than the ruling path. Never infer
    // eligibility from staff bbox width. Rule paths live outside music layers.
    return eligible.filter(el=>{
      const r=el.getBoundingClientRect();
      return r.width>25 && r.height<200 && r.width>r.height*.8;
    });
  }
  function staffLineBox(staff) {
    const {$, latest, image, notation, staffRules, staffSizeFactor, addTranslation, directChildren, localContent, staffGroups, xmlMeasures}=context;
    const ls=staffLineShapes(staff);
    if(!ls.length)return null;
    const rs=ls.map(n=>n.getBoundingClientRect());
    return {top:Math.min(...rs.map(r=>r.top)),bottom:Math.max(...rs.map(r=>r.bottom)),
      left:Math.min(...rs.map(r=>r.left)),right:Math.max(...rs.map(r=>r.right))};
  }
  function matchVerticalStaffDistance(svg) {
    const {$, latest, image, notation, staffRules, staffSizeFactor, addTranslation, directChildren, localContent, staffGroups, xmlMeasures}=context;
    // Vertical staff spacing is also part of the original engraving. The scan
    // has a stable staff-to-staff distance; Verovio's overly large piano brace
    // gap is not a reason to move the scan or enlarge the music.
    const first=svg.querySelector('g.measure');if(!first)return;
    const st=staffGroups(first);
    if(st.length<2)return;
    const a=staffLineBox(st[0]), b=staffLineBox(st[1]);
    if(!a||!b)return;
    const natural=b.top-a.top;
    const wanted=(Number(latest.scanStaffTopGapPx)||Number(latest.scanStaffSpacePx)*11.65)
      *(image.getBoundingClientRect().width/(image.naturalWidth||latest.scanWidthPx||2300))*staffSizeFactor;
    const delta=wanted-natural;
    for(const m of $(svg,'g.measure')) {
      const staffs=staffGroups(m);
      for(let si=1;si<staffs.length;si++)addTranslation(staffs[si],0,delta);
    }
  }
  function captureRuleGeometry(svg) {
    const {$, latest, image, notation, staffRules, staffSizeFactor, addTranslation, directChildren, localContent, staffGroups, xmlMeasures}=context;
    // All staff-line shapes MUST be identified before the x layout moves notes:
    // a moved note enlarges its parent staff bbox, which previously caused
    // staffLineShapes() to reject the lines in the last measures altogether.
    const lines = new Set();
    for (const measure of $(svg,'g.measure')) {
      for (const staff of staffGroups(measure)) {
        for (const el of staffLineShapes(staff)) lines.add(el);
      }
    }
    const first = svg.querySelector('g.measure');
    const staffs = first && staffGroups(first);
    if (!staffs || staffs.length < 2) return null;
    const upper = staffLineBox(staffs[0]);
    const lower = staffLineBox(staffs[1]);
    if (!upper || !lower || upper.bottom <= upper.top || lower.bottom <= lower.top ||
        lower.top <= upper.bottom || lines.size < 2) return null;
    return {lines, upper, lower};
  }

  function reconstructLedgerLines(svg, geometry, pane, lineWidth) {
    const {$, latest, image, notation, staffRules, staffSizeFactor, addTranslation, directChildren, localContent, staffGroups, xmlMeasures}=context;
    // Verovio emits ledgerLines as *staff-level siblings* of the notes, not as
    // descendants of g.note. Source-coordinate reflow must therefore replace
    // these strokes independently. In particular, don't move a whole
    // g.ledgerLines group by the offset of one note: it may serve many notes.
    // Hide all old strokes, including those in groups which did not match a
    // known note, so stray dashes never appear after reflow.
    for (const old of $(svg,'g.ledgerLines')) old.style.visibility='hidden';
    const staffRanges=[geometry.upper,geometry.lower];
    const segments=[];
    let noteCount=0;
    // Some Verovio versions draw a chord as notehead groups without g.note
    // wrappers. Ledger lines must include these heads as well.
    const bareChordHeads=$(svg,'g.chord').filter(c=>!c.querySelector('g.note'))
      .flatMap(c=>$(c,'g.notehead'));
    for (const note of [...$(svg,'g.note'),...bareChordHeads]) {
      const staff=note.closest('g.staff');
      const measure=note.closest('g.measure');
      if(!staff||!measure)continue;
      const allStaffs=staffGroups(measure);
      // A verified cross-staff source may be encoded in one staff yet
      // temporarily owned by another in Verovio's SVG. Ledger strokes
      // must follow its final printed staff, never the SVG owner.
      const staffIndex=note.dataset.sourceStaffPlacement ?
        Number(note.dataset.sourceStaffPlacement)-1 : allStaffs.indexOf(staff);
      const r=staffRanges[staffIndex];
      if(!r)continue;
      const gap=(r.bottom-r.top)/4;
      if(!Number.isFinite(gap)||gap<3)continue;
      // Only the notehead, never the stem or the whole chord, supplies the
      // ledger-line x location. Noteheads have already been positioned from
      // MusicXML default-x at this point.
      const head=note.classList.contains('notehead') ? note
        : note.querySelector(':scope > g.notehead, :scope > use, g.notehead');
      if(!head)continue;
      const box=head.getBoundingClientRect();
      if(box.width<1||box.height<1)continue;
      const cx=(box.left+box.right)/2 - pane.left;
      const cy=(box.top+box.bottom)/2;
      const above=Math.max(0,Math.floor(((r.top-cy)/gap)+0.28));
      const below=Math.max(0,Math.floor(((cy-r.bottom)/gap)+0.28));
      if(!above&&!below)continue;
      noteCount++;
      // Compare against the actual rendered notehead width, not a fixed SVG
      // unit. The short horizontal rule extends approximately half a staff
      // space beyond either side of the head (similar to Verovio's original).
      const extension=Math.max(gap*.31,box.width*.18);
      const left=cx-box.width/2-extension;
      const right=cx+box.width/2+extension;
      for(let i=1;i<=Math.min(above,10);i++)
        segments.push({y:r.top-i*gap-pane.top,left,right,staffIndex});
      for(let i=1;i<=Math.min(below,10);i++)
        segments.push({y:r.bottom+i*gap-pane.top,left,right,staffIndex});
    }
    // Merge overlapping ledger strokes belonging to notes in the same chord.
    // Duplicated strokes would otherwise look darker than other ledger lines.
    segments.sort((a,b)=>a.staffIndex-b.staffIndex || a.y-b.y || a.left-b.left);
    const joined=[];
    for(const s of segments) {
      const prev=joined[joined.length-1];
      if(prev && s.staffIndex===prev.staffIndex && Math.abs(s.y-prev.y)<0.8 && s.left<=prev.right+0.8) {
        prev.right=Math.max(prev.right,s.right);
      } else joined.push({...s});
    }
    const ns='http://www.w3.org/2000/svg';
    for(const s of joined) {
      const line=document.createElementNS(ns,'line');
      line.classList.add('pl-ledger-line');
      line.setAttribute('x1',s.left.toFixed(3));
      line.setAttribute('x2',s.right.toFixed(3));
      line.setAttribute('y1',s.y.toFixed(3));
      line.setAttribute('y2',s.y.toFixed(3));
      line.setAttribute('stroke','#101010');
      line.setAttribute('stroke-width',String(Math.max(1.1,lineWidth*1.6)));
      line.setAttribute('vector-effect','non-scaling-stroke');
      line.setAttribute('stroke-linecap','butt');
      staffRules.appendChild(line);
    }
    return {notes:noteCount,lines:joined.length,hidden:$(svg,'g.ledgerLines').length};
  }

  function layOutRulesFromScan(geometry,svg) {
    const {$, latest, image, notation, staffRules, staffSizeFactor, addTranslation, directChildren, localContent, staffGroups, xmlMeasures}=context;
    // Staff rulings and barlines are strokes, not font glyphs. Construct these
    // at the final scan-based positions in a separate drawing plane instead of
    // trying to stretch per-measure paths with changing SVG bounding boxes.
    // Notes, clefs, accidentals, dynamics and their glyph paths are untouched.
    if (!geometry || !latest?.barlines || latest.barlines.length < 2) return false;
    const pane = document.getElementById('notation-pane').getBoundingClientRect();
    const reference = image.getBoundingClientRect();
    if (!pane.width || !reference.width) return false;
    const xAnchors = latest.barlines.map(x => reference.left + x * reference.width - pane.left);
    const topY = geometry.upper.top - pane.top;
    const bottomY = geometry.lower.top - pane.top;
    const topGap = (geometry.upper.bottom - geometry.upper.top) / 4;
    const lowerGap = (geometry.lower.bottom - geometry.lower.top) / 4;
    const lineWidth = Math.max(.85, Math.min(2, topGap * .085));
    if (!(topGap > 3 && lowerGap > 3 && Math.abs(topGap-lowerGap)<topGap*.3))return false;
    const ns = 'http://www.w3.org/2000/svg';
    const createLine = (x1,y1,x2,y2,width) => {
      const line=document.createElementNS(ns,'line');
      for(const [name,value] of Object.entries({x1,y1,x2,y2}))line.setAttribute(name,String(value));
      line.setAttribute('stroke','#101010');
      line.setAttribute('stroke-width',String(width));
      line.setAttribute('stroke-linecap','butt');
      line.setAttribute('vector-effect','non-scaling-stroke');
      staffRules.appendChild(line);
      return line;
    };
    staffRules.replaceChildren();
    staffRules.setAttribute('viewBox',`0 0 ${pane.width} ${pane.height}`);
    const start=xAnchors[0],end=xAnchors[xAnchors.length-1];
    for (let i=0;i<5;i++) {
      createLine(start,topY + i*topGap,end,topY + i*topGap,lineWidth);
      createLine(start,bottomY+i*lowerGap,end,bottomY+i*lowerGap,lineWidth);
    }
    const measures = xmlMeasures();
    // Frosty's two verified trailing 4/4 warnings already have native
    // numerals. Extend both staves behind their final glyph bounds.
    if(latest.pieceSlug==='frosty-the-snowman'&&[35,94].includes(Number(latest.first))){
      const warnings=$(svg,'g.meterSig').map(n=>n.getBoundingClientRect())
        .filter(r=>r.width>0&&r.left>=pane.left+end-topGap*.2);
      if(warnings.length){
        const warningEnd=Math.max(...warnings.map(r=>r.right-pane.left))+topGap*.35;
        for(let i=0;i<5;i++){
          createLine(end,topY+i*topGap,warningEnd,topY+i*topGap,lineWidth).classList.add('pl-warning-staff-extension');
          createLine(end,bottomY+i*lowerGap,warningEnd,bottomY+i*lowerGap,lineWidth).classList.add('pl-warning-staff-extension');
        }
        staffRules.dataset.warningStaffExtension=String(warningEnd-end);
      }
    }

    // MUSICXML-GROUNDED REPEAT BOUNDARIES. The original Verovio g.barLine
    // groups are hidden below because their x coordinates are obsolete after
    // scan alignment. They also contain the repeat DOTS: redrawing only the
    // strokes silently loses the actual repeat signs. Discover repeats on
    // *both* sides of a boundary (left of next bar or right of preceding bar),
    // deduplicate them, and draw the dots in the same calibrated rule plane.
    // All ordinary barlines use exactly their pre-existing rendering path.
    let repeatBoundaries=0, repeatDots=0, repeatAmbiguous=0;
    const allBarlines=measure=>measure?directChildren(measure,'barline'):[];
    const locationOf=bar=>bar.getAttribute('location')||'right';
    const repeatType=bar=>{
      const repetition=directChildren(bar,'repeat')[0];
      return repetition?.getAttribute('direction')||'';
    };
    for(let i=0;i<xAnchors.length;i++) {
      const x=xAnchors[i];
      const before=i>0?allBarlines(measures[i-1]).filter(b=>locationOf(b)==='right'):[];
      const after=i<measures.length?allBarlines(measures[i]).filter(b=>locationOf(b)==='left'):[];
      const barlines=[...before,...after];
      const repeats=[...new Set(barlines.map(repeatType).filter(Boolean))];
      // A contradictory forward/backward mark cannot be inferred safely.
      // Report it rather than drawing a potentially false repeat structure.
      const supported=repeats.length===1&&['forward','backward'].includes(repeats[0]);
      if(repeats.length && !supported)repeatAmbiguous++;
      const b=before[0]||after[0]||null;
      const style=supported
        ?(repeats[0]==='forward'?'heavy-light':'light-heavy')
        :(b?localContent(b,'bar-style','regular'):'regular');
      const y1=topY,y2=bottomY+4*lowerGap;
      if(style==='none')continue;
      if(style==='light-light' || style==='light-heavy' || style==='heavy-light') {
        const heavy=style==='light-heavy' ? 'right' : style==='heavy-light' ? 'left' : '';
        createLine(x-4,y1,x-4,y2,heavy==='left' ? lineWidth*3:lineWidth);
        createLine(x,y1,x,y2,heavy==='right' ? lineWidth*3:lineWidth);
      } else {
        createLine(x,y1,x,y2,lineWidth);
      }
      if(!supported)continue;
      repeatBoundaries++;
      const forward=repeats[0]==='forward';
      // Two dots in the two central spaces of EACH staff, positioned relative
      // to the scan-based staff rulings. Use circles (not font glyphs) so that
      // the repeat marks share the rule plane's final coordinate system.
      for(const [staffIndex,staffTop,staffGap] of [[1,topY,topGap],[2,bottomY,lowerGap]]){
        const dotX=x+(forward?1:-1)*staffGap*.70;
        for(const space of [1.5,2.5]){
          const dot=document.createElementNS(ns,'circle');
          dot.classList.add('pl-source-repeat-dot');
          dot.setAttribute('cx',String(dotX));
          dot.setAttribute('cy',String(staffTop+space*staffGap));
          dot.setAttribute('r',String(staffGap*.145));
          dot.setAttribute('fill','#101010');
          dot.dataset.sourceRepeatDirection=repeats[0];
          dot.dataset.sourceRepeatBoundary=String(Number(latest.first)+i);
          dot.dataset.sourceRepeatStaff=String(staffIndex);
          staffRules.appendChild(dot);
          repeatDots++;
        }
      }
    }
    // ENDING BRACKETS (VOLTE): source-semantic spans on scan-aligned measure
    // boundaries. Native Verovio g.ending spans refer to the pre-reflow system
    // width, so they must never be retained after note/barline repositioning.
    // The source of truth is the part-1 MusicXML <ending> lifecycle. A verified
    // scan correction may override a demonstrably contradictory XML lifecycle;
    // it changes only the transient display, not any canonical MusicXML.
    const voltaRecords=[];
    for(let mi=0;mi<measures.length;mi++)for(const bar of allBarlines(measures[mi])){
      for(const ending of directChildren(bar,'ending')){
        voltaRecords.push({index:mi,measure:Number(measures[mi].getAttribute('number')),
          location:locationOf(bar),number:ending.getAttribute('number')||'',
          type:ending.getAttribute('type')||''});
      }
    }
    const recordSignature=voltaRecords.map(v=>
      `${v.measure}:${v.location}:${v.number}:${v.type}`).join('|');
    let voltaSegments=[],voltaScanOverrides=0,voltaAmbiguous=0;
    // In the original Silver Bells scan, the first ending spans printed
    // measures 60–67 (eight measures), ending at the :| in printed m67;
    // the second starts at printed m68, the LAST measure of s14.
    // MusicXML contradicts this: #1 stops after m64, #2 starts at m65 and
    // restarts at m68. Both records are left intact for musical audit.
    // The exact signature guard prevents silently applying this correction
    // to a different transcription or source revision.
    if(latest.pieceSlug==='silver-bells'&&Number(latest.first)===59&&
      recordSignature==='59:left:1:start|63:right:1:discontinue'){
      voltaSegments=[{number:'1',start:0,end:measures.length,left:true,right:false,proof:'scan-verified-59-to-66'}];
      voltaScanOverrides++;
    }else if(latest.pieceSlug==='silver-bells'&&Number(latest.first)===64&&
      recordSignature==='64:left:2:start|66:right:2:stop|67:left:2:start|67:right:2:discontinue'&&
      measures.length===4 && repeatType(allBarlines(measures[2]).find(b=>locationOf(b)==='right'))==='backward'){
      voltaSegments=[
        {number:'1',start:0,end:3,left:false,right:true,proof:'scan-verified-59-to-66'},
        {number:'2',start:3,end:4,left:true,right:false,proof:'scan-verified-67-onward'}
      ];
      voltaScanOverrides++;
    }else {
      // Future correctly transcribed source endings use this SAME renderer.
      // A dangling closing or overlapping number is not guessed into a span.
      const active=new Map();
      for(const r of voltaRecords){
        if(r.type==='start'&&r.location==='left'){
          if(active.has(r.number)){voltaAmbiguous++;continue;}
          active.set(r.number,r.index);
        }else if(['stop','discontinue'].includes(r.type)&&r.location==='right'){
          if(!active.has(r.number)){voltaAmbiguous++;continue;}
          const startIndex=active.get(r.number);active.delete(r.number);
          voltaSegments.push({number:r.number,start:startIndex,end:r.index+1,left:true,
            right:r.type==='stop',proof:'source-ending-lifecycle'});
        }else voltaAmbiguous++;
      }
      for(const [number,startIndex] of active)voltaSegments.push({number,
        start:startIndex,end:measures.length,left:true,right:false,proof:'source-ending-continuation'});
    }
    const drawVolta=(seg)=>{
      if(!(seg.start>=0&&seg.end>seg.start&&seg.end<xAnchors.length)||
        !/^[1-9][0-9]*(?:,[1-9][0-9]*)?$/.test(seg.number)){
        voltaAmbiguous++;return;
      }
      const x1=xAnchors[seg.start],x2=xAnchors[seg.end],
        y=Math.max(2,topY-topGap*5.0),down=topGap*2.25,
        width=Math.max(.9,lineWidth*.83);
      if(x2-x1<topGap*2){voltaAmbiguous++;return;}
      const group=document.createElementNS(ns,'g');
      group.classList.add('pl-source-volta');
      for(const [key,val] of Object.entries({sourceVoltaNumber:seg.number,
        sourceVoltaStart:String(Number(latest.first)+seg.start),
        sourceVoltaEnd:String(Number(latest.first)+seg.end),
        sourceVoltaProof:seg.proof}))group.dataset[key]=val;
      const stroke=(ax,ay,bx,by)=>{
        const line=document.createElementNS(ns,'line');
        for(const [name,val] of Object.entries({x1:ax,y1:ay,x2:bx,y2:by}))
          line.setAttribute(name,String(val));
        line.setAttribute('stroke','#101010');line.setAttribute('stroke-width',String(width));
        line.setAttribute('vector-effect','non-scaling-stroke');
        group.appendChild(line);
      };
      stroke(x1,y,x2,y);
      if(seg.left){
        stroke(x1,y,x1,y+down);
        const label=document.createElementNS(ns,'text');
        label.classList.add('pl-source-volta-label');
        label.setAttribute('x',String(x1+topGap*.40));
        label.setAttribute('y',String(y+topGap*1.14));
        label.setAttribute('font-size',String(topGap*1.22));
        label.setAttribute('font-family','serif');
        label.setAttribute('fill','#101010');
        label.textContent=seg.number+'.';
        group.appendChild(label);
      }
      if(seg.right)stroke(x2,y,x2,y+down);
      staffRules.appendChild(group);
    };
    for(const segment of voltaSegments)drawVolta(segment);
    // Hide native bracket only after a complete, validated replacement plan.
    // Any malformed entry remains visible and flagged for source review.
    if(voltaSegments.length && !voltaAmbiguous){
      for(const old of $(svg,'g.ending'))old.style.visibility='hidden';
    }
    for(const target of [staffRules,svg]){
      target.dataset.sourceVoltaSegments=String(staffRules.querySelectorAll('g.pl-source-volta').length);
      target.dataset.sourceVoltaAmbiguous=String(voltaAmbiguous);
      target.dataset.sourceVoltaScanOverrides=String(voltaScanOverrides);
      target.dataset.sourceVoltaSourceRecords=String(voltaRecords.length);
    }
    // SOURCE-INDEPENDENT TEXT: a common coordinate path for non-note tempo
    // instructions that MusicXML stores outside ordinary <direction> events.
    // Volta text can live in <ending> content, and page-layout credit text can
    // live in <credit-words> in the full score but be absent from its excerpt.
    // Both must be attached to FINAL measure/staff rules, never to stale
    // Verovio pre-reflow coordinates. Genuine <direction><words> text is
    // already handled in reflowSourceTimedIndependentDirections and must NOT
    // be drawn a second time here.
    let anchoredTextDrawn=0,anchoredTextAmbiguous=0;
    const anchoredText=[];
    const sourceWords=measures.flatMap(measure=>directChildren(measure,'direction')
      .flatMap(dir=>directChildren(dir,'direction-type')
        .flatMap(dt=>directChildren(dt,'words').map(w=>(w.textContent||'').trim()))));
    // The first-ending label is unusually embedded as TEXT of the MusicXML
    // <ending> rather than a <direction>. Do not turn the entire ending string
    // into a numeric volta label; preserve both distinct objects.
    for(const record of voltaRecords){
      if(record.type!=='start'||record.location!=='left')continue;
      const bar=allBarlines(measures[record.index]).find(b=>locationOf(b)==='left');
      const ending=bar&&directChildren(bar,'ending').find(e=>
        e.getAttribute('number')===record.number&&e.getAttribute('type')==='start');
      const label=(ending?.textContent||'').replace(/\s+/g,' ').trim();
      if(!label||!/^(?:Straight|Swing) 8ths$/i.test(label)||sourceWords.includes(label))continue;
      const segment=voltaSegments.find(v=>v.number===record.number&&v.start===record.index&&v.left);
      if(!segment){anchoredTextAmbiguous++;continue;}
      anchoredText.push({text:label,index:record.index,fraction:0,offset:2.35,
        origin:'musicxml-ending-text',proof:'source-ending:'+record.measure});
    }
    // A <credit-words> instruction in the FULL SOURCE is not included in
    // an excerpt's MusicXML at all. The original Silver Bells s06 scan places
    // the credit above late m29 just before the repeat. Use a provenance-
    // guarded semantic anchor; both its x and y remain measure/staff-relative.
    // This is NOT an inferred generic page-credit-to-measure mapping.
    if(latest.pieceSlug==='silver-bells'&&Number(latest.first)===26&&
      measures.map(m=>m.getAttribute('number')).join(',')==='26,27,28,29'&&
      repeatType(allBarlines(measures[3]).find(b=>locationOf(b)==='left'))==='forward'&&
      !sourceWords.includes('Swing 8ths')){
      anchoredText.push({text:'Swing 8ths',index:2,fraction:.59,offset:0,
        origin:'verified-full-source-credit',proof:'scan-s06-credit-words'});
    }
    // A scan may contain a musical instruction omitted from both the full
    // MusicXML and its system excerpt. Keep those *verified exceptions* in a
    // source-signature-bound catalog, and render with the same measure/staff
    // coordinate mapper as source-backed independent text. No arbitrary SVG
    // coordinates or blind OCR guesses are accepted here. An unverified scan
    // does not license recovery, and new ordinary MusicXML directions suppress
    // the corresponding supplemental marking to avoid doubling it.
    const scanSupplementalDirections=[
      {piece:'white-christmas',first:0,measureSignature:'0,1,2,3,4',
        xmlMeasure:3,text:'rit.',fraction:.55,placement:'interstaff',
        origin:'verified-scan-absent-musicxml',proof:'s01-jpg-m4-beat3',fontStyle:'italic',sizeFactor:2.05},
      {piece:'silver-bells',first:64,measureSignature:'64,65,66,67',
        xmlMeasure:66,text:'Swing 8ths',fraction:.66,placement:'above-staff',
        origin:'verified-scan-absent-musicxml',proof:'s14-jpg-m67-last-two-eighths',
        aboveStaffSpaces:2.6,sizeFactor:1.85},
      {piece:'the-most-wonderful-time-of-the-year',first:40,measureSignature:'41,42,43,44',
        xmlMeasure:43,text:'cresc.',fraction:.043,placement:'interstaff',
        origin:'verified-scan-absent-musicxml',proof:'s11-jpg-m43-under-rh',
        fontStyle:'italic',sizeFactor:2.05}
    ];
    const currentSignature=measures.map(m=>m.getAttribute('number')).join(',');
    for(const item of scanSupplementalDirections){
      if(item.piece!==latest.pieceSlug || item.first!==Number(latest.first) ||
         item.measureSignature!==currentSignature)continue;
      if(sourceWords.includes(item.text))continue;
      const index=measures.findIndex(m=>Number(m.getAttribute('number'))===item.xmlMeasure);
      if(index<0){anchoredTextAmbiguous++;continue;}
      anchoredText.push({...item,index,offset:0});
    }
    const tempoTextY=topY-topGap*7.0;
    for(const item of anchoredText){
      if(!(item.index>=0&&item.index<measures.length)||
        !(item.fraction>=0&&item.fraction<=1)||!item.text){
        anchoredTextAmbiguous++;continue;
      }
      const x=xAnchors[item.index]+(xAnchors[item.index+1]-xAnchors[item.index])*item.fraction+
        topGap*item.offset;
      if(!(x>=xAnchors[item.index]&&x<xAnchors[item.index+1])){
        anchoredTextAmbiguous++;continue;
      }
      // Only the independently emitted SVG text is new: never transform
      // or remove notes, the numeric bracket label, or native g.dir text.
      const element=document.createElementNS(ns,'text');
      element.classList.add('pl-source-independent-text');
      element.setAttribute('x',String(x));
      const sourceTextY=item.placement==='interstaff'
        ? Math.min(bottomY-lowerGap*4.7,topY+topGap*9.2)
        :item.placement==='above-staff'?topY-topGap*item.aboveStaffSpaces:tempoTextY;
      element.setAttribute('y',String(sourceTextY));
      element.setAttribute('font-family','serif');
      if(item.fontStyle)element.setAttribute('font-style',item.fontStyle);
      else element.setAttribute('font-weight','bold');
      element.setAttribute('font-size',String(topGap*(item.sizeFactor||1.85)));
      element.setAttribute('fill','#101010');
      element.textContent=item.text;
      element.dataset.sourceTextOrigin=item.origin;
      element.dataset.sourceTextProof=item.proof;
      element.dataset.sourceTextMeasure=String(Number(latest.first)+item.index);
      staffRules.appendChild(element);
      anchoredTextDrawn++;
    }
    for(const target of [staffRules,svg]){
      target.dataset.sourceIndependentTexts=String(anchoredTextDrawn);
      target.dataset.sourceIndependentTextAmbiguous=String(anchoredTextAmbiguous);
      target.dataset.sourceNativeWords=String(sourceWords.length);
    }
    // CROSS-SYSTEM COURTESY METER: The current *excerpt* may end without a
    // native trailing time signature, even though the next excerpt changes
    // meter and the authoritative scan prints a warning 3/4 after the double
    // barline. The source-verification list records the CURRENT and FOLLOWING
    // MusicXML times and is separately guarded against those immutable files.
    // The geometry below is shared: scan-calibrated x bar + staff-relative y,
    // real Verovio SMuFL contours (E083 / E084), no per-piece pixel guesses.
    // Nothing is generated for an unverified scan, even if a meter changes.
    const verifiedCrossSystemCourtesy={
      'rudolph-the-red-nosed-reindeer:94:97':{before:'4/4',after:'3/4'},
      'we-wish-you-the-merriest:53:55':{before:'4/4',after:'3/4'}
    };
    const courtesyKey=`${latest.pieceSlug}:${Number(latest.first)}:${Number(latest.last)}`;
    const crossSystemCourtesy=verifiedCrossSystemCourtesy[courtesyKey];
    let courtesyCount=0,courtesyRejection='';
    if(crossSystemCourtesy){
      const explicit=[];
      for(const m of measures)for(const a of directChildren(m,'attributes'))
        for(const t of directChildren(a,'time')){
          const beats=localContent(t,'beats'),beatType=localContent(t,'beat-type');
          if(beats&&beatType)explicit.push(`${beats}/${beatType}`);
        }
      const lastTime=explicit.at(-1);
      const last=measures.at(-1),children=[...last.children];
      const finalSounding=Math.max(-1,...children.map((n,i)=>
        ['note','backup','forward'].includes(n.localName)?i:-1));
      const trailingTime=children.some((n,i)=>n.localName==='attributes'&&
        i>finalSounding&&directChildren(n,'time').length);
      const bar=xAnchors.at(-1),edge=reference.right-pane.left;
      const requiredWidth=topGap*3.7;
      if(lastTime!==crossSystemCourtesy.before || trailingTime){
        courtesyRejection='unexpected-current-source-meter';
      }else if(crossSystemCourtesy.after!=='3/4'){
        courtesyRejection='unsupported-next-meter';
      }else if(!(edge-bar>requiredWidth&&bottomY>topY+topGap*5)){
        courtesyRejection='insufficient-scanned-warning-space';
      }else{
        // These outlines are the same Noto Music SMuFL numeral contours
        // provided by Verovio (timeSig3 U+E083, timeSig4 U+E084), captured
        // from its rendering of the verified following 3/4 excerpt.
        const digitPaths={'3':"M208 250c97 0 177 -52 177 -116c0 -69 -40 -111 -118 -125c56 -5 125 -44 125 -116c0 -31 -10 -57 -31 -78c-19 -21 -45 -38 -78 -49l-50 -11c-15 -3 -36 -7 -55 -7c-50 0 -86 16 -113 38c-16 10 -23 18 -34 34c-7 13 -11 25 -11 38c0 43 27 83 68 83l3 -2 c61 0 75 -42 75 -70c0 -19 -24 -42 -26 -57c7 -17 20 -25 37 -25c44 0 94 29 94 78c0 75 -34 125 -138 125v36c84 0 131 22 131 98c0 54 -37 88 -87 88c-26 0 -43 -7 -51 -22c15 -22 44 -16 44 -70c0 -37 -37 -62 -71 -62c-22 0 -69 15 -69 76c0 79 101 116 178 116z",'4':"M20 -78c84 97 114 180 134 329h170c-13 -32 -82 -132 -99 -151l-84 -97c-33 -36 -59 -63 -80 -81h162v102l127 123v-225h57v-39h-57v-34c0 -43 19 -65 57 -65v-34h-244v36c48 0 60 26 60 70v27h-203v39z"};
        const targetEnd=Math.min(edge-topGap*.08,bar+topGap*4.8);
        for(let i=0;i<5;i++){
          const y1=topY+i*topGap,y2=bottomY+i*lowerGap;
          createLine(bar,y1,targetEnd,y1,lineWidth).classList.add('pl-cross-system-courtesy-extension');
          createLine(bar,y2,targetEnd,y2,lineWidth).classList.add('pl-cross-system-courtesy-extension');
        }
        const group=document.createElementNS(ns,'g');
        group.classList.add('pl-source-cross-system-courtesy');
        group.dataset.sourceCourtesyBefore=crossSystemCourtesy.before;
        group.dataset.sourceCourtesyAfter=crossSystemCourtesy.after;
        group.dataset.sourceCourtesyProof='next-excerpt-and-scan';
        group.dataset.sourceCourtesyBar=String(Number(latest.last));
        const x=bar+topGap*.82;
        for(const [index,staffTop,staffGap] of [[1,topY,topGap],[2,bottomY,lowerGap]]){
          for(const [digit,row] of [['3',1],['4',3]]){
            const t=document.createElementNS(ns,'g');
            const scale=staffGap*(((latest.pieceSlug==='rudolph-the-red-nosed-reindeer'&&Number(latest.first)===94)||(latest.pieceSlug==='we-wish-you-the-merriest'&&Number(latest.first)===53))?2:1.5)/500;
            // SMuFL numeral contours are about 500 units tall. Center each
            // in its own pair of staff spaces, preserving music-font shape.
            t.setAttribute('transform',`translate(${x} ${staffTop+row*staffGap}) scale(${scale})`);
            const path=document.createElementNS(ns,'path');
            path.setAttribute('d',digitPaths[digit]);
            path.setAttribute('transform','scale(1,-1)');
            path.setAttribute('fill','#101010');
            t.appendChild(path);t.dataset.courtesyDigit=digit;
            t.dataset.courtesyStaff=String(index);
            group.appendChild(t);
          }
        }
        staffRules.appendChild(group);
        courtesyCount=2;
      }
    }
    for(const target of [staffRules,svg]){
      target.dataset.sourceCrossSystemCourtesyStaves=String(courtesyCount);
      target.dataset.sourceCrossSystemCourtesyReason=courtesyRejection;
    }
    staffRules.dataset.sourceRepeatBoundaries=String(repeatBoundaries);
    staffRules.dataset.sourceRepeatDots=String(repeatDots);
    staffRules.dataset.sourceRepeatAmbiguous=String(repeatAmbiguous);
    svg.dataset.sourceRepeatBoundaries=String(repeatBoundaries);
    svg.dataset.sourceRepeatDots=String(repeatDots);
    svg.dataset.sourceRepeatAmbiguous=String(repeatAmbiguous);
    // Hide only staff ruling shapes and Verovio's original barline groups.
    // This deliberately leaves all musical symbols, selection and event IDs in
    // Verovio's SVG rather than reconstructing music from a raster overlay.
    for (const el of geometry.lines) el.style.visibility='hidden';
    for (const el of $(notation,'g.barLine')) el.style.visibility='hidden';
    // Verovio draws an additional system-opening connection path as a direct
    // child of g.system. Our scan-aligned left barline replaces that path.
    for (const line of $(svg,'g.system > path')) line.style.visibility='hidden';
    // Ledger strokes belong to the *new* notehead coordinates, not the old
    // staff-relative coordinates created by Verovio before our x reflow.
    const ledger=reconstructLedgerLines(svg,geometry,pane,lineWidth);
    context.lastLedgerReport=`${ledger.lines} ledger rules (${ledger.notes} notes; ${ledger.hidden} old groups hidden)`;
    return true;
  }

  // Some legitimate MusicXML records have no default-x (notably the opening
  // tied chord at measure 25). A missing coordinate is *not* x=0. Derive its
  // horizontal position only from other printed events with the exact same
  // rhythmic onset in the same measure, typically the opposite staff.
  // Do not invent coordinates when no matching engraved event exists.
  return {reshapeLine,staffLineShapes,staffLineBox,matchVerticalStaffDistance,captureRuleGeometry,reconstructLedgerLines,layOutRulesFromScan};
}};
